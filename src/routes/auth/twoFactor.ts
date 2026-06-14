import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { totpService } from '../../services/TOTPService';
import { AuthService } from '../../services/AuthService';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { db } from '../../db/index';
import { AuthError } from '../../utils/errors';
import logger from '../../utils/logger';
import { generateCsrfToken, attachCsrfToken } from '../../middleware/csrf';
import { hashRefreshToken } from '../../services/refreshTokenHash';
import { getRefreshCookiePath } from '../../services/refreshCookiePath';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const verifySchema = z.object({
  token: z.string().length(6, 'TOTP code must be exactly 6 digits').regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
});

const validateSchema = z.object({
  tempToken: z.string().min(1, 'Temp token is required'),
  token: z.string().length(6, 'TOTP code must be exactly 6 digits').regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
});

const backupSchema = z.object({
  tempToken: z.string().min(1, 'Temp token is required'),
  code: z.string().min(1, 'Backup code is required'),
});

const disableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

// ─── Helper: Verify temp token ───────────────────────────────────────────────

function verifyTempToken(tempToken: string, jwtPublicKey: string): { userId: string; username: string } {
  try {
    const decoded = jwt.verify(tempToken, jwtPublicKey, { algorithms: ['RS256'] }) as any;
    if (decoded.type !== '2fa_pending') {
      throw new AuthError('Invalid token type');
    }
    return { userId: decoded.id, username: decoded.username };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('Invalid or expired temp token');
  }
}

// ─── Helper: Issue full tokens (mirrors login flow) ──────────────────────────

async function issueFullTokens(userId: string, jwtPrivateKey: string, req: any, res: any) {
  const user = await db.prepare(
    'SELECT id, username, role, name, email, session_version FROM users WHERE id = ?'
  ).get(userId) as any;

  if (!user) {
    throw new AuthError('User not found');
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
    jwtPrivateKey,
    { algorithm: 'RS256', expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, session_version: user.session_version, rememberMe: false },
    jwtPrivateKey,
    { algorithm: 'RS256', expiresIn: '8h' }
  );

  // Store refresh token (hash only at rest — Req 17.1, 17.5). Compute the hash before
  // persistence so a hashing failure aborts the insert without storing plaintext.
  const refreshExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours
  const refreshTokenHash = hashRefreshToken(refreshToken);
  await db.prepare(
    'INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?::text, ?::uuid, ?::timestamp)'
  ).run(refreshTokenHash, userId, refreshExpiry.toISOString());

  // Record a session row mirroring the normal login path (Req 2.15) so the 2FA-completed login
  // produces a listable/terminable session. Only the refresh-token hash is stored at rest.
  const sessionToken = crypto.randomBytes(64).toString('hex');
  try {
    await db.prepare(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, ip_address, browser, status)
      VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Active')
    `).run(
      userId,
      sessionToken,
      refreshTokenHash,
      (req && req.ip) || 'Unknown',
      (req && typeof req.get === 'function' && req.get('user-agent')) || 'Unknown'
    );
  } catch (e) {
    logger.error(`[2FA] Failed to create user session for user ${userId}: ${e}`);
  }

  // Set cookies (same pattern as login)
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieOptions: any = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };

  res.cookie('token', token, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000, // 15 minutes
  });

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: getRefreshCookiePath(),
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });

  // Generate and attach CSRF token
  const csrfToken = generateCsrfToken();
  attachCsrfToken(res, csrfToken);

  await AuthService.logAudit(user.username, '2FA Login', 'Authentication', 'User completed 2FA verification');

  return { token, refreshToken, user: { id: user.id, username: user.username, role: user.role, name: user.name } };
}

// ─── Route Factory ───────────────────────────────────────────────────────────

export const createTwoFactorRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authenticate: any,
  logError: any
) => {
  const router = express.Router();

  // We need the public key for verifying temp tokens
  // The authenticate middleware uses JWT_PUBLIC_KEY internally, but we need it here too
  // JWT_SECRET is actually the public key passed from the auth routes index
  const JWT_PUBLIC_KEY = JWT_SECRET;

  // ─── POST /2fa/setup ─────────────────────────────────────────────────────
  // Requires authentication. Generates TOTP secret, QR code, and backup codes.
  router.post('/2fa/setup', authenticate, asyncHandler(async (req: any, res) => {
    const userId = req.user.id;

    const result = await totpService.setup(userId);

    res.json({
      secret: result.secret,
      qrCodeDataUrl: result.qrCodeDataUrl,
      backupCodes: result.backupCodes,
    });
  }));

  // ─── POST /2fa/verify ────────────────────────────────────────────────────
  // Requires authentication. Confirms 2FA setup by verifying the first TOTP code.
  // On success, enables 2FA (is_enabled = true, enabled_at = NOW()).
  router.post('/2fa/verify', authenticate, validateBody(verifySchema), asyncHandler(async (req: any, res) => {
    const userId = req.user.id;
    const { token } = req.body;

    const isValid = await totpService.verify(userId, token);

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid TOTP code' });
    }

    // Enable 2FA
    await db.prepare(
      'UPDATE user_totp SET is_enabled = TRUE, enabled_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(userId);

    logger.info(`[2FA] 2FA enabled for user ${userId}`);
    await AuthService.logAudit(req.user.username, '2FA Enabled', 'Security', 'User enabled two-factor authentication');

    res.json({ success: true });
  }));

  // ─── POST /2fa/validate ──────────────────────────────────────────────────
  // Does NOT require full auth. Uses tempToken (short-lived JWT with type='2fa_pending').
  // Validates TOTP during login flow and issues full access/refresh tokens.
  router.post('/2fa/validate', validateBody(validateSchema), asyncHandler(async (req: any, res) => {
    const { tempToken, token } = req.body;

    // Verify the temp token
    const { userId } = verifyTempToken(tempToken, JWT_PUBLIC_KEY);

    // Verify TOTP code
    const isValid = await totpService.verify(userId, token);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid TOTP code' });
    }

    // Issue full tokens
    const result = await issueFullTokens(userId, JWT_PRIVATE_KEY, req, res);

    res.json({ user: result.user, token: result.token });
  }));

  // ─── POST /2fa/backup ────────────────────────────────────────────────────
  // Does NOT require full auth. Uses tempToken.
  // Accepts a backup code as alternative to TOTP during login.
  router.post('/2fa/backup', validateBody(backupSchema), asyncHandler(async (req: any, res) => {
    const { tempToken, code } = req.body;

    // Verify the temp token
    const { userId } = verifyTempToken(tempToken, JWT_PUBLIC_KEY);

    // Verify backup code
    const isValid = await totpService.useBackupCode(userId, code);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid backup code' });
    }

    // Issue full tokens
    const result = await issueFullTokens(userId, JWT_PRIVATE_KEY, req, res);

    res.json({ user: result.user, token: result.token });
  }));

  // ─── DELETE /2fa ─────────────────────────────────────────────────────────
  // Requires authentication. Disables 2FA after password confirmation.
  router.delete('/2fa', authenticate, validateBody(disableSchema), asyncHandler(async (req: any, res) => {
    const userId = req.user.id;
    const { password } = req.body;

    try {
      await totpService.disable(userId, password);
    } catch (err: any) {
      if (err.statusCode === 401) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
      throw err;
    }

    await AuthService.logAudit(req.user.username, '2FA Disabled', 'Security', 'User disabled two-factor authentication');

    res.json({ success: true });
  }));

  return router;
};

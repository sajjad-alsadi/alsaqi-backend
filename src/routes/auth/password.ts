import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { PasswordService } from '../../services/PasswordService';
import { AuthService } from '../../services/AuthService';
import { asyncHandler } from '../../utils/asyncHandler';
import { ValidationError } from '../../utils/errors';
import { DEFAULT_PASSWORD_MIN_LENGTH } from '../../services/passwordPolicy';
import { getRefreshCookiePath } from '../../services/refreshCookiePath';

/**
 * Builds environment-aware auth cookie options.
 *
 * In production we need `sameSite: 'none'` + `secure: true` to support cross-origin
 * deployments; the browser silently DROPS such a cookie over plain HTTP (dev/localhost),
 * which previously logged developers out. In non-production we therefore fall back to
 * `sameSite: 'lax'` + `secure: false` so the cookie is accepted over HTTP. Mirrors the
 * pattern already used in `session.ts` (finding 1.39).
 */
const buildAuthCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
    path: '/'
  };
};

const forgotPasswordSchema = z.object({
  usernameOrEmail: z.string().min(1)
});

const approveResetSchema = z.object({
  requestId: z.string().min(1)
});

const rejectResetSchema = z.object({
  requestId: z.string().uuid()
});

const changePasswordSchema = z.object({
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100)
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100)
});

/**
 * Dedicated rate limiter for the forgot-password endpoint.
 * Stricter than the general authLimiter: max 3 requests per 15-minute window per IP.
 * Using a module-level instance so it maintains state across requests.
 */
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'no-ip'),
  handler: (_req, res) => {
    res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  },
});

export const createPasswordRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authLimiter: any,
  authenticate: any,
  checkPermission: any,
  createNotification: any,
  logError: any,
  forgotPwLimiter: any = forgotPasswordLimiter,
) => {
  const router = express.Router();

  // Forgot Password
  router.post("/forgot-password", forgotPwLimiter, asyncHandler(async (req, res) => {
    const validation = forgotPasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid username", validation.error.format());
    }
    const { usernameOrEmail } = validation.data;
    const result = await PasswordService.requestReset(usernameOrEmail);
    
    if (result.user && result.adminIds) {
      for (const adminId of result.adminIds) {
        await createNotification(adminId, 'password_reset_request', result.alertMsg, 'Security', '/users', { actorId: result.user.id, wss: (req.app as any).wss });
      }
      await AuthService.logAudit(result.user.username, "Password Reset Request", "Security", "User requested password reset");
    }

    res.json({ success: true });
  }));

  // Check Reset Status
  router.get("/reset-status/:username", authLimiter, asyncHandler(async (req, res) => {
    const username = req.params.username as string;
    const status = await PasswordService.getResetStatus(username);
    res.json({ status });
  }));

  // Admin: Get Reset Requests
  router.get("/reset-requests", authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const data = await PasswordService.getResetRequests();
    res.json(data);
  }));

  // Admin: Approve Reset Request
  router.post("/approve-reset", authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const validation = approveResetSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid request ID", validation.error.format());
    }
    const { requestId } = validation.data;
    const adminId = (req as any).user.id;
    const result = await PasswordService.approveReset(requestId, adminId);

    await AuthService.logAudit((req as any).user.username, "Admin Password Reset", "Security", `Admin reset password for user: ${result.username}. Request ID: ${requestId}`);

    res.json({ success: true, tempPassword: result.tempPassword });
  }));

  // Admin: Reject Reset Request
  router.post("/reject-reset", authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const validation = rejectResetSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid request ID", validation.error.format());
    }
    const { requestId } = validation.data;
    const adminId = (req as any).user.id;
    await PasswordService.rejectReset(requestId, adminId);

    res.json({ success: true });
  }));

  // User: Change Password (Mandatory or Voluntary)
  router.post("/change-password", authLimiter, authenticate, asyncHandler(async (req, res) => {
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid password data", validation.error.format());
    }
    const { newPassword } = validation.data;
    const userId = (req as any).user.id;
    
    const user = await PasswordService.changePassword(userId, newPassword);
    
    await AuthService.logAudit(user.username, "Change Password", "Security", "User changed their password");
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
      JWT_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '15m' }
    );

    const cookieOptions = buildAuthCookieOptions();
    // Issue a fresh access token cookie with env-aware flags.
    res.cookie('token', token, cookieOptions);
    // Rotate/clear the stale refresh cookie: changePassword bumps session_version and
    // revokes outstanding refresh tokens server-side, so the browser's old refreshToken
    // is now dead. Clear it (matching the configured refresh path) to keep client and
    // server state consistent and force a clean re-auth when the access token expires.
    res.clearCookie('refreshToken', { ...cookieOptions, path: getRefreshCookiePath() });
    res.json({ success: true, token });
  }));

  // User: Update Password
  router.post("/update-password", authLimiter, authenticate, asyncHandler(async (req, res) => {
    const validation = updatePasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid password data", validation.error.format());
    }
    const { currentPassword, newPassword } = validation.data;
    const userId = (req as any).user.id;
    
    const user = await PasswordService.updatePassword(userId, currentPassword, newPassword);
    
    await AuthService.logAudit(user.username, "Change Password", "Settings", "User changed their password");
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
      JWT_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '15m' }
    );

    const cookieOptions = buildAuthCookieOptions();
    res.cookie('token', token, cookieOptions);
    // See change-password: updatePassword also revokes outstanding refresh tokens, so the
    // browser's old refreshToken cookie is stale and is cleared here.
    res.clearCookie('refreshToken', { ...cookieOptions, path: getRefreshCookiePath() });
    res.json({ success: true, token });
  }));

  return router;
};

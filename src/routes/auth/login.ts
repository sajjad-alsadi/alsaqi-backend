import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthService } from '../../services/AuthService';
import { totpService } from '../../services/TOTPService';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateSchema } from '../../middleware/validate';
import { generateCsrfToken, attachCsrfToken } from '../../middleware/csrf';
import { getRefreshCookiePath } from '../../services/refreshCookiePath';

const loginSchema = z.object({
  usernameOrEmail: z.string().min(1, "Username or Email is required").max(100),
  password: z.string().min(1, "Password is required").max(100),
  rememberMe: z.boolean().optional(),
});

export const createLoginRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authLimiter: any,
  logError: any
) => {
  const router = express.Router();

  router.post("/login", authLimiter, validateSchema(loginSchema), asyncHandler(async (req, res) => {
    const { usernameOrEmail, password, rememberMe } = req.body; 

    const result = await AuthService.login(usernameOrEmail, password, JWT_SECRET, JWT_PRIVATE_KEY, req.ip, req.get('user-agent'), rememberMe);

    // Check if user has 2FA enabled — if so, return a short-lived temp token
    // instead of full access tokens
    if (await totpService.isEnabled(result.user.id)) {
      const tempToken = jwt.sign(
        { id: result.user.id, username: result.user.username, type: '2fa_pending' },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '5m' }
      );
      return res.json({ requires2FA: true, tempToken });
    }

    // Forced 2FA enrollment (Req 2.13): when the account must set up 2FA (its own
    // requires_2fa_setup flag or the global two_factor_auth policy) but has not yet enrolled,
    // do NOT grant full access. Return a short-lived setup token so the client can complete
    // enrollment before any access/refresh tokens are issued.
    if (result.user.requires_2fa_setup) {
      const tempToken = jwt.sign(
        { id: result.user.id, username: result.user.username, type: '2fa_setup_pending' },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '10m' }
      );
      return res.json({ requires2FASetup: true, tempToken });
    }

    // Normal login flow (no 2FA) — issue full tokens
    // In production: sameSite: 'none' + secure: true (supports cross-origin/iframe)
    // In development: sameSite: 'lax' + secure: false (works on HTTP localhost)
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions: any = { 
      httpOnly: true, 
      secure: isProduction, 
      sameSite: 'lax', 
      path: '/api' 
    };

    res.cookie('token', result.token, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000 // 15 minutes
    });
    
    // Refresh Token: Cookie-Only Storage
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: isProduction, 
      sameSite: 'lax', 
      path: getRefreshCookiePath(), // Restrict cookie to the configured refresh endpoint path (Req 19.1)
      maxAge: rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000 // 30 days or 8 hours in ms
    });

    await AuthService.logAudit(result.user.username, "Login", "Authentication", "User logged in");

    // Generate and attach CSRF token on successful login
    const csrfToken = generateCsrfToken();
    attachCsrfToken(res, csrfToken);

    // Return user info only — token is delivered via httpOnly cookie
    res.json({ user: result.user });
  }));

  return router;
};

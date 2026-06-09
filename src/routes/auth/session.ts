import express from 'express';
import rateLimit from 'express-rate-limit';
import { SessionService } from '../../services/SessionService';
import { AuthService } from '../../services/AuthService';
import { asyncHandler } from '../../utils/asyncHandler';
import { AuthError } from '../../utils/errors';
import { generateCsrfToken, attachCsrfToken } from '../../middleware/csrf';

export const createSessionRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authenticate: any,
  logError: any
) => {
  const router = express.Router();

  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: "TOO_MANY_ATTEMPTS" },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Current User
  router.get("/me", authenticate, asyncHandler(async (req, res) => {
    const user = (req as any).user;
    
    // Fetch permissions from DB for the current user
    let permissions: Array<{ module: string; action: string }> = [];
    try {
      permissions = await db.prepare(`
        SELECT p.module, p.action FROM permissions p
        JOIN role_permissions rp ON p.id = rp.permission_id
        WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?)
        UNION
        SELECT p.module, p.action FROM permissions p
        JOIN user_permissions up ON p.id = up.permission_id
        WHERE up.user_id = ? AND up.is_allowed = 1
      `).all(user.id, user.id) as Array<{ module: string; action: string }>;
    } catch (e) {
      console.error("[Session] Failed to fetch permissions:", e);
    }

    res.json({ user: { ...user, permissions } });
  }));

  // Refresh Token
  router.post("/refresh", refreshLimiter, asyncHandler(async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    
    if (!refreshToken) {
      // If no refresh token is present, just return 401 without throwing (to avoid noisy logs)
      return res.status(401).json({ 
        success: false, 
        error: { code: 'UNAUTHORIZED', message: "No refresh token" } 
      });
    }

    try {
      const result = await SessionService.refresh(refreshToken, JWT_SECRET, JWT_PRIVATE_KEY);

      // In production: sameSite: 'none' + secure: true (supports cross-origin/iframe)
      // In development: sameSite: 'lax' + secure: false (works on HTTP localhost)
      const isProduction = process.env.NODE_ENV === 'production';
      const cookieOptions: any = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/'
      };

      // Refresh Token: Cookie-Only Storage
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/api/auth/refresh', // Restrict cookie path
        maxAge: result.rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000 // 30 days or 8 hours in ms
      });

      res.cookie('token', result.token, {
        ...cookieOptions,
        maxAge: 15 * 60 * 1000 // 15 minutes
      });

      await AuthService.logAudit(result.user.username, "Refresh Token", "Auth", "Token refreshed successfully");

      // Generate and attach CSRF token on successful refresh
      const csrfToken = generateCsrfToken();
      attachCsrfToken(res, csrfToken);

      res.json({ success: true });
    } catch (error) {
      // Clear cookies with same options
      const isProduction = process.env.NODE_ENV === 'production';
      const clearOptions: any = { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/' };
      const refreshClearOptions: any = { ...clearOptions, path: '/api/auth/refresh' };
      res.clearCookie('refreshToken', refreshClearOptions);
      res.clearCookie('token', clearOptions);
      throw error;
    }
  }));

  // Logout
  router.post("/logout", asyncHandler(async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    const username = await SessionService.logout(refreshToken);
    
    if (username) {
      await AuthService.logAudit(username, "Logout", "Auth", "User logged out");
    }

    // Clear cookies with same options
    const isProduction = process.env.NODE_ENV === 'production';
    const clearOptions: any = { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/' };
    const refreshClearOptions: any = { ...clearOptions, path: '/api/auth/refresh' };
    res.clearCookie('refreshToken', refreshClearOptions);
    res.clearCookie('token', clearOptions);
    res.json({ success: true });
  }));

  // Logout All
  router.post("/logout-all", authenticate, asyncHandler(async (req, res) => {
    const userId = (req as any).user.id;
    await SessionService.logoutAll(userId);
    
    await AuthService.logAudit((req as any).user.username, "Logout All", "Settings", "User invalidated all active sessions");

    res.json({ success: true });
  }));

  // WebSocket Token - issues a short-lived token for WebSocket connections
  // Since the access token is in an httpOnly cookie (not accessible from JS),
  // the frontend calls this endpoint to get a token it can pass as a query parameter.
  router.get("/ws-token", authenticate, asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const jwt = await import('jsonwebtoken');
    const wsToken = jwt.default.sign(
      { id: user.id, username: user.username, type: 'ws' },
      JWT_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '30s' }
    );
    res.json({ token: wsToken });
  }));

  return router;
};

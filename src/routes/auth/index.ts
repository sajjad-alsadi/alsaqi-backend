import express from 'express';
import { createLoginRoutes } from './login';
import { createSessionRoutes } from './session';
import { createPasswordRoutes } from './password';
import { createTwoFactorRoutes } from './twoFactor';

export const createAuthRoutes = (
  db: any,
  // RS256 PUBLIC key used to VERIFY signed tokens (temp 2FA tokens, refresh tokens).
  // Must be the RSA public key, never the symmetric jwtSecret — an RS256 signature
  // cannot be verified with a symmetric secret.
  JWT_PUBLIC_KEY: string,
  JWT_PRIVATE_KEY: string,
  authLimiter: any,
  authenticate: any,
  checkPermission: any,
  createNotification: any,
  logError: any
) => {
  const router = express.Router();

  router.use(createLoginRoutes(db, JWT_PUBLIC_KEY, JWT_PRIVATE_KEY, authLimiter, logError));
  router.use(createSessionRoutes(db, JWT_PUBLIC_KEY, JWT_PRIVATE_KEY, authenticate, logError));
  router.use(createPasswordRoutes(db, JWT_PUBLIC_KEY, JWT_PRIVATE_KEY, authLimiter, authenticate, checkPermission, createNotification, logError));
  router.use(createTwoFactorRoutes(db, JWT_PUBLIC_KEY, JWT_PRIVATE_KEY, authLimiter, authenticate, logError));

  return router;
};

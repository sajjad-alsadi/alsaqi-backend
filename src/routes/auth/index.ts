import express from 'express';
import { createLoginRoutes } from './login';
import { createSessionRoutes } from './session';
import { createPasswordRoutes } from './password';
import { createTwoFactorRoutes } from './twoFactor';

export const createAuthRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authLimiter: any,
  authenticate: any,
  checkPermission: any,
  createNotification: any,
  logError: any
) => {
  const router = express.Router();

  router.use(createLoginRoutes(db, JWT_SECRET, JWT_PRIVATE_KEY, authLimiter, logError));
  router.use(createSessionRoutes(db, JWT_SECRET, JWT_PRIVATE_KEY, authenticate, logError));
  router.use(createPasswordRoutes(db, JWT_SECRET, JWT_PRIVATE_KEY, authLimiter, authenticate, checkPermission, createNotification, logError));
  router.use(createTwoFactorRoutes(db, JWT_SECRET, JWT_PRIVATE_KEY, authenticate, logError));

  return router;
};

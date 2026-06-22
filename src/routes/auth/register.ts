import express from 'express';
import { RegisterSchema } from '@alsaqi/shared';
import { UserService } from '../../services/UserService';
import { AuthService } from '../../services/AuthService';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { createSuccessResponse } from '../../utils/responseEnvelope.js';

/**
 * Admin-guarded user registration route.
 *
 * `POST /auth/register` is NOT public self-registration: it is an authenticated,
 * permission-checked admin action that creates a user account. It reuses the same
 * single user-creation path as `POST /users` (UserService.createUser) so there is
 * no duplicate creation logic, and it records the same kind of audit log entry.
 */
export const createRegisterRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.post(
    '/register',
    authenticate,                                  // 401 for unauthenticated requests
    checkPermission('UserManagement', 'Create'),   // 403 for unauthorized requests
    validateBody(RegisterSchema),                  // 400 on validation failure
    asyncHandler(async (req, res) => {
      // Single source of truth for user creation — same path as POST /users.
      // UserService.createUser raises a clear conflict error for duplicate
      // username/email.
      const user = await UserService.createUser(req.body);

      await AuthService.logAudit(
        (req as any).user.username,
        'Created User',
        'User Management',
        `Registered user ${user.username} with role ${user.role}`
      );

      res.status(201).json(createSuccessResponse({ data: { user } }));
    })
  );

  return router;
};

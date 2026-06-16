import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { IDBWrapper } from '../db/index.js';
import { UserRole, ErrorCodes } from '@alsaqi/shared';
import { createErrorResponse } from '../utils/responseEnvelope.js';

/**
 * Middleware factory that prevents:
 * 1. A user from performing destructive actions on their own account
 * 2. Removal/deactivation of the last active admin
 *
 * Must be placed after `authenticate` in the middleware chain.
 */
export function lastAdminGuard(db: IDBWrapper) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const targetId = req.params.id;
    const currentUserId = req.user.id;

    // Self-action prohibition
    if (targetId === currentUserId) {
      return res.status(403).json(
        createErrorResponse({
          code: ErrorCodes.FORBIDDEN,
          message: 'Cannot perform this action on your own account',
        })
      );
    }

    // Last-admin guard
    const targetUser = await db.prepare(
      "SELECT role FROM users WHERE id = ?"
    ).get<{ role: string }>(targetId);

    if (targetUser && targetUser.role === UserRole.ADMIN) {
      const result = await db.prepare(
        `SELECT COUNT(*) as count FROM users WHERE role = ? AND status = 'Active' AND id != ?`
      ).get<{ count: number }>(UserRole.ADMIN, targetId);

      if (!result || result.count === 0) {
        return res.status(403).json(
          createErrorResponse({
            code: ErrorCodes.FORBIDDEN,
            message: 'Cannot remove the last admin user',
          })
        );
      }
    }

    next();
  };
}

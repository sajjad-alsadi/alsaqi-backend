import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { backupScheduler } from '../utils/backup';
import { UserRole } from '@alsaqi/shared';
import logger from '../utils/logger';

/**
 * Creates admin-only backup management routes.
 * - POST /backup — triggers an immediate manual backup
 * - GET /backup/history — returns recent backup history
 */
export const createAdminBackupRoutes = (
  authenticate: any,
  checkPermission: any
) => {
  const router = express.Router();

  // All routes require authentication + Settings Edit permission
  router.use(authenticate);
  router.use(checkPermission('Settings', 'Edit'));

  /**
   * POST /api/admin/backup
   * Triggers an immediate manual backup and returns the result.
   */
  router.post('/backup', asyncHandler(async (req, res) => {
    try {
      const result = await backupScheduler.runNow();
      res.json(result);
    } catch (error: any) {
      logger.error('[ADMIN] Manual backup trigger failed:', error);
      res.status(500).json({
        error: 'Backup failed',
        message: error.message || 'An unexpected error occurred during backup',
      });
    }
  }));

  /**
   * GET /api/admin/backup/history
   * Returns recent backup history records.
   */
  router.get('/backup/history', asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const history = await backupScheduler.getHistory(limit);
    res.json(history);
  }));

  return router;
};

import { Router } from 'express';
import { AuthenticatedRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ArchiveService } from '../services/ArchiveService';
import { AuditPlanService } from '../services/AuditPlanService';
import { ValidationError } from '../utils/errors';
import { methodNotAllowed } from '../utils/routeRegistry';

export const createArchiveRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = Router();

  /**
   * POST /api/v1/audit-plans/:id/archive
   * Archives a plan and all its related data.
   * Requires Manager or Admin role.
   */
  router.post(
    '/audit-plans/:id/archive',
    authenticate,
    checkPermission('AuditPlans', 'Approve'),
    asyncHandler(async (req, res) => {
      const typedReq = req as unknown as AuthenticatedRequest;
      const id = String(req.params.id);
      const userId = typedReq.user.id;
      const userRole = typedReq.user.role;

      await ArchiveService.archivePlan(id, userId, userRole);

      res.json({
        success: true,
        message: 'تمت أرشفة الخطة بنجاح / Plan archived successfully',
      });
    })
  );

  /**
   * GET /api/v1/audit-plans/can-create
   * Checks if a new plan can be created for the given year.
   * Query param: year (required, integer)
   */
  router.get(
    '/audit-plans/can-create',
    authenticate,
    asyncHandler(async (req, res) => {
      const yearParam = req.query.year;

      if (!yearParam) {
        throw new ValidationError('year query parameter is required');
      }

      const year = parseInt(String(yearParam), 10);

      if (isNaN(year) || year < 2000 || year > 2100) {
        throw new ValidationError('year must be an integer between 2000 and 2100');
      }

      const result = await AuditPlanService.canCreateNewPlan(year);

      res.json({
        success: true,
        data: result,
      });
    })
  );

  /**
   * GET /api/v1/archived-plans
   * Returns all archived plans.
   */
  router.get(
    '/archived-plans',
    authenticate,
    checkPermission('AuditPlans', 'View'),
    asyncHandler(async (req, res) => {
      // Bound the result set to prevent an unbounded SELECT * (finding 1.33 → 2.33).
      // Optional ?limit/?offset pagination, with a sane default + clamped maximum.
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 200, 1), 500);
      const offset = Math.max(parseInt(String(req.query.offset)) || 0, 0);

      const archivedPlans = await db
        .prepare('SELECT * FROM archived_plans ORDER BY year DESC, archived_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset);

      res.json({
        success: true,
        data: archivedPlans,
      });
    })
  );

  /**
   * GET /api/v1/archived-plans/:year
   * Returns archived plans for a specific year.
   */
  router.get(
    '/archived-plans/:year',
    authenticate,
    checkPermission('AuditPlans', 'View'),
    asyncHandler(async (req, res) => {
      const yearParam = req.params.year;
      const year = parseInt(String(yearParam), 10);

      if (isNaN(year) || year < 2000 || year > 2100) {
        throw new ValidationError('year must be an integer between 2000 and 2100');
      }

      const archivedPlans = await db
        .prepare('SELECT * FROM archived_plans WHERE year = ? ORDER BY archived_at DESC')
        .all(year);

      res.json({
        success: true,
        data: archivedPlans,
      });
    })
  );

  // 405 Method Not Allowed for unsupported methods
  router.all('/audit-plans/:id/archive', methodNotAllowed(['POST']));
  router.all('/audit-plans/can-create', methodNotAllowed(['GET']));
  router.all('/archived-plans', methodNotAllowed(['GET']));
  router.all('/archived-plans/:year', methodNotAllowed(['GET']));

  return router;
};

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { methodNotAllowed } from '../utils/routeRegistry';

/**
 * Lookup routes for dropdown/select data in forms.
 * These return simplified lists (id + title/description) for use in UI components.
 */
export const createLookupRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = Router();

  /**
   * GET /api/v1/risk-register/lookup
   * Returns a simplified list of risks from risk_register for dropdown selection.
   * Used in audit program creation form to link risks.
   */
  router.get(
    '/risk-register/lookup',
    authenticate,
    asyncHandler(async (req, res) => {
      const risks = await db
        .prepare(
          `SELECT id, risk_id, description FROM risk_register WHERE deleted_at IS NULL ORDER BY risk_id ASC LIMIT 500`
        )
        .all();

      res.json({
        success: true,
        data: risks.map((r: any) => ({
          id: r.id,
          title: r.risk_id,
          description: r.description,
        })),
      });
    })
  );

  /**
   * GET /api/v1/compliance-items/lookup
   * Returns a simplified list of compliance items for dropdown selection.
   * Used in audit program creation form to link compliance standards.
   */
  router.get(
    '/compliance-items/lookup',
    authenticate,
    asyncHandler(async (req, res) => {
      const items = await db
        .prepare(
          `SELECT id, ref_number, title FROM compliance_items WHERE deleted_at IS NULL ORDER BY ref_number ASC LIMIT 500`
        )
        .all();

      res.json({
        success: true,
        data: items.map((item: any) => ({
          id: item.id,
          title: item.ref_number,
          description: item.title,
        })),
      });
    })
  );

  // 405 Method Not Allowed for unsupported methods
  router.all('/risk-register/lookup', methodNotAllowed(['GET']));
  router.all('/compliance-items/lookup', methodNotAllowed(['GET']));

  return router;
};

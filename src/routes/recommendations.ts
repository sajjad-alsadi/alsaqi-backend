import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError, ForbiddenError } from '../utils/errors';
import { RecommendationService } from '../services/RecommendationService';
import { methodNotAllowed } from '../utils/routeRegistry';

export const createRecommendationRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  // GET /recommendations - List recommendations with filter query params
  router.get('/', authenticate, checkPermission('Recommendations', 'View'), asyncHandler(async (req, res) => {
    const filters = {
      department: req.query.department as string | undefined,
      plan_id: req.query.plan_id as string | undefined,
      status: req.query.status as string | undefined,
      page: req.query.page as string | undefined,
      pageSize: req.query.pageSize as string | undefined,
    };

    const result = await RecommendationService.getRecommendations(filters);
    res.json(result);
  }));

  // POST /recommendations - BLOCKED: Recommendations are auto-derived from findings only
  router.post('/', authenticate, asyncHandler(async (req, res) => {
    throw new ForbiddenError(
      'التوصيات تُشتق تلقائياً من الملاحظات فقط ولا تُنشأ يدوياً / ' +
      'Recommendations are automatically derived from findings and cannot be created manually'
    );
  }));

  router.patch('/:id/resolve', authenticate, checkPermission('Recommendations', 'Edit'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { closure_evidence_path } = req.body;
    
    if (!closure_evidence_path) {
      throw new ValidationError('Evidence path is mandatory to close a recommendation');
    }
    
    const typedReq = req as any;
    const userId = typedReq.user.id;

    try {
      await db.prepare(`
        UPDATE recommendations 
        SET status = 'closed', 
            closure_evidence_path = ?, 
            closed_by = ?, 
            closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(closure_evidence_path, userId, id);
      
      res.json({ success: true });
    } catch (err: any) {
      logError(err, 'PATCH', req.originalUrl, req.ip, userId);
      // Forward to the global error handler so the response is sanitized
      // (never leak raw err.message).
      throw err;
    }
  }));

  // 405 Method Not Allowed for methods not implemented on this custom route
  router.all('/', methodNotAllowed(['POST', 'PATCH']));
  router.all('/:id', methodNotAllowed(['PATCH']));

  return router;
};

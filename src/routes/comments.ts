import express from 'express';
import { z } from 'zod';
import { CommentService } from '../services/CommentService';
import { NotificationService } from '../services/NotificationService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const commentSchema = z.object({
  related_type: z.string().min(1),
  related_id: z.string().min(1),
  content: z.string().min(1).max(5000),
});

/**
 * Maps a comment's `related_type` to the permission module that governs the
 * parent entity. Reading the comments on an entity is allowed only when the
 * user may view that entity, so object-level authorization is derived from the
 * parent resource rather than granted to any authenticated user.
 */
const RELATED_TYPE_MODULES: Record<string, string> = {
  audit_plans: 'AuditPlans',
  audit_tasks: 'AuditTasks',
  audit_findings: 'AuditFindings',
  audit_evidence: 'AuditEvidence',
  recommendations: 'Recommendations',
  risk_register: 'RiskRegister',
  compliance_items: 'ComplianceMatrix',
  conflict_of_interest: 'IntegrityManagement',
  correspondence: 'Correspondence',
  incoming_correspondence: 'Correspondence',
  outgoing_letters: 'Correspondence',
  audit_reports: 'Reports',
};

export const createCommentRoutes = (db: any, authenticate: any, checkPermission: any, logError: any) => {
  const router = express.Router();

  /**
   * Object-level authorization (IDOR fix, finding 1.7 → 2.7).
   *
   * Resolves the permission module from the requested `related_type` and
   * delegates to `checkPermission(module, 'View')`, so a user only receives the
   * comments on entities they are entitled to view. Unknown/unmapped types are
   * denied rather than defaulting to open access.
   */
  const authorizeCommentView = (req: any, res: any, next: any) => {
    const type = req.params.type as string;
    const moduleName = RELATED_TYPE_MODULES[type];
    if (!moduleName) {
      return res.status(403).json({
        error: `Forbidden: comments on resource type '${type}' are not viewable`,
        code: 'PERMISSION_DENIED',
      });
    }
    return checkPermission(moduleName, 'View')(req, res, next);
  };

  router.get("/:type/:id", authenticate, authorizeCommentView, asyncHandler(async (req, res) => {
    const comments = await CommentService.getComments(req.params.type as string, req.params.id as string);
    res.json(comments);
  }));

  router.post("/", authenticate, asyncHandler(async (req, res) => {
    const validation = commentSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid comment data", validation.error.format());
    }
    const userId = (req as any).user.id;
    const result = await CommentService.createComment(userId, validation.data);

    // Notify other participants on this entity
    try {
      const { related_type, related_id } = validation.data;
      // Get all users who previously commented on this entity
      const previousCommenters = await db.prepare(
        "SELECT DISTINCT user_id FROM comments WHERE related_type = ? AND related_id = ?::uuid AND user_id != ?::uuid"
      ).all(related_type, related_id, userId) as any[];
      
      const recipientIds = previousCommenters.map((c: any) => c.user_id);
      
      if (recipientIds.length > 0) {
        const actorName = (req as any).user.name || (req as any).user.username;
        await NotificationService.create(
          recipientIds,
          'comment_added',
          JSON.stringify({ key: 'notifications.commentAdded', params: { actor: actorName, type: related_type } }),
          related_type,
          `/${related_type}`,
          {
            actorId: userId,
            entityId: related_id,
            entityType: related_type,
            title: JSON.stringify({ key: 'notifications.commentAdded' }),
            wss: (req.app as any).wss
          }
        );
      }
    } catch (e) {
      console.error("[Comments] Failed to send notification:", e);
    }

    res.json(result);
  }));

  return router;
};

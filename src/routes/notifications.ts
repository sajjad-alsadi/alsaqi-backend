import express from 'express';
import { ErrorCodes } from '@alsaqi/shared';
import { NotificationService } from '../services/NotificationService';
import { asyncHandler } from '../utils/asyncHandler';
import { parsePaginationParams } from '../utils/paginationService';
import { createSuccessResponse, createErrorResponse } from '../utils/responseEnvelope.js';

export const createNotificationRoutes = (db: any, authenticate: any) => {
  const router = express.Router();

  // Get notifications with pagination
  router.get("/", authenticate, asyncHandler(async (req, res) => {
    const userId = (req as any).user.id;
    const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);
    
    const data = await NotificationService.getNotifications(userId, page, pageSize);
    res.json(data);
  }));

  // Get unread count
  router.get("/unread-count", authenticate, asyncHandler(async (req, res) => {
    const count = await NotificationService.getUnreadCount((req as any).user.id);
    res.json(count);
  }));

  // ── Static routes registered before any parametric route ──────────────────

  // Mark many notifications as read (bulk). R9.1, R9.2, R9.3, R9.7
  router.put("/mark-read", authenticate, asyncHandler(async (req, res) => {
    const ids = ((req.body ?? {}) as { notification_ids?: unknown }).notification_ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json(createErrorResponse({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'notification_ids must be an array',
        details: [{ path: 'notification_ids', message: 'required array', code: 'invalid_type' }],
      }));
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const invalid = ids.filter((id) => typeof id !== 'string' || !UUID_RE.test(id));
    if (invalid.length > 0) {
      return res.status(400).json(createErrorResponse({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'notification_ids must contain only valid UUIDs',
        details: invalid.map((id) => ({
          path: 'notification_ids',
          message: `invalid uuid: ${String(id)}`,
          code: 'invalid_uuid',
        })),
      }));
    }
    const updated = await NotificationService.markManyRead(ids, (req as any).user.id);
    res.json(createSuccessResponse({ data: { updated } }));
  }));

  // Mark all as read — reconciled shape to { updated }. R9.4
  router.put("/mark-all-read", authenticate, asyncHandler(async (req, res) => {
    const updated = await NotificationService.markAllRead((req as any).user.id);
    res.json(createSuccessResponse({ data: { updated } }));
  }));

  // ── Parametric routes ─────────────────────────────────────────────────────

  // Mark single notification as read — unchanged for backward compatibility (R9.5)
  router.put("/:id/read", authenticate, asyncHandler(async (req, res) => {
    await NotificationService.markAsRead(req.params.id as string, (req as any).user.id);
    res.json({ success: true });
  }));

  // Dismiss (soft-delete) a notification — does NOT delete from DB
  router.delete("/:id", authenticate, asyncHandler(async (req, res) => {
    await NotificationService.dismiss(req.params.id as string, (req as any).user.id);
    res.json({ success: true });
  }));

  return router;
};

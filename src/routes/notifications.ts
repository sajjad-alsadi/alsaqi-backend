import express from 'express';
import { NotificationService } from '../services/NotificationService';
import { asyncHandler } from '../utils/asyncHandler';
import { parsePaginationParams } from '../utils/paginationService';

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

  // Mark single notification as read
  router.put("/:id/read", authenticate, asyncHandler(async (req, res) => {
    await NotificationService.markAsRead(req.params.id as string, (req as any).user.id);
    res.json({ success: true });
  }));

  // Mark all as read
  router.put("/mark-all-read", authenticate, asyncHandler(async (req, res) => {
    await NotificationService.markAllRead((req as any).user.id);
    res.json({ success: true });
  }));

  // Dismiss (soft-delete) a notification — does NOT delete from DB
  router.delete("/:id", authenticate, asyncHandler(async (req, res) => {
    await NotificationService.dismiss(req.params.id as string, (req as any).user.id);
    res.json({ success: true });
  }));

  return router;
};

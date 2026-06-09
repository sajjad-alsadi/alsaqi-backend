import { db } from '../db/index';
import { UserRole } from '@alsaqi/shared';
import { computePaginationMeta } from '../utils/paginationService';
import type { PaginationMeta } from '@alsaqi/shared';

export type NotificationEventType =
  | 'plan_started' | 'plan_assigned' | 'plan_status_changed'
  | 'task_assigned' | 'task_status_changed' | 'task_completed'
  | 'finding_added' | 'finding_status_changed'
  | 'recommendation_added' | 'recommendation_overdue' | 'recommendation_due_soon'
  | 'risk_added' | 'risk_updated' | 'risk_escalated'
  | 'comment_added' | 'comment_mentioned'
  | 'evidence_uploaded'
  | 'account_locked' | 'password_reset_request' | 'permission_changed'
  | 'access_requested' | 'access_approved' | 'access_rejected'
  | 'instruction_overdue' | 'policy_review_required'
  | 'correspondence_received'
  | 'record_created'
  | string;

export interface CreateNotificationOptions {
  actorId?: string;
  entityId?: string;
  entityType?: string;
  data?: Record<string, any>;
  wss?: any;
  /** Optional title (short) */
  title?: string;
}

export interface NotificationFeedItem {
  id: string;
  recipient_row_id: string;
  event_type: string;
  title: string | null;
  description: string;
  related_module: string;
  link: string;
  actor_id: string | null;
  entity_id: string | null;
  entity_type: string | null;
  data: any;
  date: string;
  is_read: boolean;
  read_at: string | null;
}

export class NotificationService {
  /**
   * Get notifications for a user with pagination (uses notification_recipients join).
   * Falls back to legacy single-table if notification_recipients doesn't exist yet.
   */
  static async getNotifications(userId: string | number, page = 1, pageSize = 20): Promise<{ data: NotificationFeedItem[]; pagination: PaginationMeta }> {
    const offset = (page - 1) * pageSize;

    try {
      // Try new two-table architecture first
      const countRes = await db.prepare(
        "SELECT COUNT(*) as total FROM notification_recipients WHERE recipient_id = ?::uuid AND is_dismissed = false"
      ).get(userId) as any;
      const total = countRes?.total || 0;

      const results = await db.prepare(`
        SELECT 
          n.id,
          nr.id as recipient_row_id,
          n.event_type,
          n.title,
          n.description,
          n.related_module,
          n.link,
          n.actor_id,
          n.entity_id,
          n.entity_type,
          n.data,
          n.date,
          nr.is_read,
          nr.read_at
        FROM notification_recipients nr
        JOIN notifications n ON n.id = nr.notification_id
        WHERE nr.recipient_id = ?::uuid AND nr.is_dismissed = false
        ORDER BY n.date DESC
        LIMIT ? OFFSET ?
      `).all(userId, pageSize, offset) as any[];

      return {
        data: results,
        pagination: computePaginationMeta(page, pageSize, total)
      };
    } catch {
      // Fallback to legacy single-table
      const countRes = await db.prepare(
        "SELECT COUNT(*) as total FROM notifications WHERE user_id = ?::uuid"
      ).get(userId) as any;
      const total = countRes?.total || 0;

      const results = await db.prepare(
        "SELECT id, id as recipient_row_id, event_type, description, related_module, link, actor_id, entity_id, entity_type, data, date, CASE WHEN status = 'Read' THEN true ELSE false END as is_read, NULL as read_at, NULL as title FROM notifications WHERE user_id = ?::uuid ORDER BY date DESC LIMIT ? OFFSET ?"
      ).all(userId, pageSize, offset) as any[];
      return {
        data: results,
        pagination: computePaginationMeta(page, pageSize, total)
      };
    }
  }

  /**
   * Get unread count for a user.
   */
  static async getUnreadCount(userId: string | number): Promise<{ count: number }> {
    try {
      const result = await db.prepare(
        "SELECT COUNT(*) as count FROM notification_recipients WHERE recipient_id = ?::uuid AND is_read = false AND is_dismissed = false"
      ).get(userId) as any;
      return result || { count: 0 };
    } catch {
      // Fallback
      const result = await db.prepare(
        "SELECT COUNT(*) as count FROM notifications WHERE user_id = ?::uuid AND status = 'Unread'"
      ).get(userId) as any;
      return result || { count: 0 };
    }
  }

  /**
   * Mark a single notification as read for a specific user.
   */
  static async markAsRead(notificationId: string | number, userId: string | number) {
    try {
      await db.prepare(
        "UPDATE notification_recipients SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE notification_id = ?::uuid AND recipient_id = ?::uuid"
      ).run(notificationId, userId);
    } catch {
      // Fallback
      await db.prepare(
        "UPDATE notifications SET status = 'Read' WHERE id = ?::uuid AND user_id = ?::uuid"
      ).run(notificationId, userId);
    }
    return true;
  }

  /**
   * Mark all notifications as read for a specific user.
   */
  static async markAllRead(userId: string | number) {
    try {
      await db.prepare(
        "UPDATE notification_recipients SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE recipient_id = ?::uuid AND is_read = false"
      ).run(userId);
    } catch {
      // Fallback
      await db.prepare(
        "UPDATE notifications SET status = 'Read' WHERE user_id = ?::uuid AND status = 'Unread'"
      ).run(userId);
    }
    return true;
  }

  /**
   * Dismiss (soft-delete) a notification for a specific user.
   * Does NOT delete from DB — just marks is_dismissed = true for this user.
   */
  static async dismiss(notificationId: string | number, userId: string | number) {
    try {
      await db.prepare(
        "UPDATE notification_recipients SET is_dismissed = true, dismissed_at = CURRENT_TIMESTAMP WHERE notification_id = ?::uuid AND recipient_id = ?::uuid"
      ).run(notificationId, userId);
    } catch {
      // Fallback: actually delete from legacy table
      await db.prepare(
        "DELETE FROM notifications WHERE id = ?::uuid AND user_id = ?::uuid"
      ).run(notificationId, userId);
    }
    return true;
  }

  /**
   * Create a notification and insert recipient rows for each target user.
   * One notification row → many recipient rows (per-user isolation).
   */
  static async create(
    recipientIds: string | string[] | 'all',
    type: string,
    message: string,
    module: string,
    link: string,
    options?: CreateNotificationOptions
  ) {
    const { actorId, entityId, entityType, data, wss, title } = options || {};
    const dataJson = data ? JSON.stringify(data) : '{}';

    // Resolve recipient list
    let targetUserIds: string[] = [];

    if (recipientIds === 'all') {
      const users = await db.prepare("SELECT id FROM users WHERE status = 'active'").all() as any[];
      targetUserIds = users.map((u: any) => u.id);
    } else if (Array.isArray(recipientIds)) {
      targetUserIds = [...recipientIds];
    } else {
      targetUserIds = [String(recipientIds)];
    }

    // Exclude the actor from recipients (don't notify yourself)
    if (actorId) {
      targetUserIds = targetUserIds.filter(id => id !== actorId);
    }

    if (targetUserIds.length === 0) return true;

    try {
      // Insert ONE notification row
      const notifResult = await db.prepare(`
        INSERT INTO notifications (event_type, description, related_module, link, actor_id, entity_id, entity_type, data, title, status, user_id, date)
        VALUES (?::text, ?::text, ?::text, ?::text, ${actorId ? '?::uuid' : 'NULL'}, ${entityId ? '?::uuid' : 'NULL'}, ${entityType ? '?::text' : 'NULL'}, ?::jsonb, ${title ? '?::text' : 'NULL'}, 'Unread', ?::uuid, CURRENT_TIMESTAMP)
        RETURNING id, date
      `).get(
        ...[type, message, module, link,
          ...(actorId ? [actorId] : []),
          ...(entityId ? [entityId] : []),
          ...(entityType ? [entityType] : []),
          dataJson,
          ...(title ? [title] : []),
          targetUserIds[0] // user_id for legacy compat
        ]
      ) as any;

      const notificationId = notifResult?.id;
      const notificationDate = notifResult?.date;

      if (notificationId) {
        // Insert recipient rows for each target user
        for (const uid of targetUserIds) {
          await db.prepare(
            "INSERT INTO notification_recipients (notification_id, recipient_id) VALUES (?::uuid, ?::uuid)"
          ).run(notificationId, uid);
        }

        // Also insert legacy rows for remaining users (backward compat with old frontend queries)
        // Skip first user since we already used them for the main notification row
        for (let i = 1; i < targetUserIds.length; i++) {
          await db.prepare(`
            INSERT INTO notifications (event_type, description, related_module, link, actor_id, entity_id, entity_type, data, title, status, user_id, date)
            VALUES (?::text, ?::text, ?::text, ?::text, ${actorId ? '?::uuid' : 'NULL'}, ${entityId ? '?::uuid' : 'NULL'}, ${entityType ? '?::text' : 'NULL'}, ?::jsonb, ${title ? '?::text' : 'NULL'}, 'Unread', ?::uuid, CURRENT_TIMESTAMP)
          `).run(
            ...[type, message, module, link,
              ...(actorId ? [actorId] : []),
              ...(entityId ? [entityId] : []),
              ...(entityType ? [entityType] : []),
              dataJson,
              ...(title ? [title] : []),
              targetUserIds[i]
            ]
          );
        }
      }

      // Real-time WebSocket push to each target user
      if (wss && targetUserIds.length > 0) {
        const payload = JSON.stringify({
          type: 'NEW_NOTIFICATION',
          notification: {
            id: notificationId,
            event_type: type,
            title: title || null,
            description: message,
            related_module: module,
            link,
            is_read: false,
            date: notificationDate || new Date().toISOString(),
            actor_id: actorId || null,
            entity_id: entityId || null,
            entity_type: entityType || null,
          }
        });

        wss.clients.forEach((client: any) => {
          if (client.readyState === 1 && client.authenticated && targetUserIds.includes(client.userId)) {
            client.send(payload);
          }
        });
      }
    } catch (e) {
      // Fallback: insert one row per user (legacy behavior)
      console.error("[NotificationService] Two-table insert failed, using legacy:", (e as any)?.message);
      for (const uid of targetUserIds) {
        try {
          await db.prepare(`
            INSERT INTO notifications (user_id, event_type, description, related_module, link, status, actor_id, entity_id, entity_type, data)
            VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Unread', ${actorId ? '?::uuid' : 'NULL'}, ${entityId ? '?::uuid' : 'NULL'}, ${entityType ? '?::text' : 'NULL'}, ?::jsonb)
          `).run(
            ...[uid, type, message, module, link,
              ...(actorId ? [actorId] : []),
              ...(entityId ? [entityId] : []),
              ...(entityType ? [entityType] : []),
              dataJson
            ]
          );
        } catch { /* skip */ }
      }
    }

    return true;
  }

  /** Get admin user IDs */
  static async getAdminIds(): Promise<string[]> {
    const admins = await db.prepare(
      `SELECT id FROM users WHERE role = '${UserRole.ADMIN}' AND status = 'active'`
    ).all() as any[];
    return admins.map((a: any) => a.id);
  }

  /** Get user ID by name or username */
  static async getUserIdByName(name: string): Promise<string | null> {
    const user = await db.prepare(
      "SELECT id FROM users WHERE name = ? OR username = ?"
    ).get(name, name) as any;
    return user?.id || null;
  }

  /** Get users in a specific department */
  static async getUserIdsByDepartment(department: string): Promise<string[]> {
    const users = await db.prepare(
      "SELECT id FROM users WHERE department = ? AND status = 'active'"
    ).all(department) as any[];
    return users.map((u: any) => u.id);
  }
}

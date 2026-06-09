import express from 'express';
import { AuditTaskService } from '../services/AuditTaskService';
import { NotificationService } from '../services/NotificationService';
import { BaseService } from '../services/BaseService';
import { AuthService } from '../services/AuthService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError, NotFoundError } from '../utils/errors';
import { UserRole } from '@alsaqi/shared';

const TABLE_NAME = "audit_tasks";
const ALLOWED_FIELDS = [
  "task_number", "title", "plan_id", "program_id", "audit_type", "task_type", "status",
  "assigned_to", "audited_unit_id", "planned_hours", "actual_hours",
  "period_from", "period_to", "due_date", "approved_by", "approved_at", "created_by"
];

export const createAuditTaskRoutes = (
  db: any,
  authenticate: any,
  logError: any
) => {
  const router = express.Router();

  // ─── Custom Operations (must be before /:id to prevent matching) ──────────

  // PATCH /:id/status — Status transitions
  router.patch('/:id/status', authenticate, asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const { status } = req.body;
    
    const typedReq = req as any;
    const userId = typedReq.user.id;
    const userRole = typedReq.user.role;

    try {
      await AuditTaskService.changeStatus(String(id), status, userId, userRole, db);

      // Notify assigned user about status change
      try {
        const task = await db.prepare("SELECT title, assigned_to, created_by FROM audit_tasks WHERE id = ?::uuid").get(id) as any;
        if (task) {
          const recipients: string[] = [];
          if (task.assigned_to && task.assigned_to !== userId) recipients.push(task.assigned_to);
          if (task.created_by && task.created_by !== userId && task.created_by !== task.assigned_to) recipients.push(task.created_by);
          
          if (recipients.length > 0) {
            await NotificationService.create(
              recipients,
              'task_status_changed',
              JSON.stringify({ key: 'notifications.taskStatusChanged', params: { title: task.title, status: status } }),
              'AuditTasks',
              '/tasks',
              {
                actorId: userId,
                entityId: id,
                entityType: 'audit_task',
                title: JSON.stringify({ key: 'notifications.taskStatusChanged' }),
                wss: (req.app as any).wss,
                data: { new_status: status }
              }
            );
          }
        }
      } catch (e) {
        console.error("[AuditTasks] Notification failed:", e);
      }

      res.json({ success: true, message: 'Status updated successfully' });
    } catch (err: any) {
      logError(err, 'PATCH', req.originalUrl, req.ip, userId);
      res.status(400).json({ success: false, error: { message: err.message, code: err.code || 'BAD_REQUEST' } });
    }
  }));

  // POST /:id/assign — Assign users to a task
  router.post('/:id/assign', authenticate, asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const { userIds } = req.body;

    const typedReq = req as any;
    const userId = typedReq.user.id;
    const userRole = typedReq.user.role;

    const allowedRoles = [UserRole.MANAGER, UserRole.ADMIN];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: {
          message: 'لا تملك صلاحية تعيين مستخدمين للمهام. يجب أن يكون دورك مدير أو مسؤول',
          code: 'FORBIDDEN'
        }
      });
    }

    try {
      const result = await AuditTaskService.assignUsers(String(id), userIds, userId);

      try {
        const task = await db.prepare("SELECT title, task_number FROM audit_tasks WHERE id = ?::uuid").get(id) as any;
        if (task && result.assignments.length > 0) {
          const assignedUserIds = result.assignments.map((a: any) => a.user_id);

          await NotificationService.create(
            assignedUserIds,
            'task_assigned',
            JSON.stringify({ key: 'notifications.taskAssigned', params: { title: task.title, taskNumber: task.task_number } }),
            'AuditTasks',
            '/tasks',
            {
              actorId: userId,
              entityId: id,
              entityType: 'audit_task',
              title: JSON.stringify({ key: 'notifications.taskAssigned' }),
              wss: (req.app as any).wss,
              data: { task_id: id, task_number: task.task_number }
            }
          );
        }
      } catch (e) {
        console.error("[AuditTasks] Assignment notification failed:", e);
      }

      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      logError(err, 'POST', req.originalUrl, req.ip, userId);
      const statusCode = err.statusCode || 400;
      res.status(statusCode).json({
        success: false,
        error: { message: err.message, code: err.errorCode || 'BAD_REQUEST', details: err.details }
      });
    }
  }));

  // DELETE /:id/assign/:userId — Unassign a user from a task
  router.delete('/:id/assign/:userId', authenticate, asyncHandler(async (req, res) => {
    const { id, userId: targetUserId } = req.params;

    const typedReq = req as any;
    const currentUserId = typedReq.user.id;
    const userRole = typedReq.user.role;

    const allowedRoles = [UserRole.MANAGER, UserRole.ADMIN];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: {
          message: 'لا تملك صلاحية إزالة تعيين المستخدمين من المهام. يجب أن يكون دورك مدير أو مسؤول',
          code: 'FORBIDDEN'
        }
      });
    }

    try {
      const result = await AuditTaskService.unassignUser(String(id), String(targetUserId), currentUserId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logError(err, 'DELETE', req.originalUrl, req.ip, currentUserId);
      const statusCode = err.statusCode || 400;
      res.status(statusCode).json({
        success: false,
        error: { message: err.message, code: err.errorCode || 'BAD_REQUEST' }
      });
    }
  }));

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  // GET / — List all tasks
  router.get('/', authenticate, asyncHandler(async (req, res) => {
    const tasks = await AuditTaskService.getTasks(req.query);
    res.json(tasks);
  }));

  // POST / — Create a new task
  router.post('/', authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const rawBody = { ...typedReq.body };

    // Strict field whitelisting
    const body: any = {};
    for (const key of Object.keys(rawBody)) {
      if (ALLOWED_FIELDS.includes(key)) {
        body[key] = rawBody[key];
      }
    }

    // Remove empty/null UUID fields to avoid PostgreSQL type errors
    if (!body.plan_id) delete body.plan_id;
    if (!body.program_id) delete body.program_id;
    if (!body.audited_unit_id) delete body.audited_unit_id;
    if (!body.assigned_to) delete body.assigned_to;

    // Set created_by to current user
    body.created_by = typedReq.user.id;

    const result = await BaseService.create(TABLE_NAME, body);

    await AuthService.logAudit(
      typedReq.user.username,
      `Created ${TABLE_NAME}`,
      "audit-tasks",
      JSON.stringify(body)
    );

    res.json(result);
  }));

  // PUT /:id — Update a task
  router.put('/:id', authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid task ID");
    }

    const rawBody = { ...typedReq.body };

    // Strict field whitelisting
    const body: any = {};
    for (const key of Object.keys(rawBody)) {
      if (ALLOWED_FIELDS.includes(key)) {
        body[key] = rawBody[key];
      }
    }

    const result = await BaseService.update(TABLE_NAME, id, body);

    await AuthService.logAudit(
      typedReq.user.username,
      `Updated ${TABLE_NAME} ID: ${id}`,
      "audit-tasks",
      JSON.stringify(body)
    );

    res.json(result);
  }));

  // DELETE /:id — Delete a task
  router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid task ID");
    }

    await BaseService.delete(TABLE_NAME, id);

    await AuthService.logAudit(
      typedReq.user.username,
      `Deleted ${TABLE_NAME} ID: ${id}`,
      "audit-tasks",
      JSON.stringify({ id })
    );

    res.json({ success: true });
  }));

  return router;
};

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@alsaqi/shared';

/**
 * Integration Tests - Audit Tasks Routes
 *
 * Tests the audit tasks custom routes using supertest against a minimal Express app
 * with mocked AuditTaskService and NotificationService.
 * Covers status transitions, notifications, validation, and authentication.
 */

// Mock AuditTaskService
const mockAuditTaskService = {
  changeStatus: vi.fn().mockResolvedValue({ changes: 1 }),
  getTasks: vi.fn().mockResolvedValue({ data: [], pagination: { total: 0, page: 1, pageSize: 20, totalPages: 0, hasNext: false, hasPrev: false } }),
};

vi.mock('../../services/AuditTaskService', () => ({
  AuditTaskService: {
    changeStatus: (...args: any[]) => mockAuditTaskService.changeStatus(...args),
    getTasks: (...args: any[]) => mockAuditTaskService.getTasks(...args),
  },
}));

// Mock NotificationService
const mockNotificationService = {
  create: vi.fn().mockResolvedValue(true),
};

vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: (...args: any[]) => mockNotificationService.create(...args),
  },
}));

import { createAuditTaskRoutes } from '../auditTasks';
import { globalErrorHandler } from '../../middleware/error';

function createAuditTaskTestApp(options?: {
  authenticatedRole?: string;
  authenticatedUserId?: string;
  authenticate?: boolean;
}) {
  const authenticatedRole = options?.authenticatedRole || UserRole.MANAGER;
  const authenticatedUserId = options?.authenticatedUserId || 'test-user-id';
  const shouldAuthenticate = options?.authenticate !== false;

  const app = express();
  app.use(express.json());

  const authenticate: express.RequestHandler = (req: any, res, next) => {
    if (!shouldAuthenticate) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = {
      id: authenticatedUserId,
      role: authenticatedRole,
      username: 'testuser',
      name: 'Test User',
      email: 'test@example.com',
    };
    next();
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({
        id: 'task-1',
        title: 'Test Task',
        assigned_to: 'user-assigned',
        created_by: 'user-creator',
      }),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
    }),
  };

  const logError = vi.fn();

  const checkPermission = () => (_req: any, _res: any, next: any) => next();

  const router = createAuditTaskRoutes(mockDb, authenticate, checkPermission, logError);
  app.use('/api/audit-tasks', router);
  app.use(globalErrorHandler);

  return { app, mockDb, logError };
}

describe('Audit Tasks Integration Tests', () => {
  let app: express.Application;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createAuditTaskTestApp();
    app = testApp.app;
    mockDb = testApp.mockDb;
  });

  // ─── PATCH /api/audit-tasks/:id/status ─────────────────────────────────────

  describe('PATCH /api/audit-tasks/:id/status', () => {
    it('should return 200 and update status on valid transition', async () => {
      mockAuditTaskService.changeStatus.mockResolvedValueOnce({ changes: 1 });

      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Status updated successfully');
      expect(mockAuditTaskService.changeStatus).toHaveBeenCalledWith(
        'task-1', 'in_progress', 'test-user-id', 'Manager', expect.anything()
      );
    });

    it('should send notification to assigned_to and created_by (excluding actor)', async () => {
      mockAuditTaskService.changeStatus.mockResolvedValueOnce({ changes: 1 });

      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'review' });

      expect(res.status).toBe(200);
      // NotificationService.create should be called with recipients
      expect(mockNotificationService.create).toHaveBeenCalledWith(
        ['user-assigned', 'user-creator'],
        'task_status_changed',
        expect.any(String),
        'AuditTasks',
        '/tasks',
        expect.objectContaining({
          actorId: 'test-user-id',
          entityId: 'task-1',
          entityType: 'audit_task',
        })
      );
    });

    it('should not include actor in notification recipients', async () => {
      // Actor is assigned_to
      const { app: actorApp } = createAuditTaskTestApp({ authenticatedUserId: 'user-assigned' });
      mockAuditTaskService.changeStatus.mockResolvedValueOnce({ changes: 1 });

      const res = await request(actorApp)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(200);
      // Should only notify created_by since actor is assigned_to
      expect(mockNotificationService.create).toHaveBeenCalledWith(
        ['user-creator'],
        'task_status_changed',
        expect.any(String),
        'AuditTasks',
        '/tasks',
        expect.objectContaining({ actorId: 'user-assigned' })
      );
    });

    it('should return 400 when changeStatus throws ValidationError', async () => {
      mockAuditTaskService.changeStatus.mockRejectedValueOnce(
        Object.assign(new Error('Invalid status transition'), { code: 'BAD_REQUEST' })
      );

      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'invalid_status' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Invalid status transition');
    });

    it('should return 400 when changeStatus throws ForbiddenError', async () => {
      mockAuditTaskService.changeStatus.mockRejectedValueOnce(
        Object.assign(new Error('IAMS-PERM-001'), { code: 'FORBIDDEN' })
      );

      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'approved' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('IAMS-PERM-001');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .send({ status: 'in_progress' });

      expect(res.status).toBe(401);
    });

    it('should still succeed even if notification fails', async () => {
      mockAuditTaskService.changeStatus.mockResolvedValueOnce({ changes: 1 });
      // Make db.prepare().get() throw to simulate notification failure
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('DB error')),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const res = await request(app)
        .patch('/api/audit-tasks/task-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'in_progress' });

      // The route catches notification errors and still returns success
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ─── GET /api/audit-tasks/ ─────────────────────────────────────────────────

  describe('GET /api/audit-tasks/', () => {
    it('should return 200 with task list', async () => {
      mockAuditTaskService.getTasks.mockResolvedValueOnce({
        data: [{ id: 'task-1', title: 'Audit Task 1', status: 'draft' }],
        pagination: { total: 1, page: 1, pageSize: 20, totalPages: 1, hasNext: false, hasPrev: false },
      });

      const res = await request(app)
        .get('/api/audit-tasks/')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Audit Task 1');
      expect(mockAuditTaskService.getTasks).toHaveBeenCalled();
    });

    it('should pass query params to getTasks', async () => {
      const res = await request(app)
        .get('/api/audit-tasks/?plan_id=plan-1&page=2&pageSize=10')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockAuditTaskService.getTasks).toHaveBeenCalledWith(
        expect.objectContaining({ plan_id: 'plan-1', page: '2', pageSize: '10' })
      );
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/audit-tasks/');
      expect(res.status).toBe(401);
    });
  });
});

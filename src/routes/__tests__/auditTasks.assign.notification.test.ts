// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 12.4: Add notification for task assignment
 * Validates: Requirement 4.3
 *
 * Verifies:
 * 1. Notification is sent to each assigned user within 60 seconds of assignment creation (synchronous in request)
 * 2. Notification payload includes the task_id
 * 3. Each assigned user receives the notification
 */

// Hoisted mocks
const { mockDbPrepare, mockNotificationCreate, mockAssignUsers } = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
  mockNotificationCreate: vi.fn(),
  mockAssignUsers: vi.fn(),
}));

// Mock database
vi.mock('../../db/index', () => ({
  db: { prepare: mockDbPrepare },
  default: { prepare: mockDbPrepare },
}));

// Mock NotificationService
vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: mockNotificationCreate,
  },
}));

// Mock AuditTaskService
vi.mock('../../services/AuditTaskService', () => ({
  AuditTaskService: {
    assignUsers: mockAssignUsers,
  },
}));

// Mock asyncHandler to just pass through
vi.mock('../../utils/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

// Mock routeRegistry
vi.mock('../../utils/routeRegistry', () => ({
  methodNotAllowed: () => (_req: any, _res: any, next: any) => next(),
}));

import { createAuditTaskRoutes } from '../auditTasks';
import { UserRole } from '@alsaqi/shared';

describe('Task Assignment Notification (Requirement 4.3)', () => {
  let router: any;
  const mockDb = { prepare: mockDbPrepare };
  const mockAuthenticate = (_req: any, _res: any, next: any) => next();
  const mockLogError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    router = createAuditTaskRoutes(mockDb, mockAuthenticate, mockLogError);
  });

  function createMockReq(params: any, body: any, user: any) {
    return {
      params,
      body,
      user,
      app: { wss: { clients: new Set() } },
      originalUrl: '/api/v1/audit-tasks/task-1/assign',
      ip: '127.0.0.1',
    };
  }

  function createMockRes() {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  // Helper to get the assign route handler from the router
  function getAssignHandler() {
    // Find the POST /:id/assign route handler
    const layer = router.stack.find(
      (l: any) => l.route && l.route.path === '/:id/assign' && l.route.methods.post
    );
    if (!layer) throw new Error('POST /:id/assign route not found');
    // The handler is the last in the stack (after authenticate middleware)
    const handlers = layer.route.stack.filter((s: any) => s.method === 'post');
    return handlers[handlers.length - 1].handle;
  }

  it('sends notification to each assigned user after successful assignment', async () => {
    const taskId = 'task-uuid-123';
    const assignedUserIds = ['user-a', 'user-b', 'user-c'];
    const assignerId = 'manager-uuid';

    // Mock AuditTaskService.assignUsers to return assignments
    mockAssignUsers.mockResolvedValueOnce({
      assignments: assignedUserIds.map(uid => ({
        id: `assign-${uid}`,
        task_id: taskId,
        user_id: uid,
        assigned_at: new Date().toISOString(),
        assigned_by: assignerId,
      })),
    });

    // Mock db.prepare for fetching task details
    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        title: 'Test Audit Task',
        task_number: 'IA-PL-25-001-T01',
      }),
    });

    // Mock NotificationService.create to succeed
    mockNotificationCreate.mockResolvedValueOnce(true);

    const req = createMockReq(
      { id: taskId },
      { userIds: assignedUserIds },
      { id: assignerId, role: UserRole.MANAGER }
    );
    const res = createMockRes();

    const handler = getAssignHandler();
    await handler(req, res);

    // Verify notification was sent
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);

    // Verify notification was sent to all assigned users
    const [recipients] = mockNotificationCreate.mock.calls[0];
    expect(recipients).toEqual(assignedUserIds);
  });

  it('includes task_id in notification payload', async () => {
    const taskId = 'task-uuid-456';
    const assignedUserIds = ['user-x'];
    const assignerId = 'admin-uuid';

    mockAssignUsers.mockResolvedValueOnce({
      assignments: [{ id: 'a1', task_id: taskId, user_id: 'user-x', assigned_at: new Date().toISOString(), assigned_by: assignerId }],
    });

    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        title: 'Financial Audit Task',
        task_number: 'IA-PL-25-002-T03',
      }),
    });

    mockNotificationCreate.mockResolvedValueOnce(true);

    const req = createMockReq(
      { id: taskId },
      { userIds: assignedUserIds },
      { id: assignerId, role: UserRole.ADMIN }
    );
    const res = createMockRes();

    const handler = getAssignHandler();
    await handler(req, res);

    // Verify notification payload includes task_id
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockNotificationCreate.mock.calls[0];
    const options = callArgs[5]; // 6th argument is the options object
    expect(options).toBeDefined();
    expect(options.data).toBeDefined();
    expect(options.data.task_id).toBe(taskId);
    expect(options.entityId).toBe(taskId);
  });

  it('notification is sent synchronously within the same request (within 60s SLA)', async () => {
    const taskId = 'task-uuid-789';
    const assignedUserIds = ['user-1', 'user-2'];
    const assignerId = 'manager-uuid';

    mockAssignUsers.mockResolvedValueOnce({
      assignments: assignedUserIds.map(uid => ({
        id: `a-${uid}`, task_id: taskId, user_id: uid,
        assigned_at: new Date().toISOString(), assigned_by: assignerId,
      })),
    });

    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        title: 'Compliance Task',
        task_number: 'IA-PL-25-003-T01',
      }),
    });

    mockNotificationCreate.mockResolvedValueOnce(true);

    const req = createMockReq(
      { id: taskId },
      { userIds: assignedUserIds },
      { id: assignerId, role: UserRole.MANAGER }
    );
    const res = createMockRes();

    const startTime = Date.now();
    const handler = getAssignHandler();
    await handler(req, res);
    const elapsed = Date.now() - startTime;

    // Notification is sent synchronously in the same request cycle
    // This guarantees it's well within the 60-second SLA
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(60000); // Well within 60 seconds

    // Response is 201 (success)
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('does not send notification when no assignments are created', async () => {
    const taskId = 'task-uuid-empty';
    const assignerId = 'manager-uuid';

    // assignUsers returns empty assignments (edge case)
    mockAssignUsers.mockResolvedValueOnce({ assignments: [] });

    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        title: 'Empty Task',
        task_number: 'IA-PL-25-004-T01',
      }),
    });

    const req = createMockReq(
      { id: taskId },
      { userIds: [] },
      { id: assignerId, role: UserRole.MANAGER }
    );
    const res = createMockRes();

    const handler = getAssignHandler();
    await handler(req, res);

    // No notification should be sent when there are no assignments
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it('still returns success even if notification fails (non-blocking)', async () => {
    const taskId = 'task-uuid-fail';
    const assignedUserIds = ['user-1'];
    const assignerId = 'manager-uuid';

    mockAssignUsers.mockResolvedValueOnce({
      assignments: [{ id: 'a1', task_id: taskId, user_id: 'user-1', assigned_at: new Date().toISOString(), assigned_by: assignerId }],
    });

    mockDbPrepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        title: 'Task With Failing Notification',
        task_number: 'IA-PL-25-005-T01',
      }),
    });

    // Notification fails
    mockNotificationCreate.mockRejectedValueOnce(new Error('Notification service unavailable'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = createMockReq(
      { id: taskId },
      { userIds: assignedUserIds },
      { id: assignerId, role: UserRole.MANAGER }
    );
    const res = createMockRes();

    const handler = getAssignHandler();
    await handler(req, res);

    // Assignment still succeeds even if notification fails
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );

    consoleSpy.mockRestore();
  });
});

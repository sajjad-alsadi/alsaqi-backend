// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  const mockTransaction = vi.fn(async (fn: Function) => fn());
  return {
    db: {
      prepare: mockPrepare,
      transaction: mockTransaction,
    },
  };
});

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AuditTaskService } from '../AuditTaskService';
import { db } from '../../db/index';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../../utils/errors';

describe('AuditTaskService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('assignUsers', () => {
    const taskId = 'task-uuid-001';
    const assignedBy = 'manager-uuid-001';
    const userIds = ['user-uuid-001', 'user-uuid-002'];

    function setupAssignMocks(options: {
      assignerRole?: string;
      assignerExists?: boolean;
      taskExists?: boolean;
      usersExist?: string[];
      existingAssignments?: string[];
    } = {}) {
      const {
        assignerRole = 'Manager',
        assignerExists = true,
        taskExists = true,
        usersExist = userIds,
        existingAssignments = [],
      } = options;

      // 1. Validate assigner role
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(
          assignerExists ? { id: assignedBy, role: assignerRole } : undefined
        ),
      });

      if (!assignerExists || !['Manager', 'Admin'].includes(assignerRole)) return;

      // 2. Validate task exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(
          taskExists ? { id: taskId } : undefined
        ),
      });

      if (!taskExists) return;

      // 3. Validate all user IDs exist (IN query)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(
          usersExist.map(id => ({ id }))
        ),
      });

      if (usersExist.length !== [...new Set(userIds)].length) return;

      // 4. For each user: check existing + insert
      const uniqueIds = [...new Set(userIds)];
      for (const userId of uniqueIds) {
        // Check existing assignment
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(
            existingAssignments.includes(userId) ? { id: 'existing-id' } : undefined
          ),
        });

        if (existingAssignments.includes(userId)) break;

        // Insert assignment
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({
            id: `assignment-${userId}`,
            task_id: taskId,
            user_id: userId,
            assigned_at: '2025-01-01T00:00:00Z',
            assigned_by: assignedBy,
          }),
        });
      }
    }

    it('should throw ValidationError when userIds is empty', async () => {
      await expect(
        AuditTaskService.assignUsers(taskId, [], assignedBy)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when userIds is null/undefined', async () => {
      await expect(
        AuditTaskService.assignUsers(taskId, null as any, assignedBy)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when userIds exceeds 50', async () => {
      const tooManyUsers = Array.from({ length: 51 }, (_, i) => `user-${i}`);
      await expect(
        AuditTaskService.assignUsers(taskId, tooManyUsers, assignedBy)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ForbiddenError when assigner does not exist', async () => {
      setupAssignMocks({ assignerExists: false });

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when assigner is Internal Auditor', async () => {
      setupAssignMocks({ assignerRole: 'Internal Auditor' });

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when assigner is Viewer', async () => {
      setupAssignMocks({ assignerRole: 'Viewer' });

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw NotFoundError when task does not exist', async () => {
      setupAssignMocks({ taskExists: false });

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when some user IDs do not exist', async () => {
      setupAssignMocks({ usersExist: ['user-uuid-001'] }); // only one exists

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ConflictError when user is already assigned', async () => {
      setupAssignMocks({ existingAssignments: ['user-uuid-001'] });

      await expect(
        AuditTaskService.assignUsers(taskId, userIds, assignedBy)
      ).rejects.toThrow(ConflictError);
    });

    it('should successfully assign users when Manager role', async () => {
      setupAssignMocks({ assignerRole: 'Manager' });

      const result = await AuditTaskService.assignUsers(taskId, userIds, assignedBy);

      expect(result.assignments).toHaveLength(2);
      expect(result.assignments[0].task_id).toBe(taskId);
      expect(result.assignments[0].user_id).toBe('user-uuid-001');
      expect(result.assignments[1].user_id).toBe('user-uuid-002');
    });

    it('should successfully assign users when Admin role', async () => {
      setupAssignMocks({ assignerRole: 'Admin' });

      const result = await AuditTaskService.assignUsers(taskId, userIds, assignedBy);

      expect(result.assignments).toHaveLength(2);
    });

    it('should deduplicate user IDs before processing', async () => {
      const duplicateUserIds = ['user-uuid-001', 'user-uuid-001'];

      // Assigner role check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: assignedBy, role: 'Manager' }),
      });
      // Task exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: taskId }),
      });
      // Users exist (only 1 unique)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'user-uuid-001' }]),
      });
      // Check existing assignment
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });
      // Insert
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'assignment-1',
          task_id: taskId,
          user_id: 'user-uuid-001',
          assigned_at: '2025-01-01T00:00:00Z',
          assigned_by: assignedBy,
        }),
      });

      const result = await AuditTaskService.assignUsers(taskId, duplicateUserIds, assignedBy);

      // Should only create 1 assignment (deduplicated)
      expect(result.assignments).toHaveLength(1);
    });
  });

  describe('unassignUser', () => {
    const taskId = 'task-uuid-001';
    const userId = 'user-uuid-001';
    const removedBy = 'manager-uuid-001';

    it('should throw ForbiddenError when remover does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        AuditTaskService.unassignUser(taskId, userId, removedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when remover is Internal Auditor', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: removedBy, role: 'Internal Auditor' }),
      });

      await expect(
        AuditTaskService.unassignUser(taskId, userId, removedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when remover is Viewer', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: removedBy, role: 'Viewer' }),
      });

      await expect(
        AuditTaskService.unassignUser(taskId, userId, removedBy)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw NotFoundError when assignment does not exist', async () => {
      // Remover exists with valid role
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: removedBy, role: 'Manager' }),
      });
      // Assignment does not exist
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        AuditTaskService.unassignUser(taskId, userId, removedBy)
      ).rejects.toThrow(NotFoundError);
    });

    it('should successfully unassign user when Manager role', async () => {
      // Remover exists with Manager role
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: removedBy, role: 'Manager' }),
      });
      // Assignment exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'assignment-id' }),
      });
      // Delete
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const result = await AuditTaskService.unassignUser(taskId, userId, removedBy);

      expect(result).toEqual({ success: true });
    });

    it('should successfully unassign user when Admin role', async () => {
      // Remover exists with Admin role
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: removedBy, role: 'Admin' }),
      });
      // Assignment exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'assignment-id' }),
      });
      // Delete
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const result = await AuditTaskService.unassignUser(taskId, userId, removedBy);

      expect(result).toEqual({ success: true });
    });
  });
});

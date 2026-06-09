// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for AuditTaskService (Property 9)
 *
 * Feature: audit-modules-restructure
 *
 * Property 9: Multiple task assignments
 *
 * **Validates: Requirements 4.1, 4.2**
 *
 * For any set of N unique user IDs (1-50), assigning them to a task creates exactly N
 * assignment records. Duplicate user IDs in the input are deduplicated before processing.
 * Attempting to assign an already-assigned user throws a ConflictError.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn(async (fn: Function) => fn()),
    },
  };
});

vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AuditTaskService } from '../AuditTaskService';
import { db } from '../../db/index';
import { ConflictError } from '../../utils/errors';
import { UserRole } from '@alsaqi/shared';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a UUID-like string */
const uuidArb = fc.uuid();

/** Generate a set of 1-50 unique user IDs */
const uniqueUserIdsArb = fc
  .uniqueArray(fc.uuid(), { minLength: 1, maxLength: 50 })
  .filter((arr) => arr.length >= 1);

/** Generate a set of user IDs that may contain duplicates */
const userIdsWithDuplicatesArb = fc
  .tuple(
    fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 25 }),
    fc.nat({ max: 10 })
  )
  .map(([ids, dupCount]) => {
    // Add some duplicates from the existing IDs
    const duplicates = ids.slice(0, Math.min(dupCount, ids.length));
    return [...ids, ...duplicates];
  })
  .filter((arr) => arr.length >= 1 && arr.length <= 50);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 9: Multiple task assignments', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * For any set of N unique user IDs (1-50), assigning them to a task creates
   * exactly N assignment records. Each user gets exactly one assignment record.
   */
  it('assigning N unique users to a task creates exactly N assignment records', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uniqueUserIdsArb,
        uuidArb,
        async (taskId, userIds, assignedById) => {
          vi.clearAllMocks();

          // Setup: assignedBy user exists with Manager role
          mockDb.prepare.mockImplementation((sql: string) => {
            if (sql.includes('SELECT id, role FROM users WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: assignedById, role: UserRole.MANAGER }),
              };
            }
            if (sql.includes('SELECT id FROM audit_tasks WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: taskId }),
              };
            }
            if (sql.includes('SELECT id FROM users WHERE id IN')) {
              return {
                all: vi.fn().mockResolvedValue(userIds.map((id) => ({ id }))),
              };
            }
            if (sql.includes('SELECT id FROM task_assignments WHERE task_id = ? AND user_id = ?')) {
              return {
                get: vi.fn().mockResolvedValue(null), // No existing assignments
              };
            }
            if (sql.includes('INSERT INTO task_assignments')) {
              let callCount = 0;
              return {
                get: vi.fn().mockImplementation((_taskId: string, userId: string, _assignedBy: string) => ({
                  id: `assignment-${callCount++}`,
                  task_id: _taskId,
                  user_id: userId,
                  assigned_at: new Date().toISOString(),
                  assigned_by: _assignedBy,
                })),
              };
            }
            return { get: vi.fn(), all: vi.fn().mockResolvedValue([]) };
          });

          // Mock transaction to just execute the function
          mockDb.transaction.mockImplementation(async (fn: Function) => fn());

          const result = await AuditTaskService.assignUsers(taskId, userIds, assignedById);

          // Must create exactly N assignment records (one per unique user)
          const uniqueCount = new Set(userIds).size;
          expect(result.assignments).toHaveLength(uniqueCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * Duplicate user IDs in the input are deduplicated before processing.
   * The number of assignment records equals the number of unique user IDs.
   */
  it('duplicate user IDs in input are deduplicated, creating records only for unique IDs', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        userIdsWithDuplicatesArb,
        uuidArb,
        async (taskId, userIdsWithDups, assignedById) => {
          vi.clearAllMocks();

          const expectedUniqueIds = [...new Set(userIdsWithDups)];

          // Setup mocks
          mockDb.prepare.mockImplementation((sql: string) => {
            if (sql.includes('SELECT id, role FROM users WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: assignedById, role: UserRole.ADMIN }),
              };
            }
            if (sql.includes('SELECT id FROM audit_tasks WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: taskId }),
              };
            }
            if (sql.includes('SELECT id FROM users WHERE id IN')) {
              return {
                all: vi.fn().mockResolvedValue(expectedUniqueIds.map((id) => ({ id }))),
              };
            }
            if (sql.includes('SELECT id FROM task_assignments WHERE task_id = ? AND user_id = ?')) {
              return {
                get: vi.fn().mockResolvedValue(null),
              };
            }
            if (sql.includes('INSERT INTO task_assignments')) {
              let callCount = 0;
              return {
                get: vi.fn().mockImplementation((_taskId: string, userId: string, _assignedBy: string) => ({
                  id: `assignment-${callCount++}`,
                  task_id: _taskId,
                  user_id: userId,
                  assigned_at: new Date().toISOString(),
                  assigned_by: _assignedBy,
                })),
              };
            }
            return { get: vi.fn(), all: vi.fn().mockResolvedValue([]) };
          });

          mockDb.transaction.mockImplementation(async (fn: Function) => fn());

          const result = await AuditTaskService.assignUsers(taskId, userIdsWithDups, assignedById);

          // Number of assignments must equal number of unique IDs
          expect(result.assignments).toHaveLength(expectedUniqueIds.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * Attempting to assign an already-assigned user throws a ConflictError.
   * The UNIQUE constraint on (task_id, user_id) prevents duplicate assignments.
   */
  it('assigning an already-assigned user throws ConflictError', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        uuidArb,
        async (taskId, userId, assignedById) => {
          vi.clearAllMocks();

          const userIds = [userId];

          // Setup: assignedBy user exists with Manager role
          mockDb.prepare.mockImplementation((sql: string) => {
            if (sql.includes('SELECT id, role FROM users WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: assignedById, role: UserRole.MANAGER }),
              };
            }
            if (sql.includes('SELECT id FROM audit_tasks WHERE id = ?')) {
              return {
                get: vi.fn().mockResolvedValue({ id: taskId }),
              };
            }
            if (sql.includes('SELECT id FROM users WHERE id IN')) {
              return {
                all: vi.fn().mockResolvedValue([{ id: userId }]),
              };
            }
            if (sql.includes('SELECT id FROM task_assignments WHERE task_id = ? AND user_id = ?')) {
              // User is already assigned
              return {
                get: vi.fn().mockResolvedValue({ id: 'existing-assignment-id' }),
              };
            }
            return { get: vi.fn(), all: vi.fn().mockResolvedValue([]) };
          });

          mockDb.transaction.mockImplementation(async (fn: Function) => fn());

          // Must throw ConflictError
          await expect(
            AuditTaskService.assignUsers(taskId, userIds, assignedById)
          ).rejects.toThrow(ConflictError);
        }
      ),
      { numRuns: 100 }
    );
  });
});

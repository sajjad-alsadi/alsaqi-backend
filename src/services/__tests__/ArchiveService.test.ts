// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn(async (fn: Function) => fn()),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ArchiveService } from '../ArchiveService';
import { db } from '../../db/index';
import { N8nService } from '../../utils/n8nService';
import { ValidationError, NotFoundError, ForbiddenError } from '../../utils/errors';

describe('ArchiveService', () => {
  const mockDb = db as any;
  const mockN8n = N8nService as any;

  const planId = 'plan-uuid-123';
  const userId = 'user-uuid-456';

  // Sample plan data
  const samplePlan = {
    id: planId,
    plan_code: 'IA-PL-25-001',
    title: 'خطة التدقيق 2025',
    year: 2025,
    quarter: 'Annual',
    department: 'IT',
    status: 'Closed',
    is_archived: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Role validation', () => {
    it('should throw ForbiddenError when user role is not Manager or Admin', async () => {
      await expect(
        ArchiveService.archivePlan(planId, userId, 'Internal Auditor')
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError for Viewer role', async () => {
      await expect(
        ArchiveService.archivePlan(planId, userId, 'Viewer')
      ).rejects.toThrow(ForbiddenError);
    });

    it('should not throw ForbiddenError for Manager role', async () => {
      // Setup: plan not found (will throw NotFoundError, not ForbiddenError)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow(NotFoundError);
    });

    it('should not throw ForbiddenError for Admin role', async () => {
      // Setup: plan not found (will throw NotFoundError, not ForbiddenError)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Admin')
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('Plan existence validation', () => {
    it('should throw NotFoundError when plan does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when plan is already archived', async () => {
      // First query: plan with is_archived = false → null
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });
      // Second query: plan exists but is_archived = true
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, is_archived: true }),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Admin')
      ).rejects.toThrow('مؤرشفة مسبقاً');
    });
  });

  describe('Open items validation', () => {
    function setupPlanFound() {
      // Plan found (not archived)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(samplePlan),
      });
    }

    it('should throw ValidationError when there are open tasks', async () => {
      setupPlanFound();

      // Open tasks count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 3 }),
      });
      // Task details by status
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          { status: 'in_progress', count: 2 },
          { status: 'draft', count: 1 },
        ]),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow(ValidationError);
    });

    it('should include count and type details in open tasks error', async () => {
      setupPlanFound();

      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 2 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          { status: 'in_progress', count: 2 },
        ]),
      });

      try {
        await ArchiveService.archivePlan(planId, userId, 'Manager');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain('مهمة');
        expect(error.details).toBeDefined();
        expect(error.details.openTasks).toBe(2);
      }
    });

    it('should throw ValidationError when there are open findings', async () => {
      setupPlanFound();

      // No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Open findings count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 1 }),
      });
      // Finding details
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          { status: 'Open', count: 1 },
        ]),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when there are open recommendations', async () => {
      setupPlanFound();

      // No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open findings
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Open recommendations count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 2 }),
      });
      // Recommendation details
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          { status: 'Open', count: 1 },
          { status: 'In Progress', count: 1 },
        ]),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow(ValidationError);
    });

    it('should include count and type details in open recommendations error', async () => {
      setupPlanFound();

      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 3 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          { status: 'Open', count: 2 },
          { status: 'In Progress', count: 1 },
        ]),
      });

      try {
        await ArchiveService.archivePlan(planId, userId, 'Manager');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain('توصية');
        expect(error.details.openRecommendations).toBe(3);
      }
    });
  });

  describe('Successful archive workflow', () => {
    const sampleTasks = [
      { id: 'task-1', plan_id: planId, status: 'completed', title: 'Task 1' },
      { id: 'task-2', plan_id: planId, status: 'completed', title: 'Task 2' },
    ];
    const sampleFindings = [
      { id: 'finding-1', audit_id: planId, status: 'Closed', title: 'Finding 1' },
    ];
    const sampleRecs = [
      { id: 'rec-1', finding_id: 'finding-1', status: 'Implemented' },
    ];
    const sampleEvidence = [
      { id: 'ev-1', audit_id: planId, finding_id: 'finding-1', file_name: 'doc.pdf' },
    ];

    function setupFullArchiveMocks() {
      // 1. Plan found
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(samplePlan),
      });
      // 2. No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // 3. No open findings
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // 4. No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });

      // 5. Archive plan INSERT
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'archived-plan-1', changes: 1 }),
      });

      // 6. Fetch tasks
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(sampleTasks),
      });
      // Archive task 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'at-1', changes: 1 }),
      });
      // Archive task 2
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'at-2', changes: 1 }),
      });

      // 7. Fetch findings
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(sampleFindings),
      });
      // Archive finding 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'af-1', changes: 1 }),
      });

      // 8. Fetch recommendations
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(sampleRecs),
      });
      // Archive rec 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ar-1', changes: 1 }),
      });

      // 9. Fetch evidence
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(sampleEvidence),
      });
      // Archive evidence 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ae-1', changes: 1 }),
      });

      // 10. Verify counts
      // Archived tasks count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 2 }),
      });
      // Archived findings count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 1 }),
      });
      // Archived recommendations count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 1 }),
      });
      // Archived evidence count
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 1 }),
      });

      // 11. Delete evidence
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // Delete recommendations
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // Delete findings
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // Delete tasks
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 2 }),
      });

      // 12. Update plan (mark as archived)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      // 13. Fetch plan year for N8n event (after transaction)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ year: 2025 }),
      });
    }

    it('should complete the full archive workflow successfully', async () => {
      setupFullArchiveMocks();

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).resolves.toBeUndefined();
    });

    it('should send audit_plan.archived event to N8nService', async () => {
      setupFullArchiveMocks();

      await ArchiveService.archivePlan(planId, userId, 'Admin');

      expect(mockN8n.sendEvent).toHaveBeenCalledWith('audit_plan.archived', {
        planId,
        year: 2025,
        archivedBy: userId,
      });
    });

    it('should call db.prepare for archiving plan data as JSONB', async () => {
      setupFullArchiveMocks();

      await ArchiveService.archivePlan(planId, userId, 'Manager');

      // Verify the archive plan INSERT was called
      const calls = mockDb.prepare.mock.calls;
      const archivePlanCall = calls.find(
        (call: any[]) => call[0]?.includes('INSERT INTO archived_plans')
      );
      expect(archivePlanCall).toBeDefined();
    });

    it('should delete data in correct FK order: evidence → recommendations → findings → tasks', async () => {
      setupFullArchiveMocks();

      await ArchiveService.archivePlan(planId, userId, 'Manager');

      const calls = mockDb.prepare.mock.calls.map((c: any[]) => c[0]);

      const deleteEvidenceIdx = calls.findIndex((sql: string) =>
        sql?.includes('DELETE FROM audit_evidence')
      );
      const deleteRecsIdx = calls.findIndex((sql: string) =>
        sql?.includes('DELETE FROM recommendations')
      );
      const deleteFindingsIdx = calls.findIndex((sql: string) =>
        sql?.includes('DELETE FROM audit_findings')
      );
      const deleteTasksIdx = calls.findIndex((sql: string) =>
        sql?.includes('DELETE FROM audit_tasks')
      );

      expect(deleteEvidenceIdx).toBeLessThan(deleteRecsIdx);
      expect(deleteRecsIdx).toBeLessThan(deleteFindingsIdx);
      expect(deleteFindingsIdx).toBeLessThan(deleteTasksIdx);
    });

    it('should mark plan as archived with correct status', async () => {
      setupFullArchiveMocks();

      await ArchiveService.archivePlan(planId, userId, 'Manager');

      const calls = mockDb.prepare.mock.calls;
      const updateCall = calls.find(
        (call: any[]) => call[0]?.includes('UPDATE audit_plans SET is_archived = true')
      );
      expect(updateCall).toBeDefined();
    });
  });

  describe('Copy verification', () => {
    function setupVerificationFailureMocks(mismatchType: 'tasks' | 'findings' | 'recs' | 'evidence') {
      // Plan found
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(samplePlan),
      });
      // No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open findings
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });

      // Archive plan INSERT
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ap-1', changes: 1 }),
      });

      // Fetch tasks (2 tasks)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]),
      });
      // Archive task 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'at-1', changes: 1 }),
      });
      // Archive task 2
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'at-2', changes: 1 }),
      });

      // Fetch findings (1 finding)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'f1' }]),
      });
      // Archive finding 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'af-1', changes: 1 }),
      });

      // Fetch recommendations (1 rec)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'r1' }]),
      });
      // Archive rec 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ar-1', changes: 1 }),
      });

      // Fetch evidence (1 evidence)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'e1' }]),
      });
      // Archive evidence 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ae-1', changes: 1 }),
      });

      // Verification counts - set mismatch based on type
      const taskCount = mismatchType === 'tasks' ? 1 : 2; // expected 2
      const findingCount = mismatchType === 'findings' ? 0 : 1; // expected 1
      const recCount = mismatchType === 'recs' ? 0 : 1; // expected 1
      const evidenceCount = mismatchType === 'evidence' ? 0 : 1; // expected 1

      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: taskCount }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: findingCount }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: recCount }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: evidenceCount }),
      });
    }

    it('should throw error when archived task count does not match', async () => {
      setupVerificationFailureMocks('tasks');

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow('نسخ المهام');
    });

    it('should throw error when archived finding count does not match', async () => {
      setupVerificationFailureMocks('findings');

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow('نسخ الملاحظات');
    });

    it('should throw error when archived recommendation count does not match', async () => {
      setupVerificationFailureMocks('recs');

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow('نسخ التوصيات');
    });

    it('should throw error when archived evidence count does not match', async () => {
      setupVerificationFailureMocks('evidence');

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).rejects.toThrow('نسخ الأدلة');
    });
  });

  describe('N8n event retry logic', () => {
    function setupSuccessfulArchiveMocks() {
      // Plan found
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(samplePlan),
      });
      // No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open findings
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Archive plan
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ap-1', changes: 1 }),
      });
      // No tasks
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // No findings
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // No recommendations
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // No evidence
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Verify counts (all 0)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Delete evidence (no-op)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      // Delete recommendations (no-op)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      // Delete findings (no-op)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      // Delete tasks (no-op)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      // Update plan
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // Fetch plan year for event
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ year: 2025 }),
      });
    }

    it('should retry N8n event up to 3 times on failure', async () => {
      setupSuccessfulArchiveMocks();

      mockN8n.sendEvent
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce(undefined);

      // Should not throw even though first 2 attempts fail
      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).resolves.toBeUndefined();

      expect(mockN8n.sendEvent).toHaveBeenCalledTimes(3);
    });

    it('should succeed on first N8n attempt without retrying', async () => {
      setupSuccessfulArchiveMocks();

      await ArchiveService.archivePlan(planId, userId, 'Manager');

      expect(mockN8n.sendEvent).toHaveBeenCalledTimes(1);
    });

    it('should not throw when all N8n retries fail (archive stays intact)', async () => {
      setupSuccessfulArchiveMocks();

      mockN8n.sendEvent
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'));

      // Should not throw - archive is already complete
      await expect(
        ArchiveService.archivePlan(planId, userId, 'Manager')
      ).resolves.toBeUndefined();

      expect(mockN8n.sendEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe('Empty plan archive', () => {
    it('should successfully archive a plan with no tasks, findings, or evidence', async () => {
      // Plan found
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(samplePlan),
      });
      // No open tasks
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open findings
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Archive plan
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'ap-1', changes: 1 }),
      });
      // Empty tasks
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Empty findings
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Empty recommendations
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Empty evidence
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Verify counts (all 0)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // Delete operations (no-op)
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      });
      // Update plan
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // Fetch plan year for event
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ year: 2025 }),
      });

      await expect(
        ArchiveService.archivePlan(planId, userId, 'Admin')
      ).resolves.toBeUndefined();
    });
  });
});

// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn()),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

// Mock NumberingService
vi.mock('../NumberingService', () => ({
  NumberingService: {
    nextFindingNumber: vi.fn(),
    nextRecommendationNumber: vi.fn(),
  },
}));

// Mock NotificationService
vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
    getAdminIds: vi.fn().mockResolvedValue(['admin-id-1']),
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock PermissionService. Task 4.5 authorizes the Pending Approval→Closed
// APPROVE gate in changeFindingStatus against the user's EFFECTIVE DB
// permissions via PermissionService.getUserPermissions(userId) rather than the
// static DEFAULT_PERMISSIONS map. Mocking it here keeps the sequential `db`
// mock in sync (the real service would issue extra db.prepare reads) and lets
// each scenario declare whether APPROVE is effectively granted.
vi.mock('../PermissionService', () => ({
  PermissionService: {
    getUserPermissions: vi.fn(),
  },
}));

import { AuditService, CreateFindingInput, ALLOWED_FINDING_TRANSITIONS, FINDING_TO_RECOMMENDATION_STATUS } from '../AuditService';
import { NumberingService } from '../NumberingService';
import { NotificationService } from '../NotificationService';
import { N8nService } from '../../utils/n8nService';
import { PermissionService } from '../PermissionService';
import { db } from '../../db/index';
import { ValidationError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { UserRole } from '@alsaqi/shared';
import { MODULES, PERMISSIONS } from '../../permissions.js';

/** Build an effective-permission set granting the given audit-findings actions. */
function effectiveFindingPermissions(actions: string[]) {
  return {
    userId: 'user-uuid-123',
    role: 'Test',
    roleId: 'role-1',
    isCustomRole: false,
    permissions: { [MODULES.AUDIT_FINDINGS]: actions },
    overrides: [],
  } as any;
}

describe('AuditService', () => {
  const mockDb = db as any;
  const userId = 'user-uuid-123';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: user has APPROVE on audit findings (overridden per-test where a
    // forbidden scenario is exercised). Only consulted on Pending Approval→Closed.
    (PermissionService.getUserPermissions as any).mockResolvedValue(
      effectiveFindingPermissions([PERMISSIONS.APPROVE])
    );
  });

  describe('createFinding', () => {
    const validInput: CreateFindingInput = {
      audit_id: 'plan-uuid-001',
      title: 'Test Finding Title',
      description: 'Some description',
      criteria: 'Some criteria',
      condition: 'Some condition',
      finding_type: 'control_design_deficiency',
      consequence: 'Some consequence',
      risk_level: 'High',
    };

    function setupSuccessMocks() {
      // Plan query
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'plan-uuid-001',
          plan_code: 'IA-PL-25-001',
          department: 'IT',
          is_archived: false,
        }),
      });

      (NumberingService.nextFindingNumber as any).mockResolvedValue('IA-PL-25-001-F01');

      // INSERT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'finding-uuid-001' }),
      });

      (NumberingService.nextRecommendationNumber as any).mockResolvedValue('IA-PL-25-001-F01-R01');

      // INSERT recommendation
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'rec-uuid-001' }),
      });

      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'manager-id-1' }]),
      });
    }

    // --- Title Validation ---

    it('should throw ValidationError when title is empty string', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, title: '' }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when title is whitespace only', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, title: '   ' }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when title is undefined/null', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, title: undefined as any }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when title exceeds 200 characters', async () => {
      const longTitle = 'a'.repeat(201);
      await expect(
        AuditService.createFinding({ ...validInput, title: longTitle }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should accept title with exactly 200 characters', async () => {
      setupSuccessMocks();
      const title200 = 'a'.repeat(200);
      const result = await AuditService.createFinding({ ...validInput, title: title200 }, userId);
      expect(result.findingId).toBeDefined();
    });

    // --- Finding Type Validation ---

    it('should throw ValidationError for invalid finding_type', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, finding_type: 'invalid_type' as any }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when finding_type is empty', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, finding_type: '' as any }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when finding_type is undefined', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, finding_type: undefined as any }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should accept control_design_deficiency as finding_type', async () => {
      setupSuccessMocks();
      const result = await AuditService.createFinding(
        { ...validInput, finding_type: 'control_design_deficiency' },
        userId
      );
      expect(result.findingId).toBeDefined();
    });

    it('should accept operational_design_deficiency as finding_type', async () => {
      setupSuccessMocks();
      const result = await AuditService.createFinding(
        { ...validInput, finding_type: 'operational_design_deficiency' },
        userId
      );
      expect(result.findingId).toBeDefined();
    });

    // --- Audit ID Validation ---

    it('should throw ValidationError when audit_id is missing', async () => {
      await expect(
        AuditService.createFinding({ ...validInput, audit_id: '' }, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw NotFoundError when plan does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        AuditService.createFinding(validInput, userId)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when plan is archived', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'plan-uuid-001',
          plan_code: 'IA-PL-25-001',
          department: 'IT',
          is_archived: true,
        }),
      });

      await expect(
        AuditService.createFinding(validInput, userId)
      ).rejects.toThrow(ValidationError);
    });

    // --- Successful Creation ---

    it('should create finding with status Open', async () => {
      setupSuccessMocks();
      const result = await AuditService.createFinding(validInput, userId);

      expect(result.findingId).toBe('finding-uuid-001');
      expect(result.recommendationId).toBe('rec-uuid-001');
    });

    it('should generate finding_number via NumberingService', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      expect(NumberingService.nextFindingNumber).toHaveBeenCalledWith('plan-uuid-001', 'IA-PL-25-001');
    });

    it('should generate rec_number via NumberingService', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      expect(NumberingService.nextRecommendationNumber).toHaveBeenCalledWith('finding-uuid-001', 'IA-PL-25-001-F01');
    });

    it('should auto-create recommendation with same risk_level and status Open', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      // The recommendation INSERT is the 3rd db.prepare call (after plan query and finding INSERT)
      const recInsertCall = mockDb.prepare.mock.calls[2];
      const recInsertSql = recInsertCall[0];
      expect(recInsertSql).toContain('INSERT INTO recommendations');
      expect(recInsertSql).toContain("'Open'");
    });

    it('should record created_by with the userId', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      // The finding INSERT is the 2nd db.prepare call
      const findingInsertCall = mockDb.prepare.mock.calls[1];
      const findingInsertSql = findingInsertCall[0];
      expect(findingInsertSql).toContain('created_by');
    });

    // --- Notifications ---

    it('should send notification to Manager/Admin users', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      expect(NotificationService.getAdminIds).toHaveBeenCalled();
      expect(NotificationService.create).toHaveBeenCalledWith(
        expect.arrayContaining(['admin-id-1']),
        'finding_added',
        expect.stringContaining('findingAdded'),
        'AuditFindings',
        '/audit-findings',
        expect.objectContaining({ actorId: userId })
      );
    });

    it('should send n8n event on finding creation', async () => {
      setupSuccessMocks();
      await AuditService.createFinding(validInput, userId);

      expect(N8nService.sendEvent).toHaveBeenCalledWith('finding.created', {
        findingId: 'finding-uuid-001',
        title: 'Test Finding Title',
        auditId: 'plan-uuid-001',
        riskLevel: 'High',
        findingType: 'control_design_deficiency',
      });
    });

    it('should not fail if notification throws', async () => {
      // Plan query
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'plan-uuid-001',
          plan_code: 'IA-PL-25-001',
          department: 'IT',
          is_archived: false,
        }),
      });

      (NumberingService.nextFindingNumber as any).mockResolvedValue('IA-PL-25-001-F01');

      // INSERT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'finding-uuid-001' }),
      });

      (NumberingService.nextRecommendationNumber as any).mockResolvedValue('IA-PL-25-001-F01-R01');

      // INSERT recommendation
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'rec-uuid-001' }),
      });

      // Manager query throws
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      // Should still succeed
      const result = await AuditService.createFinding(validInput, userId);
      expect(result.findingId).toBe('finding-uuid-001');
    });

    it('should trim title before storing', async () => {
      setupSuccessMocks();
      await AuditService.createFinding({ ...validInput, title: '  Trimmed Title  ' }, userId);

      // The finding INSERT call should have trimmed title
      const findingInsertGetCall = mockDb.prepare.mock.results[1].value.get;
      // Check that the get was called with trimmed title as 3rd argument
      const callArgs = findingInsertGetCall.mock.calls[0];
      expect(callArgs[2]).toBe('Trimmed Title');
    });
  });

  describe('updateFinding', () => {
    const findingId = 'finding-uuid-001';
    const ownerId = 'owner-uuid-123';
    const otherUserId = 'other-uuid-456';

    it('should throw NotFoundError when finding does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        AuditService.updateFinding(findingId, { title: 'Updated' }, ownerId)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ForbiddenError when non-owner attempts to edit', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      await expect(
        AuditService.updateFinding(findingId, { title: 'Updated' }, otherUserId)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should allow the owner to edit the finding', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      // UPDATE audit_findings
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        AuditService.updateFinding(findingId, { title: 'Updated Title' }, ownerId)
      ).resolves.not.toThrow();
    });

    it('should throw ValidationError when no data is provided', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      await expect(
        AuditService.updateFinding(findingId, {}, ownerId)
      ).rejects.toThrow(ValidationError);
    });

    it('should sync risk_level change to associated recommendation', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      // UPDATE audit_findings
      const updateFindingRun = vi.fn().mockResolvedValue(undefined);
      mockDb.prepare.mockReturnValueOnce({
        run: updateFindingRun,
      });

      // UPDATE recommendations (risk_level sync)
      const updateRecRun = vi.fn().mockResolvedValue(undefined);
      mockDb.prepare.mockReturnValueOnce({
        run: updateRecRun,
      });

      await AuditService.updateFinding(findingId, { risk_level: 'Critical' }, ownerId);

      // Verify the recommendation update was called with the new risk_level
      expect(updateRecRun).toHaveBeenCalledWith('Critical', findingId);
    });

    it('should not sync risk_level when it is not in the update body', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      // UPDATE audit_findings
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });

      await AuditService.updateFinding(findingId, { title: 'New Title' }, ownerId);

      // Only 2 db.prepare calls: SELECT finding + UPDATE finding (no recommendation update)
      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
    });

    it('should prevent overwriting created_by field', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      // UPDATE audit_findings
      const updateRun = vi.fn().mockResolvedValue(undefined);
      mockDb.prepare.mockReturnValueOnce({
        run: updateRun,
      });

      await AuditService.updateFinding(findingId, { title: 'Updated', created_by: 'hacker-id' }, ownerId);

      // The UPDATE SQL should not include created_by
      const updateSql = mockDb.prepare.mock.calls[1][0];
      expect(updateSql).not.toContain('created_by');
    });

    it('should send n8n event after successful update', async () => {
      // SELECT finding for ownership check
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: findingId, created_by: ownerId }),
      });

      // UPDATE audit_findings
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });

      await AuditService.updateFinding(findingId, { title: 'Updated' }, ownerId);

      expect(N8nService.sendEvent).toHaveBeenCalledWith('finding.updated', {
        findingId,
        updates: { title: 'Updated' },
      });
    });
  });

  describe('changeFindingStatus', () => {
    const findingId = 'finding-uuid-001';
    const userId = 'user-uuid-123';

    const baseFinding = {
      id: findingId,
      title: 'Test Finding',
      status: 'Open',
      created_by: userId,
    };

    function setupStatusChangeMocks(finding: any, options?: { recSyncFail?: boolean; recSyncFailCount?: number }) {
      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(finding),
      });

      // UPDATE audit_findings SET status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });

      // UPDATE recommendations SET status (sync)
      if (options?.recSyncFail) {
        const failCount = options.recSyncFailCount ?? 3;
        for (let i = 0; i < failCount; i++) {
          mockDb.prepare.mockReturnValueOnce({
            run: vi.fn().mockRejectedValue(new Error('DB sync error')),
          });
        }
        // If not all fail, add a success
        if (failCount < 3) {
          mockDb.prepare.mockReturnValueOnce({
            run: vi.fn().mockResolvedValue(undefined),
          });
        }
      } else {
        mockDb.prepare.mockReturnValueOnce({
          run: vi.fn().mockResolvedValue(undefined),
        });
      }

      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'manager-id-1' }]),
      });
    }

    // --- Finding existence validation ---

    it('should throw NotFoundError when finding does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(NotFoundError);
    });

    // --- Allowed transitions ---

    it('should allow Open → In Progress', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'Open' });

      const result = await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);
      expect(result.syncSuccess).toBe(true);
    });

    it('should allow In Progress → Closed', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'In Progress' });

      const result = await AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.ADMIN);
      expect(result.syncSuccess).toBe(true);
    });

    it('should allow In Progress → Pending Approval', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'In Progress' });

      const result = await AuditService.changeFindingStatus(findingId, 'Pending Approval', userId, UserRole.INTERNAL_AUDITOR);
      expect(result.syncSuccess).toBe(true);
    });

    it('should allow Pending Approval → Closed with APPROVE permission', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'Pending Approval' });

      const result = await AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.ADMIN);
      expect(result.syncSuccess).toBe(true);
    });

    it('should allow Pending Approval → In Progress', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'Pending Approval' });

      const result = await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.MANAGER);
      expect(result.syncSuccess).toBe(true);
    });

    // --- Disallowed transitions ---

    it('should throw ValidationError for Open → Closed (invalid transition)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });

      await expect(
        AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.ADMIN)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for Open → Pending Approval (invalid transition)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });

      await expect(
        AuditService.changeFindingStatus(findingId, 'Pending Approval', userId, UserRole.ADMIN)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for Closed → any (no transitions from Closed)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Closed' }),
      });

      await expect(
        AuditService.changeFindingStatus(findingId, 'Open', userId, UserRole.ADMIN)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for In Progress → Open (invalid transition)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'In Progress' }),
      });

      await expect(
        AuditService.changeFindingStatus(findingId, 'Open', userId, UserRole.ADMIN)
      ).rejects.toThrow(ValidationError);
    });

    // --- APPROVE permission for Pending Approval → Closed ---

    it('should throw ForbiddenError when user lacks APPROVE permission for Pending Approval → Closed', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Pending Approval' }),
      });
      (PermissionService.getUserPermissions as any).mockResolvedValueOnce(effectiveFindingPermissions([]));

      await expect(
        AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should allow Manager to approve Pending Approval → Closed', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'Pending Approval' });

      const result = await AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.MANAGER);
      expect(result.syncSuccess).toBe(true);
    });

    // --- Recommendation status sync ---

    it('should sync recommendation status to "In Progress" when finding moves to In Progress', async () => {
      const recUpdateRun = vi.fn().mockResolvedValue(undefined);

      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // UPDATE recommendation status
      mockDb.prepare.mockReturnValueOnce({
        run: recUpdateRun,
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);

      expect(recUpdateRun).toHaveBeenCalledWith('In Progress', findingId);
    });

    it('should sync recommendation status to "Implemented" when finding moves to Closed', async () => {
      const recUpdateRun = vi.fn().mockResolvedValue(undefined);

      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'In Progress' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // UPDATE recommendation status
      mockDb.prepare.mockReturnValueOnce({
        run: recUpdateRun,
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await AuditService.changeFindingStatus(findingId, 'Closed', userId, UserRole.ADMIN);

      expect(recUpdateRun).toHaveBeenCalledWith('Implemented', findingId);
    });

    it('should sync recommendation status to "In Progress" when finding moves to Pending Approval', async () => {
      const recUpdateRun = vi.fn().mockResolvedValue(undefined);

      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'In Progress' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // UPDATE recommendation status
      mockDb.prepare.mockReturnValueOnce({
        run: recUpdateRun,
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await AuditService.changeFindingStatus(findingId, 'Pending Approval', userId, UserRole.INTERNAL_AUDITOR);

      expect(recUpdateRun).toHaveBeenCalledWith('In Progress', findingId);
    });

    // --- Retry logic for sync failures ---

    it('should retry recommendation sync up to 3 times on failure', async () => {
      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // 3 failed sync attempts
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error 1')),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error 2')),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error 3')),
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);

      // syncSuccess should be false when all retries fail
      expect(result.syncSuccess).toBe(false);
    });

    it('should succeed on second retry attempt', async () => {
      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // First sync attempt fails
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      // Second sync attempt succeeds
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);

      expect(result.syncSuccess).toBe(true);
    });

    it('should keep finding status changed even when all sync retries fail', async () => {
      const findingUpdateRun = vi.fn().mockResolvedValue(undefined);

      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: findingUpdateRun,
      });
      // 3 failed sync attempts
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      // Manager query for notifications
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);

      // Finding status update should still have been called
      expect(findingUpdateRun).toHaveBeenCalledWith('In Progress', findingId);
    });

    // --- Notification on status change ---

    it('should send notification to Manager/Admin on status change', async () => {
      setupStatusChangeMocks({ ...baseFinding, status: 'Open' });

      await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);

      expect(NotificationService.getAdminIds).toHaveBeenCalled();
      expect(NotificationService.create).toHaveBeenCalledWith(
        expect.arrayContaining(['admin-id-1', 'manager-id-1']),
        'finding_status_changed',
        expect.stringContaining('findingStatusChanged'),
        'AuditFindings',
        '/audit-findings',
        expect.objectContaining({ actorId: userId, entityId: findingId })
      );
    });

    it('should not throw if notification fails', async () => {
      // SELECT finding
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ ...baseFinding, status: 'Open' }),
      });
      // UPDATE finding status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // UPDATE recommendation status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue(undefined),
      });
      // Manager query throws
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockRejectedValue(new Error('Notification DB error')),
      });

      // Should not throw
      const result = await AuditService.changeFindingStatus(findingId, 'In Progress', userId, UserRole.INTERNAL_AUDITOR);
      expect(result.syncSuccess).toBe(true);
    });
  });
});

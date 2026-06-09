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

import { AuditService, ALLOWED_FINDING_TRANSITIONS, FINDING_TO_RECOMMENDATION_STATUS } from '../AuditService';
import { NotificationService } from '../NotificationService';
import { db } from '../../db/index';
import { ValidationError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { UserRole } from '@alsaqi/shared';

describe('AuditService.changeFindingStatus', () => {
  const mockDb = db as any;
  const userId = 'user-uuid-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockFinding(status: string) {
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({
        id: 'finding-uuid-001',
        title: 'Test Finding',
        status,
        audit_id: 'plan-uuid-001',
        created_by: userId,
      }),
    });
  }

  function mockUpdateFinding() {
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(undefined),
    });
  }

  function mockRecommendationSync() {
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(undefined),
    });
  }

  function mockManagerQuery() {
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockResolvedValue([{ id: 'manager-id-1' }]),
    });
  }

  // --- Finding Not Found ---

  it('should throw NotFoundError when finding does not exist', async () => {
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(null),
    });

    await expect(
      AuditService.changeFindingStatus('non-existent-id', 'In Progress', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(NotFoundError);
  });

  // --- Invalid Transitions ---

  it('should throw ValidationError for Open→Closed (invalid transition)', async () => {
    mockFinding('Open');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Closed', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for Open→Pending Approval (invalid transition)', async () => {
    mockFinding('Open');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Pending Approval', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for Closed→Open (invalid transition)', async () => {
    mockFinding('Closed');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Open', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for Closed→In Progress (invalid transition)', async () => {
    mockFinding('Closed');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError for In Progress→Open (invalid transition)', async () => {
    mockFinding('In Progress');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Open', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ValidationError);
  });

  // --- Valid Transitions ---

  it('should allow Open→In Progress transition', async () => {
    mockFinding('Open');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(true);
  });

  it('should allow In Progress→Closed transition', async () => {
    mockFinding('In Progress');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Closed', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(true);
  });

  it('should allow In Progress→Pending Approval transition', async () => {
    mockFinding('In Progress');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Pending Approval', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(true);
  });

  it('should allow Pending Approval→In Progress transition', async () => {
    mockFinding('Pending Approval');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.MANAGER
    );

    expect(result.syncSuccess).toBe(true);
  });

  it('should allow Pending Approval→Closed with APPROVE permission (Manager)', async () => {
    mockFinding('Pending Approval');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Closed', userId, UserRole.MANAGER
    );

    expect(result.syncSuccess).toBe(true);
  });

  it('should allow Pending Approval→Closed with APPROVE permission (Admin)', async () => {
    mockFinding('Pending Approval');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Closed', userId, UserRole.ADMIN
    );

    expect(result.syncSuccess).toBe(true);
  });

  // --- APPROVE Permission Check ---

  it('should throw ForbiddenError for Pending Approval→Closed without APPROVE permission (Internal Auditor)', async () => {
    mockFinding('Pending Approval');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Closed', userId, UserRole.INTERNAL_AUDITOR)
    ).rejects.toThrow(ForbiddenError);
  });

  it('should throw ForbiddenError for Pending Approval→Closed without APPROVE permission (Viewer)', async () => {
    mockFinding('Pending Approval');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Closed', userId, UserRole.VIEWER)
    ).rejects.toThrow(ForbiddenError);
  });

  it('should throw ForbiddenError for Pending Approval→Closed without APPROVE permission (Compliance Officer)', async () => {
    mockFinding('Pending Approval');

    await expect(
      AuditService.changeFindingStatus('finding-uuid-001', 'Closed', userId, UserRole.COMPLIANCE_OFFICER)
    ).rejects.toThrow(ForbiddenError);
  });

  // --- Recommendation Sync ---

  it('should sync recommendation status to "In Progress" when finding moves to In Progress', async () => {
    mockFinding('Open');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    // The recommendation sync is the 3rd db.prepare call (after finding query and finding update)
    const recSyncCall = mockDb.prepare.mock.calls[2];
    expect(recSyncCall[0]).toContain('UPDATE recommendations');
    const runCall = mockDb.prepare.mock.results[2].value.run;
    expect(runCall).toHaveBeenCalledWith('In Progress', 'finding-uuid-001');
  });

  it('should sync recommendation status to "Implemented" when finding moves to Closed', async () => {
    mockFinding('In Progress');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Closed', userId, UserRole.INTERNAL_AUDITOR
    );

    const recSyncCall = mockDb.prepare.mock.calls[2];
    expect(recSyncCall[0]).toContain('UPDATE recommendations');
    const runCall = mockDb.prepare.mock.results[2].value.run;
    expect(runCall).toHaveBeenCalledWith('Implemented', 'finding-uuid-001');
  });

  it('should sync recommendation status to "In Progress" when finding moves to Pending Approval', async () => {
    mockFinding('In Progress');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    await AuditService.changeFindingStatus(
      'finding-uuid-001', 'Pending Approval', userId, UserRole.INTERNAL_AUDITOR
    );

    const recSyncCall = mockDb.prepare.mock.calls[2];
    expect(recSyncCall[0]).toContain('UPDATE recommendations');
    const runCall = mockDb.prepare.mock.results[2].value.run;
    expect(runCall).toHaveBeenCalledWith('In Progress', 'finding-uuid-001');
  });

  // --- Retry Logic ---

  it('should retry recommendation sync up to 3 times on failure', async () => {
    mockFinding('Open');
    mockUpdateFinding();

    // All 3 attempts fail
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockRejectedValue(new Error('DB error 1')),
    });
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockRejectedValue(new Error('DB error 2')),
    });
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockRejectedValue(new Error('DB error 3')),
    });

    // Manager query for notification
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(false);
  });

  it('should succeed on second retry attempt', async () => {
    mockFinding('Open');
    mockUpdateFinding();

    // First attempt fails
    mockDb.prepare.mockReturnValueOnce({
      run: vi.fn().mockRejectedValue(new Error('DB error')),
    });
    // Second attempt succeeds
    mockRecommendationSync();

    // Manager query for notification
    mockManagerQuery();

    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(true);
  });

  // --- Notification ---

  it('should send notification to Manager/Admin on status change', async () => {
    mockFinding('Open');
    mockUpdateFinding();
    mockRecommendationSync();
    mockManagerQuery();

    await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(NotificationService.getAdminIds).toHaveBeenCalled();
    expect(NotificationService.create).toHaveBeenCalledWith(
      expect.arrayContaining(['admin-id-1', 'manager-id-1']),
      'finding_status_changed',
      expect.stringContaining('findingStatusChanged'),
      'AuditFindings',
      '/audit-findings',
      expect.objectContaining({ actorId: userId, entityId: 'finding-uuid-001' })
    );
  });

  it('should not fail if notification throws', async () => {
    mockFinding('Open');
    mockUpdateFinding();
    mockRecommendationSync();

    // Manager query throws
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockRejectedValue(new Error('Notification DB error')),
    });

    // Should still succeed
    const result = await AuditService.changeFindingStatus(
      'finding-uuid-001', 'In Progress', userId, UserRole.INTERNAL_AUDITOR
    );

    expect(result.syncSuccess).toBe(true);
  });

  // --- Exported Constants ---

  it('should export ALLOWED_FINDING_TRANSITIONS with correct structure', () => {
    expect(ALLOWED_FINDING_TRANSITIONS['Open']).toEqual(['In Progress']);
    expect(ALLOWED_FINDING_TRANSITIONS['In Progress']).toEqual(['Closed', 'Pending Approval']);
    expect(ALLOWED_FINDING_TRANSITIONS['Pending Approval']).toEqual(['Closed', 'In Progress']);
    expect(ALLOWED_FINDING_TRANSITIONS['Closed']).toEqual([]);
  });

  it('should export FINDING_TO_RECOMMENDATION_STATUS with correct mapping', () => {
    expect(FINDING_TO_RECOMMENDATION_STATUS['Open']).toBe('Open');
    expect(FINDING_TO_RECOMMENDATION_STATUS['In Progress']).toBe('In Progress');
    expect(FINDING_TO_RECOMMENDATION_STATUS['Closed']).toBe('Implemented');
    expect(FINDING_TO_RECOMMENDATION_STATUS['Pending Approval']).toBe('In Progress');
  });
});

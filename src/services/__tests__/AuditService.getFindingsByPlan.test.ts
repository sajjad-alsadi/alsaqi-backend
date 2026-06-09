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

import { AuditService } from '../AuditService';
import { db } from '../../db/index';
import { NotFoundError } from '../../utils/errors';

describe('AuditService.getFindingsByPlan', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw NotFoundError when planId is empty', async () => {
    await expect(AuditService.getFindingsByPlan('')).rejects.toThrow(NotFoundError);
  });

  it('should throw NotFoundError when plan does not exist', async () => {
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(null),
    });

    await expect(AuditService.getFindingsByPlan('non-existent-plan-id')).rejects.toThrow(NotFoundError);
  });

  it('should return findings for an existing plan', async () => {
    const planId = 'plan-uuid-001';
    const mockFindings = [
      { id: 'finding-1', audit_id: planId, title: 'Finding 1', status: 'Open' },
      { id: 'finding-2', audit_id: planId, title: 'Finding 2', status: 'Closed' },
    ];

    // Plan exists query
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ id: planId }),
    });

    // Findings query
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockResolvedValue(mockFindings),
    });

    const result = await AuditService.getFindingsByPlan(planId);

    expect(result).toEqual(mockFindings);
    expect(result).toHaveLength(2);
  });

  it('should return empty array when plan exists but has no findings', async () => {
    const planId = 'plan-uuid-002';

    // Plan exists query
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ id: planId }),
    });

    // Findings query - empty
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockResolvedValue([]),
    });

    const result = await AuditService.getFindingsByPlan(planId);

    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it('should only return findings for the specified plan', async () => {
    const planId = 'plan-uuid-001';
    const mockFindings = [
      { id: 'finding-1', audit_id: planId, title: 'Finding 1' },
    ];

    // Plan exists query
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ id: planId }),
    });

    // Findings query
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockResolvedValue(mockFindings),
    });

    const result = await AuditService.getFindingsByPlan(planId);

    // Verify the SQL query filters by audit_id
    const findingsQueryCall = mockDb.prepare.mock.calls[1][0];
    expect(findingsQueryCall).toContain('WHERE audit_id = ?');

    // Verify the planId was passed as argument
    const allFn = mockDb.prepare.mock.results[1].value.all;
    expect(allFn).toHaveBeenCalledWith(planId);
  });

  it('should validate plan existence before querying findings', async () => {
    const planId = 'plan-uuid-001';

    // Plan does not exist
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(null),
    });

    await expect(AuditService.getFindingsByPlan(planId)).rejects.toThrow(NotFoundError);

    // Should only have called prepare once (for plan check), not for findings
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
  });
});

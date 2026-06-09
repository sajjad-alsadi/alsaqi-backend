// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for AuditService - Finding Edit Ownership (Property 5)
 *
 * Feature: audit-modules-restructure
 *
 * Property 5: Finding edit ownership
 *
 * **Validates: Requirements 6.4**
 *
 * For any finding with created_by=X, if a user Y (where Y≠X) attempts to edit
 * the finding, updateFinding must throw ForbiddenError. If user X (the creator)
 * attempts to edit, it should succeed.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

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

vi.mock('../NumberingService', () => ({
  NumberingService: {
    nextFindingNumber: vi.fn(),
    nextRecommendationNumber: vi.fn(),
  },
}));

vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
    getAdminIds: vi.fn().mockResolvedValue(['admin-id-1']),
  },
}));

vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AuditService } from '../AuditService';
import { db } from '../../db/index';
import { ForbiddenError } from '../../utils/errors';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for valid UUIDs */
const uuidArb = fc.uuid();

/** Arbitrary for non-empty update body with at least one valid field */
const updateBodyArb = fc.record({
  title: fc.option(fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0), { nil: undefined }),
  description: fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: undefined }),
  risk_level: fc.option(fc.constantFrom('Low', 'Medium', 'High', 'Critical'), { nil: undefined }),
}).filter((body) => {
  // Ensure at least one field is defined
  return Object.values(body).some((v) => v !== undefined);
});

/** Arbitrary for a pair of distinct user IDs (creator and non-creator) */
const distinctUserPairArb = fc.tuple(uuidArb, uuidArb).filter(([a, b]) => a !== b);

// ─── Helper ──────────────────────────────────────────────────────────────────

function setupFindingQueryMock(mockDb: any, findingId: string, createdBy: string) {
  // SELECT finding to check ownership
  mockDb.prepare.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: findingId,
      created_by: createdBy,
    }),
  });
}

function setupSuccessfulUpdateMocks(mockDb: any) {
  // UPDATE audit_findings
  mockDb.prepare.mockReturnValueOnce({
    run: vi.fn().mockResolvedValue(undefined),
  });

  // UPDATE recommendations (for risk_level sync)
  mockDb.prepare.mockReturnValueOnce({
    run: vi.fn().mockResolvedValue(undefined),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 5: Finding edit ownership', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For any finding with created_by=X, if a user Y (where Y≠X) attempts to edit
   * the finding, updateFinding must throw ForbiddenError.
   */
  it('non-creator user is always rejected with ForbiddenError', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        distinctUserPairArb,
        updateBodyArb,
        async (findingId, [creatorId, nonCreatorId], body) => {
          vi.clearAllMocks();
          mockDb.prepare.mockReset();

          // Setup: finding exists with created_by = creatorId
          setupFindingQueryMock(mockDb, findingId, creatorId);

          // Act: non-creator attempts to edit
          await expect(
            AuditService.updateFinding(findingId, body, nonCreatorId)
          ).rejects.toThrow(ForbiddenError);

          // Verify: only the SELECT query was made, no UPDATE
          expect(mockDb.prepare).toHaveBeenCalledTimes(1);
          const selectCall = mockDb.prepare.mock.calls[0][0];
          expect(selectCall).toContain('SELECT');
          expect(selectCall).not.toContain('UPDATE');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For any finding with created_by=X, if user X (the creator) attempts to edit,
   * the operation should succeed without throwing.
   */
  it('creator user can always edit their own finding successfully', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        updateBodyArb,
        async (findingId, creatorId, body) => {
          vi.clearAllMocks();
          mockDb.prepare.mockReset();

          // Setup: finding exists with created_by = creatorId
          setupFindingQueryMock(mockDb, findingId, creatorId);
          setupSuccessfulUpdateMocks(mockDb);

          // Act: creator attempts to edit - should NOT throw
          await expect(
            AuditService.updateFinding(findingId, body, creatorId)
          ).resolves.not.toThrow();

          // Verify: UPDATE was called (at least the finding update)
          const allCalls = mockDb.prepare.mock.calls;
          const hasUpdate = allCalls.some((c: any) => c[0]?.includes('UPDATE'));
          expect(hasUpdate).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * The ownership check is deterministic: for any given (findingId, creatorId, userId)
   * triple, the result is always the same - reject if userId ≠ creatorId, accept if equal.
   */
  it('ownership check is deterministic: same inputs always produce same outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        uuidArb,
        updateBodyArb,
        async (findingId, creatorId, attemptingUserId, body) => {
          // Run the check twice with the same inputs
          const results: boolean[] = [];

          for (let i = 0; i < 2; i++) {
            vi.clearAllMocks();
            mockDb.prepare.mockReset();

            setupFindingQueryMock(mockDb, findingId, creatorId);
            setupSuccessfulUpdateMocks(mockDb);

            try {
              await AuditService.updateFinding(findingId, body, attemptingUserId);
              results.push(true); // succeeded
            } catch (e) {
              results.push(false); // failed
            }
          }

          // Both runs must produce the same result
          expect(results[0]).toBe(results[1]);

          // And the result must match the ownership check
          if (creatorId === attemptingUserId) {
            expect(results[0]).toBe(true);
          } else {
            expect(results[0]).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

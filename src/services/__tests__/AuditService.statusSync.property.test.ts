// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test for AuditService (Property 3)
 *
 * Feature: audit-modules-restructure
 *
 * Property 3: Finding-Recommendation status sync
 *
 * For any valid finding status transition, the recommendation status is synced
 * according to the FINDING_TO_RECOMMENDATION_STATUS map:
 *   {Open→Open, In Progress→In Progress, Closed→Implemented, Pending Approval→In Progress}
 *
 * **Validates: Requirements 6.5, 7.3**
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

import {
  AuditService,
  ALLOWED_FINDING_TRANSITIONS,
  FINDING_TO_RECOMMENDATION_STATUS,
} from '../AuditService';
import { db } from '../../db/index';
import { UserRole } from '@alsaqi/shared';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** All valid finding statuses that have outgoing transitions */
const findingStatusesWithTransitions = Object.entries(ALLOWED_FINDING_TRANSITIONS)
  .filter(([_, targets]) => targets.length > 0)
  .map(([status]) => status);

/**
 * Arbitrary that generates a valid (currentStatus, newStatus) pair
 * from the ALLOWED_FINDING_TRANSITIONS map.
 */
const validTransitionArb = fc.oneof(
  ...findingStatusesWithTransitions.map((currentStatus) =>
    fc.constantFrom(...ALLOWED_FINDING_TRANSITIONS[currentStatus]).map((newStatus) => ({
      currentStatus,
      newStatus,
    }))
  )
);

/**
 * Arbitrary for a role that has APPROVE permission on AUDIT_FINDINGS.
 * Manager and Admin have APPROVE permission.
 */
const approveRoleArb = fc.constantFrom(UserRole.MANAGER, UserRole.ADMIN);

/** Arbitrary for any role (used for non-approval transitions) */
const anyRoleArb = fc.constantFrom(
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.INTERNAL_AUDITOR
);

/** Arbitrary for UUIDs */
const uuidArb = fc.uuid();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupMocksForStatusChange(mockDb: any, findingId: string, currentStatus: string) {
  // 1. Finding query - returns a finding with the given status
  mockDb.prepare.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: findingId,
      title: 'Test Finding',
      status: currentStatus,
      audit_id: 'plan-uuid-001',
      created_by: 'creator-uuid',
    }),
  });

  // 2. UPDATE finding status
  mockDb.prepare.mockReturnValueOnce({
    run: vi.fn().mockResolvedValue(undefined),
  });

  // 3. UPDATE recommendation status (sync)
  mockDb.prepare.mockReturnValueOnce({
    run: vi.fn().mockResolvedValue(undefined),
  });

  // 4. Manager query for notifications
  mockDb.prepare.mockReturnValueOnce({
    all: vi.fn().mockResolvedValue([{ id: 'manager-id-1' }]),
  });
}

/**
 * Determines the appropriate role for a given transition.
 * Pending Approval→Closed requires APPROVE permission (Manager/Admin).
 * Other transitions can be done by any role.
 */
function getRoleForTransition(
  currentStatus: string,
  newStatus: string,
  approveRole: string,
  anyRole: string
): string {
  if (currentStatus === 'Pending Approval' && newStatus === 'Closed') {
    return approveRole;
  }
  return anyRole;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 3: Finding-Recommendation status sync', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 6.5, 7.3**
   *
   * For any valid finding status transition, the recommendation status is updated
   * to the value specified in FINDING_TO_RECOMMENDATION_STATUS.
   *
   * The mapping is:
   *   Open → Open
   *   In Progress → In Progress
   *   Closed → Implemented
   *   Pending Approval → In Progress
   */
  it('for any valid transition, recommendation status is synced per FINDING_TO_RECOMMENDATION_STATUS map', async () => {
    await fc.assert(
      fc.asyncProperty(
        validTransitionArb,
        uuidArb,
        uuidArb,
        approveRoleArb,
        anyRoleArb,
        async (transition, findingId, userId, approveRole, anyRole) => {
          vi.clearAllMocks();
          mockDb.prepare.mockReset();

          const { currentStatus, newStatus } = transition;
          const role = getRoleForTransition(currentStatus, newStatus, approveRole, anyRole);

          setupMocksForStatusChange(mockDb, findingId, currentStatus);

          const result = await AuditService.changeFindingStatus(
            findingId,
            newStatus,
            userId,
            role
          );

          // The sync should succeed
          expect(result.syncSuccess).toBe(true);

          // The recommendation UPDATE is the 3rd db.prepare call (index 2)
          const recSyncCall = mockDb.prepare.mock.calls[2];
          expect(recSyncCall[0]).toContain('UPDATE recommendations');

          // Verify the recommendation status matches the map
          const expectedRecStatus = FINDING_TO_RECOMMENDATION_STATUS[newStatus];
          const recRunMock = mockDb.prepare.mock.results[2].value.run;
          expect(recRunMock).toHaveBeenCalledWith(
            expectedRecStatus,
            findingId
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 6.5, 7.3**
   *
   * The FINDING_TO_RECOMMENDATION_STATUS map covers all possible target statuses
   * reachable via valid transitions. No valid transition leads to an unmapped status.
   */
  it('every reachable finding status via valid transitions has a corresponding recommendation status in the map', async () => {
    await fc.assert(
      fc.asyncProperty(validTransitionArb, async (transition) => {
        const { newStatus } = transition;

        // The new status must exist in the mapping
        expect(FINDING_TO_RECOMMENDATION_STATUS[newStatus]).toBeDefined();
        expect(FINDING_TO_RECOMMENDATION_STATUS[newStatus]).toBeTruthy();
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 6.5, 7.3**
   *
   * The recommendation sync always uses the newStatus (not the currentStatus)
   * to determine the recommendation status. This ensures the recommendation
   * reflects the finding's new state, not its previous state.
   */
  it('recommendation status is determined by the new finding status, not the previous status', async () => {
    await fc.assert(
      fc.asyncProperty(
        validTransitionArb,
        uuidArb,
        uuidArb,
        approveRoleArb,
        anyRoleArb,
        async (transition, findingId, userId, approveRole, anyRole) => {
          vi.clearAllMocks();
          mockDb.prepare.mockReset();

          const { currentStatus, newStatus } = transition;
          const role = getRoleForTransition(currentStatus, newStatus, approveRole, anyRole);

          setupMocksForStatusChange(mockDb, findingId, currentStatus);

          await AuditService.changeFindingStatus(findingId, newStatus, userId, role);

          // The recommendation status should match the NEW status mapping,
          // not the current/old status mapping
          const expectedRecStatus = FINDING_TO_RECOMMENDATION_STATUS[newStatus];
          const recRunMock = mockDb.prepare.mock.results[2].value.run;
          const actualRecStatus = recRunMock.mock.calls[0][0];

          expect(actualRecStatus).toBe(expectedRecStatus);

          // Verify it's NOT using the old status mapping (unless they happen to be the same)
          if (FINDING_TO_RECOMMENDATION_STATUS[currentStatus] !== expectedRecStatus) {
            expect(actualRecStatus).not.toBe(FINDING_TO_RECOMMENDATION_STATUS[currentStatus]);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

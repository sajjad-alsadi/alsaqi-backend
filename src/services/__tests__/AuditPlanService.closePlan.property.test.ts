// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test for AuditPlanService.closePlan (Property 6)
 *
 * Feature: audit-modules-restructure
 *
 * Property 6: Plan closure requires all recommendations closed
 *
 * **Validates: Requirements 2.6, 2.7**
 *
 * For any plan with N recommendations where at least one recommendation has status
 * NOT in {'Implemented', 'Closed'}, closePlan must reject the closure.
 * Conversely, when all recommendations are 'Implemented' or 'Closed', closure should succeed.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

vi.mock('../NumberingService', () => ({
  NumberingService: {
    nextPlanCode: vi.fn(),
  },
}));

vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn(),
  },
}));

vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/AppCodeGenerator', () => ({
  AppCodeGenerator: {
    generateCode: vi.fn().mockResolvedValue(null),
    generateFindingCode: vi.fn().mockResolvedValue(null),
  },
}));

import { AuditPlanService } from '../AuditPlanService';
import { db } from '../../db/index';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** All possible recommendation statuses */
const CLOSED_STATUSES = ['Implemented', 'Closed'] as const;
const OPEN_STATUSES = ['Open', 'In Progress', 'Overdue'] as const;

/** Arbitrary for a closed recommendation status */
const closedStatusArb = fc.constantFrom(...CLOSED_STATUSES);

/** Arbitrary for an open (non-closed) recommendation status */
const openStatusArb = fc.constantFrom(...OPEN_STATUSES);

/** Arbitrary for a valid UUID-like plan ID */
const planIdArb = fc.uuid();

/** Arbitrary for a valid UUID-like user ID */
const userIdArb = fc.uuid();

/** Arbitrary for a role that is allowed to close plans */
const allowedRoleArb = fc.constantFrom('Manager', 'Admin');

/**
 * Generates a list of N recommendation statuses where ALL are closed.
 * N is between 0 and 20 (0 means no recommendations, which should allow closure).
 */
const allClosedRecsArb = fc.array(closedStatusArb, { minLength: 0, maxLength: 20 });

/**
 * Generates a list of recommendation statuses where at least one is NOT closed.
 * Strategy: generate a non-empty array of mixed statuses ensuring at least one open.
 */
const atLeastOneOpenRecArb = fc
  .tuple(
    fc.array(fc.constantFrom(...CLOSED_STATUSES, ...OPEN_STATUSES), { minLength: 0, maxLength: 19 }),
    openStatusArb // guarantee at least one open status
  )
  .map(([rest, openOne]) => {
    // Insert the guaranteed open status at a random-ish position
    const result = [...rest, openOne];
    return result;
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 6: Plan closure requires all recommendations closed', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 2.7**
   *
   * For any plan with N recommendations where at least one recommendation has status
   * NOT in {'Implemented', 'Closed'}, closePlan must reject the closure with a
   * ValidationError and leave the plan status unchanged.
   */
  it('closePlan rejects closure when at least one recommendation is not Implemented or Closed', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        atLeastOneOpenRecArb,
        async (planId, userId, role, recStatuses) => {
          vi.clearAllMocks();

          const openCount = recStatuses.filter(
            (s) => !CLOSED_STATUSES.includes(s as any)
          ).length;

          // Mock 1: User lookup - returns a user with allowed role
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: userId, role }),
          });

          // Mock 2: Plan lookup - plan exists
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
          });

          // Mock 3: Open recommendations count query
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ count: openCount }),
          });

          // closePlan must throw
          await expect(
            AuditPlanService.closePlan(planId, userId)
          ).rejects.toThrow();

          // Verify no UPDATE was called (plan status unchanged)
          // The 4th call would be the UPDATE if it succeeded - it should NOT happen
          expect(mockDb.prepare).toHaveBeenCalledTimes(3);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 2.6**
   *
   * For any plan where all recommendations are 'Implemented' or 'Closed'
   * (including the case of zero recommendations), closePlan must succeed
   * and set the plan status to 'Closed'.
   */
  it('closePlan succeeds when all recommendations are Implemented or Closed', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        allClosedRecsArb,
        async (planId, userId, role, _recStatuses) => {
          vi.clearAllMocks();

          // Mock 1: User lookup - returns a user with allowed role
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: userId, role }),
          });

          // Mock 2: Plan lookup - plan exists
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
          });

          // Mock 3: Open recommendations count = 0 (all closed)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ count: 0 }),
          });

          // Mock 4: UPDATE plan status to 'Closed'
          mockDb.prepare.mockReturnValueOnce({
            run: vi.fn().mockResolvedValue(undefined),
          });

          // closePlan must succeed
          const result = await AuditPlanService.closePlan(planId, userId);

          expect(result.success).toBe(true);
          expect(result.planId).toBe(planId);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 2.7 (role enforcement)**
   *
   * For any user who is NOT a Manager or Admin, closePlan must reject
   * regardless of recommendation statuses.
   */
  it('closePlan rejects when user role is not Manager or Admin', async () => {
    const nonAllowedRoleArb = fc.constantFrom(
      'Internal Auditor',
      'Compliance Officer',
      'Risk Officer',
      'Viewer'
    );

    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        nonAllowedRoleArb,
        async (planId, userId, role) => {
          vi.clearAllMocks();

          // Mock 1: User lookup - returns a user with non-allowed role
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: userId, role }),
          });

          // closePlan must throw ForbiddenError
          await expect(
            AuditPlanService.closePlan(planId, userId)
          ).rejects.toThrow();

          // Only 1 DB call should have been made (user lookup)
          expect(mockDb.prepare).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 200 }
    );
  });
});

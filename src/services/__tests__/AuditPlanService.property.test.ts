// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for AuditPlanService (Properties 2 & 13)
 *
 * Feature: audit-modules-restructure
 *
 * Property 2: New plan requires previous year archived
 * Property 13: Fixed fiscal year bounds
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
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

/** Valid fiscal year in range 2000-2100 (as per Requirement 2.1) */
const validYearArb = fc.integer({ min: 2000, max: 2100 });

/**
 * Year range that allows testing previous year logic (2001-2100).
 * We need year > 2000 so that previousYear (year - 1) is still >= 2000.
 */
const yearWithPreviousArb = fc.integer({ min: 2001, max: 2100 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 13: Fixed fiscal year bounds', () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any valid year in range [2000, 2100], fiscalYearBounds always returns:
   * - start = YYYY-01-01 (January 1st)
   * - end = YYYY-12-31 (December 31st)
   *
   * The fiscal year is fixed to the calendar year (Jan 1 - Dec 31).
   */
  it('fiscalYearBounds always returns start=YYYY-01-01 and end=YYYY-12-31 for any valid year', () => {
    fc.assert(
      fc.property(validYearArb, (year) => {
        const bounds = AuditPlanService.fiscalYearBounds(year);

        // Start must be January 1st of the given year
        expect(bounds.start).toBe(`${year}-01-01`);

        // End must be December 31st of the given year
        expect(bounds.end).toBe(`${year}-12-31`);
      }),
      { numRuns: 300 }
    );
  });

  it('fiscalYearBounds start date is always before end date for any valid year', () => {
    fc.assert(
      fc.property(validYearArb, (year) => {
        const bounds = AuditPlanService.fiscalYearBounds(year);

        const startDate = new Date(bounds.start);
        const endDate = new Date(bounds.end);

        // Start is always before end
        expect(startDate.getTime()).toBeLessThan(endDate.getTime());
      }),
      { numRuns: 300 }
    );
  });

  it('fiscalYearBounds start and end are always in the same year as the input', () => {
    fc.assert(
      fc.property(validYearArb, (year) => {
        const bounds = AuditPlanService.fiscalYearBounds(year);

        const startYear = new Date(bounds.start).getFullYear();
        const endYear = new Date(bounds.end).getFullYear();

        // Both dates must be in the same year as the input
        expect(startYear).toBe(year);
        expect(endYear).toBe(year);
      }),
      { numRuns: 300 }
    );
  });

  it('fiscalYearBounds covers exactly 365 days in non-leap years and 366 in leap years', () => {
    fc.assert(
      fc.property(validYearArb, (year) => {
        const bounds = AuditPlanService.fiscalYearBounds(year);

        const startDate = new Date(bounds.start);
        const endDate = new Date(bounds.end);

        // Calculate days difference (inclusive of both start and end)
        const diffMs = endDate.getTime() - startDate.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24) + 1; // +1 for inclusive

        // Leap year check
        const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        const expectedDays = isLeapYear ? 366 : 365;

        expect(diffDays).toBe(expectedDays);
      }),
      { numRuns: 300 }
    );
  });
});

describe('Property 2: New plan requires previous year archived', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 2.3**
   *
   * For any year Y in valid range, if there exists an unarchived plan for year Y-1,
   * then canCreateNewPlan(Y) must return allowed: false.
   *
   * This property ensures the system enforces sequential archiving before new plan creation.
   */
  it('canCreateNewPlan returns allowed:false when previous year has unarchived plan', async () => {
    await fc.assert(
      fc.asyncProperty(yearWithPreviousArb, async (year) => {
        vi.clearAllMocks();

        // Setup: No plan exists for the target year (passes first check)
        mockDb.prepare.mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });

        // Setup: Previous year has an unarchived plan (fails second check)
        mockDb.prepare.mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([{ id: 'prev-plan-id', title: `Plan ${year - 1}` }]),
        });

        const result = await AuditPlanService.canCreateNewPlan(year);

        // Must not be allowed
        expect(result.allowed).toBe(false);

        // Reason must mention the previous year
        expect(result.reason).toBeDefined();
        expect(result.reason).toContain(String(year - 1));
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * For any year Y in valid range, if a plan already exists for year Y,
   * then canCreateNewPlan(Y) must return allowed: false.
   *
   * This property ensures the single-plan-per-fiscal-year constraint.
   */
  it('canCreateNewPlan returns allowed:false when a plan already exists for the same year', async () => {
    await fc.assert(
      fc.asyncProperty(validYearArb, async (year) => {
        vi.clearAllMocks();

        // Setup: A plan already exists for the target year
        mockDb.prepare.mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([{ id: 'existing-plan-id' }]),
        });

        const result = await AuditPlanService.canCreateNewPlan(year);

        // Must not be allowed
        expect(result.allowed).toBe(false);

        // Reason must mention the year
        expect(result.reason).toBeDefined();
        expect(result.reason).toContain(String(year));
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 2.5**
   *
   * For any year Y in valid range, if no plan exists for year Y and
   * no unarchived plan exists for year Y-1, then canCreateNewPlan(Y)
   * must return allowed: true.
   *
   * This property ensures that when all preconditions are met, plan creation is allowed.
   */
  it('canCreateNewPlan returns allowed:true when no same-year plan and previous year is archived', async () => {
    await fc.assert(
      fc.asyncProperty(validYearArb, async (year) => {
        vi.clearAllMocks();

        // Setup: No plan exists for the target year
        mockDb.prepare.mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });

        // Setup: No unarchived plan for previous year (either archived or doesn't exist)
        mockDb.prepare.mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });

        const result = await AuditPlanService.canCreateNewPlan(year);

        // Must be allowed
        expect(result.allowed).toBe(true);
        expect(result.reason).toBeUndefined();
      }),
      { numRuns: 200 }
    );
  });
});

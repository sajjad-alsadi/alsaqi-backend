// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for AuditService (Properties 4 & 12)
 *
 * Feature: audit-modules-restructure
 *
 * Property 4: Recommendations are derived only
 * Property 12: Finding title is required
 *
 * **Validates: Requirements 6.1, 6.2, 7.1, 7.2**
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

import { AuditService, CreateFindingInput } from '../AuditService';
import { NumberingService } from '../NumberingService';
import { db } from '../../db/index';
import { ValidationError } from '../../utils/errors';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for non-empty, non-whitespace strings within 200 chars (valid titles) */
const validTitleArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

/** Arbitrary for empty or whitespace-only strings (invalid titles) */
const emptyOrWhitespaceTitleArb = fc.oneof(
  fc.constant(''),
  fc.constant(null as any),
  fc.constant(undefined as any),
  fc.integer({ min: 1, max: 50 }).map((n) => ' '.repeat(n)), // whitespace-only (spaces)
  fc.integer({ min: 1, max: 20 }).map((n) => '\t'.repeat(n)), // whitespace-only (tabs)
  fc.integer({ min: 1, max: 10 }).map((n) => ' \t\n\r'.repeat(n)) // mixed whitespace
);

/** Arbitrary for strings exceeding 200 chars */
const tooLongTitleArb = fc.string({ minLength: 201, maxLength: 500 }).filter((s) => s.trim().length > 200);

/** Arbitrary for valid finding types */
const validFindingTypeArb = fc.constantFrom(
  'control_design_deficiency' as const,
  'operational_design_deficiency' as const
);

/** Arbitrary for valid risk levels */
const validRiskLevelArb = fc.constantFrom(
  'Low' as const,
  'Medium' as const,
  'High' as const,
  'Critical' as const
);

/** Arbitrary for valid UUIDs (plan IDs, user IDs) */
const uuidArb = fc.uuid();

/** Arbitrary for valid finding input (with valid title) */
const validFindingInputArb = fc.record({
  audit_id: uuidArb,
  title: validTitleArb,
  description: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
  criteria: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
  condition: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
  finding_type: validFindingTypeArb,
  consequence: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
  risk_level: validRiskLevelArb,
}) as fc.Arbitrary<CreateFindingInput>;

// ─── Helper ──────────────────────────────────────────────────────────────────

function setupSuccessfulCreationMocks(mockDb: any, planId: string) {
  // Plan query - returns a valid non-archived plan
  mockDb.prepare.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: planId,
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 4: Recommendations are derived only', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 7.1**
   *
   * For any valid finding input, createFinding always produces exactly one
   * recommendation. The recommendation is auto-created as part of the finding
   * creation transaction.
   */
  it('every successful finding creation auto-creates exactly one recommendation', async () => {
    await fc.assert(
      fc.asyncProperty(validFindingInputArb, uuidArb, async (input, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        setupSuccessfulCreationMocks(mockDb, input.audit_id);

        const result = await AuditService.createFinding(input, userId);

        // Must return both findingId and recommendationId
        expect(result.findingId).toBeDefined();
        expect(result.findingId).toBeTruthy();
        expect(result.recommendationId).toBeDefined();
        expect(result.recommendationId).toBeTruthy();

        // NumberingService.nextRecommendationNumber must have been called exactly once
        expect(NumberingService.nextRecommendationNumber).toHaveBeenCalledTimes(1);

        // The recommendation INSERT must have been called (3rd db.prepare call)
        const recInsertCall = mockDb.prepare.mock.calls[2];
        const recInsertSql = recInsertCall[0];
        expect(recInsertSql).toContain('INSERT INTO recommendations');
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.1**
   *
   * The auto-created recommendation inherits the same risk_level as the finding
   * and starts with status 'Open'.
   */
  it('auto-created recommendation has same risk_level as the finding and status Open', async () => {
    await fc.assert(
      fc.asyncProperty(validFindingInputArb, uuidArb, async (input, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        setupSuccessfulCreationMocks(mockDb, input.audit_id);

        await AuditService.createFinding(input, userId);

        // The recommendation INSERT is the 3rd db.prepare call
        const recInsertCall = mockDb.prepare.mock.calls[2];
        const recInsertSql = recInsertCall[0];

        // Verify the SQL contains 'Open' status
        expect(recInsertSql).toContain("'Open'");

        // Verify the get call was made with the correct risk_level
        const recGetCall = mockDb.prepare.mock.results[2].value.get;
        const recArgs = recGetCall.mock.calls[0];
        // risk_level is the last argument in the INSERT
        const riskLevelArg = recArgs[recArgs.length - 1];
        expect(riskLevelArg).toBe(input.risk_level);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.2**
   *
   * Manual recommendation creation is blocked. The POST /recommendations route
   * throws a ForbiddenError. This is tested at the route level, but here we verify
   * that the only path to create a recommendation is through createFinding.
   *
   * We verify that for any successful createFinding call, the recommendation
   * INSERT is always part of the same transaction (same db.prepare sequence).
   */
  it('recommendation creation is always coupled with finding creation (no standalone path)', async () => {
    await fc.assert(
      fc.asyncProperty(validFindingInputArb, uuidArb, async (input, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        setupSuccessfulCreationMocks(mockDb, input.audit_id);

        await AuditService.createFinding(input, userId);

        // Verify the transaction mock was called (ensuring atomicity)
        expect(mockDb.transaction).toHaveBeenCalledTimes(1);

        // The finding INSERT and recommendation INSERT are both within the transaction
        // Finding INSERT is call index 1, Recommendation INSERT is call index 2
        const allCalls = mockDb.prepare.mock.calls;
        const findingInsertIdx = allCalls.findIndex((c: any) =>
          c[0]?.includes('INSERT INTO audit_findings')
        );
        const recInsertIdx = allCalls.findIndex((c: any) =>
          c[0]?.includes('INSERT INTO recommendations')
        );

        // Both must exist
        expect(findingInsertIdx).toBeGreaterThanOrEqual(0);
        expect(recInsertIdx).toBeGreaterThanOrEqual(0);

        // Recommendation INSERT must come after finding INSERT
        expect(recInsertIdx).toBeGreaterThan(findingInsertIdx);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 12: Finding title is required', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 6.1**
   *
   * For any string that is empty, whitespace-only, null, or undefined,
   * createFinding must throw a ValidationError. The title is mandatory.
   */
  it('createFinding throws ValidationError for empty/whitespace/null/undefined titles', async () => {
    await fc.assert(
      fc.asyncProperty(emptyOrWhitespaceTitleArb, uuidArb, async (invalidTitle, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        const input: CreateFindingInput = {
          audit_id: 'plan-uuid-001',
          title: invalidTitle,
          finding_type: 'control_design_deficiency',
          risk_level: 'Medium',
        };

        await expect(AuditService.createFinding(input, userId)).rejects.toThrow(ValidationError);

        // No database calls should have been made (validation fails before DB access)
        expect(mockDb.prepare).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1**
   *
   * For any string that exceeds 200 characters (after trimming),
   * createFinding must throw a ValidationError.
   */
  it('createFinding throws ValidationError for titles exceeding 200 characters', async () => {
    await fc.assert(
      fc.asyncProperty(tooLongTitleArb, uuidArb, async (longTitle, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        const input: CreateFindingInput = {
          audit_id: 'plan-uuid-001',
          title: longTitle,
          finding_type: 'control_design_deficiency',
          risk_level: 'Medium',
        };

        await expect(AuditService.createFinding(input, userId)).rejects.toThrow(ValidationError);

        // No database calls should have been made (validation fails before DB access)
        expect(mockDb.prepare).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.2**
   *
   * For any non-empty string ≤200 chars (after trimming) with a valid finding_type,
   * the title validation passes and the finding creation proceeds to the database layer.
   * This verifies that valid titles are accepted.
   */
  it('createFinding accepts any non-empty title ≤200 chars with valid finding_type', async () => {
    await fc.assert(
      fc.asyncProperty(validFindingInputArb, uuidArb, async (input, userId) => {
        vi.clearAllMocks();
        mockDb.prepare.mockReset();

        setupSuccessfulCreationMocks(mockDb, input.audit_id);

        const result = await AuditService.createFinding(input, userId);

        // Should succeed without throwing
        expect(result.findingId).toBeDefined();
        expect(result.recommendationId).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.1**
   *
   * The title boundary: exactly 200 characters (after trimming) is accepted,
   * while 201 characters is rejected. This tests the boundary condition.
   */
  it('title of exactly 200 chars passes, title of 201 chars fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        uuidArb,
        async (length, userId) => {
          vi.clearAllMocks();
          mockDb.prepare.mockReset();

          // Generate a title of exactly `length` characters (valid)
          const validTitle = 'a'.repeat(length);
          const validInput: CreateFindingInput = {
            audit_id: 'plan-uuid-001',
            title: validTitle,
            finding_type: 'control_design_deficiency',
            risk_level: 'Medium',
          };

          setupSuccessfulCreationMocks(mockDb, validInput.audit_id);

          // Should succeed
          const result = await AuditService.createFinding(validInput, userId);
          expect(result.findingId).toBeDefined();

          // Now test with length + 1 if it exceeds 200
          if (length === 200) {
            vi.clearAllMocks();
            mockDb.prepare.mockReset();

            const invalidTitle = 'a'.repeat(201);
            const invalidInput: CreateFindingInput = {
              ...validInput,
              title: invalidTitle,
            };

            await expect(
              AuditService.createFinding(invalidInput, userId)
            ).rejects.toThrow(ValidationError);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

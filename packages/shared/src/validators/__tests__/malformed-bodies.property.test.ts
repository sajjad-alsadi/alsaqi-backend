/**
 * Property test for FIX-BE-5 validator schemas.
 *
 * Property 2: Malformed response/request bodies are rejected with the offending
 * field identified.
 *
 * For every NEW validator introduced by the FIX-BE-5 wave (risk-register,
 * central-bank-instructions, dashboard-stats, and the user-management schemas),
 * start from a generated VALID object and apply a SINGLE mutation:
 *   (a) drop a REQUIRED field, or
 *   (b) replace a field's value with a mismatched type.
 * Assert the parse fails (`safeParse(...).success === false`) and that at least
 * one reported issue has a `path` whose first element points at the mutated
 * field.
 *
 * **Validates: Requirements 5.8**
 */
// Feature: backend-consistency-fixes, Property 2
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';

import {
  // risk-register
  CreateRiskRegisterSchema,
  // central-bank-instructions
  CreateCentralBankInstructionSchema,
  // dashboard-stats
  DashboardStatsResponseSchema,
  // user-management
  UserSummaryResponseSchema,
  LoginHistoryResponseSchema,
  AuditTrailResponseSchema,
  RolePermissionMatrixResponseSchema,
  UpdateRolePermissionsSchema,
} from '../index';

// ─── Shared arbitraries ───────────────────────────────────────────────────────

/** A valid non-empty bounded string. */
const str = fc.string({ minLength: 1, maxLength: 50 });
/** A valid finite number. */
const num = fc.integer({ min: 0, max: 100000 });

const MIN_RUNS = 100;

/**
 * Drives Property 2 for a single object-shaped schema.
 *
 * @param name           human-readable schema name for test titles
 * @param schema         the Zod schema under test
 * @param validArb       arbitrary that yields objects satisfying `schema`
 * @param requiredFields field names that, when dropped, must cause rejection
 * @param wrongValues    map of field -> a value of the WRONG primitive/container
 *                       type for that field
 */
function runMalformedTests(
  name: string,
  schema: z.ZodTypeAny,
  validArb: fc.Arbitrary<Record<string, unknown>>,
  requiredFields: readonly string[],
  wrongValues: Record<string, unknown>
): void {
  describe(name, () => {
    if (requiredFields.length > 0) {
      it(`${name}: dropping a required field is rejected and the issue points at it`, () => {
        fc.assert(
          fc.property(
            validArb,
            fc.constantFrom(...requiredFields),
            (validObj, field) => {
              // Sanity: the unmutated object must be valid.
              expect(schema.safeParse(validObj).success).toBe(true);

              // Mutation (a): drop a required field.
              const mutated: Record<string, unknown> = { ...validObj };
              delete mutated[field];

              const result = schema.safeParse(mutated);
              expect(result.success).toBe(false);
              if (!result.success) {
                const pointsAtField = result.error.issues.some(
                  (issue) => issue.path[0] === field
                );
                expect(pointsAtField).toBe(true);
              }
            }
          ),
          { numRuns: MIN_RUNS }
        );
      });
    }

    const mismatchFields = Object.keys(wrongValues);
    it(`${name}: a type-mismatched field is rejected and the issue points at it`, () => {
      fc.assert(
        fc.property(
          validArb,
          fc.constantFrom(...mismatchFields),
          (validObj, field) => {
            // Sanity: the unmutated object must be valid.
            expect(schema.safeParse(validObj).success).toBe(true);

            // Mutation (b): replace the field with a value of the wrong type.
            const mutated: Record<string, unknown> = { ...validObj };
            mutated[field] = wrongValues[field];

            const result = schema.safeParse(mutated);
            expect(result.success).toBe(false);
            if (!result.success) {
              const pointsAtField = result.error.issues.some(
                (issue) => issue.path[0] === field
              );
              expect(pointsAtField).toBe(true);
            }
          }
        ),
        { numRuns: MIN_RUNS }
      );
    });
  });
}

describe('Property 2: Malformed bodies are rejected with the offending field identified (FIX-BE-5)', () => {
  // ─── risk-register ──────────────────────────────────────────────────────────
  runMalformedTests(
    'CreateRiskRegisterSchema',
    CreateRiskRegisterSchema,
    fc.record(
      {
        description: str,
        owner: str,
        score: fc.integer({ min: 0, max: 100 }),
        status: str,
      },
      { requiredKeys: ['description'] }
    ),
    ['description'],
    {
      description: 12345, // string field <- number
      owner: 999, // string field <- number
      score: 'not-a-number', // number field <- string
      status: {}, // string field <- object
    }
  );

  // ─── central-bank-instructions ────────────────────────────────────────────────
  runMalformedTests(
    'CreateCentralBankInstructionSchema',
    CreateCentralBankInstructionSchema,
    fc.record(
      {
        title: str,
        issue_date: str,
        reference_number: str,
        category: str,
        description: str,
        related_department: str,
        status: str,
        attachment: str,
        related_instruction_id: str,
      },
      {
        requiredKeys: [
          'title',
          'issue_date',
          'reference_number',
          'category',
          'description',
          'related_department',
          'status',
        ],
      }
    ),
    [
      'title',
      'issue_date',
      'reference_number',
      'category',
      'description',
      'related_department',
      'status',
    ],
    {
      title: 123,
      issue_date: 0,
      reference_number: 456,
      category: {},
      description: 789,
      related_department: [],
      status: 1,
      attachment: 42, // optional string field <- number
      related_instruction_id: [], // optional string field <- array
    }
  );

  // ─── dashboard-stats (response) ─────────────────────────────────────────────────
  runMalformedTests(
    'DashboardStatsResponseSchema',
    DashboardStatsResponseSchema,
    fc.record({
      audits: fc.record({
        total: num,
        completed: num,
        progress_by_type: fc.array(
          fc.record({ type: str, planned: num, completed: num }),
          { maxLength: 5 }
        ),
      }),
      findings: fc.record({
        summary: fc.record({ open: num, high_risk_open: num }),
      }),
      recommendations: fc.record({ open: num, overdue: num }),
      risks: fc.record({ summary: fc.record({ total: num, high: num }) }),
      correspondence: fc.record({
        incoming_total: num,
        outgoing_total: num,
        pending_responses: num,
      }),
      compliance: fc.record({ total: num }),
      activity: fc.array(fc.dictionary(str, fc.jsonValue()), { maxLength: 5 }),
    }),
    [
      'audits',
      'findings',
      'recommendations',
      'risks',
      'correspondence',
      'compliance',
      'activity',
    ],
    {
      audits: 0, // object field <- number
      findings: 'x', // object field <- string
      recommendations: 0,
      risks: 'y',
      correspondence: 0,
      compliance: 'z',
      activity: 5, // array field <- number
    }
  );

  // ─── user-management: GET /users/summary ───────────────────────────────────────
  runMalformedTests(
    'UserSummaryResponseSchema',
    UserSummaryResponseSchema,
    fc.record({
      total: num,
      active: num,
      suspended: num,
      archived: num,
      admins: num,
      inactive: num,
    }),
    ['total', 'active', 'suspended', 'archived', 'admins', 'inactive'],
    {
      total: 'x', // number field <- string
      active: {},
      suspended: 'y',
      archived: [],
      admins: 'z',
      inactive: {},
    }
  );

  // ─── user-management: GET /login-history (paginated) ────────────────────────────
  runMalformedTests(
    'LoginHistoryResponseSchema',
    LoginHistoryResponseSchema,
    fc.record({
      data: fc.array(
        fc.record({ id: num, user_id: num, login_time: str }),
        { maxLength: 5 }
      ),
      pagination: fc.record({
        page: num,
        pageSize: num,
        total: num,
        totalPages: num,
      }),
    }),
    ['data', 'pagination'],
    {
      data: 5, // array field <- number
      pagination: 'x', // object field <- string
    }
  );

  // ─── user-management: GET /audit-trail (paginated) ──────────────────────────────
  runMalformedTests(
    'AuditTrailResponseSchema',
    AuditTrailResponseSchema,
    fc.record({
      data: fc.array(
        fc.record({
          id: num,
          user: str,
          action: str,
          module: str,
          timestamp: str,
        }),
        { maxLength: 5 }
      ),
      pagination: fc.record({
        page: num,
        pageSize: num,
        total: num,
        totalPages: num,
      }),
    }),
    ['data', 'pagination'],
    {
      data: 0,
      pagination: 'x',
    }
  );

  // ─── user-management: GET /roles/:id/permissions (matrix read) ──────────────────
  runMalformedTests(
    'RolePermissionMatrixResponseSchema',
    RolePermissionMatrixResponseSchema,
    fc.record({
      roleId: num,
      roleName: str,
      isCustom: fc.boolean(),
      permissions: fc.constant({}),
    }),
    ['roleId', 'roleName', 'isCustom', 'permissions'],
    {
      roleId: {}, // union(string|number) field <- object
      roleName: 5, // string field <- number
      isCustom: 'x', // boolean field <- string
      permissions: 7, // record field <- number
    }
  );

  // ─── user-management: POST /roles/:id/permissions (matrix update) ───────────────
  runMalformedTests(
    'UpdateRolePermissionsSchema',
    UpdateRolePermissionsSchema,
    fc.record({
      permissions: fc.array(
        fc.record({ module: str, action: str, granted: fc.boolean() }),
        { maxLength: 5 }
      ),
    }),
    ['permissions'],
    {
      permissions: 5, // array field <- number
    }
  );
});

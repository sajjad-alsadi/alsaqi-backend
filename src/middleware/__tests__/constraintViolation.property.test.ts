// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { globalErrorHandler } from '../error';

/**
 * Property 15: Constraint Violation Mapping
 *
 * **Validates: Requirements 10.4**
 *
 * For any database constraint violation error (code `23505`, or message matching
 * `unique.*constraint|duplicate.*key`), the error handler SHALL return HTTP 409
 * with error code `CONFLICT` and, in production mode, SHALL NOT include constraint
 * column names or details in the response message.
 */

// ─── Test Utilities ──────────────────────────────────────────────────────────

/**
 * Creates a mock Express Request object.
 */
function createMockReq(overrides: Partial<Record<string, any>> = {}): any {
  return {
    method: 'POST',
    originalUrl: '/api/users',
    correlationId: 'test-trace-id',
    ...overrides,
  };
}

/**
 * Creates a mock Express Response object that captures the status and JSON body.
 */
function createMockRes(): any {
  const res: any = {
    statusCode: null,
    body: null,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

/**
 * A no-op next function.
 */
const mockNext = () => {};

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generates realistic constraint column names */
const constraintColumnArb = fc.constantFrom(
  'email', 'username', 'phone_number', 'national_id', 'employee_id',
  'code', 'name', 'reference_number', 'slug', 'external_id',
  'registration_number', 'license_number', 'account_number',
);

/** Generates realistic constraint names */
const constraintNameArb = fc.constantFrom(
  'users_email_unique', 'users_username_key', 'departments_name_unique',
  'audit_plans_reference_number_key', 'roles_name_unique',
  'permissions_module_action_unique', 'unique_employee_id',
  'idx_unique_national_id', 'correspondence_ref_unique',
);

/** Generates table names that might appear in constraint violation messages */
const tableNameArb = fc.constantFrom(
  'users', 'departments', 'roles', 'permissions', 'audit_plans',
  'audit_tasks', 'correspondence', 'notifications', 'settings',
);

/**
 * Generates a database error with code 23505 (the PostgreSQL unique_violation code).
 * These simulate real pg errors with varying levels of detail.
 */
const code23505ErrorArb = fc.tuple(
  constraintColumnArb,
  constraintNameArb,
  tableNameArb,
  fc.constantFrom(
    'duplicate key value violates unique constraint',
    'Key (${column})=(value) already exists.',
    'unique constraint violated',
  ),
).map(([column, constraint, table, baseMsg]) => {
  const err: any = new Error(`${baseMsg}: ${constraint} on ${table}.${column}`);
  err.code = '23505';
  err.constraint = constraint;
  err.column = column;
  err.table = table;
  err.detail = `Key (${column})=(some_value) already exists.`;
  return err;
});

/**
 * Generates a database error whose message matches unique.*constraint pattern
 * (without necessarily having code 23505).
 */
const uniqueConstraintMessageArb = fc.tuple(
  constraintColumnArb,
  constraintNameArb,
).map(([column, constraint]) => {
  const err: any = new Error(
    `unique constraint "${constraint}" on column "${column}" violated`
  );
  // No code set — relies on message pattern matching
  err.constraint = constraint;
  err.column = column;
  return err;
});

/**
 * Generates a database error whose message matches duplicate.*key pattern
 * (without necessarily having code 23505).
 */
const duplicateKeyMessageArb = fc.tuple(
  constraintColumnArb,
  constraintNameArb,
  tableNameArb,
).map(([column, constraint, table]) => {
  const err: any = new Error(
    `duplicate key value violates constraint "${constraint}" on table "${table}" for column "${column}"`
  );
  // No code set — relies on message pattern matching
  err.constraint = constraint;
  err.column = column;
  err.table = table;
  return err;
});

/**
 * Combined arbitrary that produces any type of constraint violation error.
 */
const constraintViolationErrorArb = fc.oneof(
  code23505ErrorArb,
  uniqueConstraintMessageArb,
  duplicateKeyMessageArb,
);

// ─── Patterns for detecting leaked constraint details ────────────────────────

/** Pattern that detects constraint column names leaked in production responses */
const constraintDetailPatterns = [
  /\bcolumn\b/i,
  /\bconstraint\b/i,
  /\bkey\b.*\balready exists\b/i,
  /\bviolat/i,
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 15: Constraint Violation Mapping', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('HTTP 409 + CONFLICT code for constraint violations', () => {
    it('for ANY error with code 23505, the handler SHALL return HTTP 409 with CONFLICT error code', () => {
      fc.assert(
        fc.property(
          code23505ErrorArb,
          fc.constantFrom('development', 'production'),
          (err, env) => {
            process.env.NODE_ENV = env;
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            expect(res.statusCode).toBe(409);
            expect(res.body.error.code).toBe('CONFLICT');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for ANY error with message matching unique.*constraint, the handler SHALL return HTTP 409 with CONFLICT error code', () => {
      fc.assert(
        fc.property(
          uniqueConstraintMessageArb,
          fc.constantFrom('development', 'production'),
          (err, env) => {
            process.env.NODE_ENV = env;
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            expect(res.statusCode).toBe(409);
            expect(res.body.error.code).toBe('CONFLICT');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for ANY error with message matching duplicate.*key, the handler SHALL return HTTP 409 with CONFLICT error code', () => {
      fc.assert(
        fc.property(
          duplicateKeyMessageArb,
          fc.constantFrom('development', 'production'),
          (err, env) => {
            process.env.NODE_ENV = env;
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            expect(res.statusCode).toBe(409);
            expect(res.body.error.code).toBe('CONFLICT');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('No constraint details in production mode', () => {
    it('for ANY constraint violation error in production, the response message SHALL NOT contain constraint column names or details', () => {
      fc.assert(
        fc.property(
          constraintViolationErrorArb,
          (err) => {
            process.env.NODE_ENV = 'production';
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            const responseMessage = res.body.error.message;

            // In production mode, the response should just be "Conflict" (the generic 409 message)
            // and should NOT leak any constraint details
            for (const pattern of constraintDetailPatterns) {
              expect(responseMessage).not.toMatch(pattern);
            }

            // Also verify specific column names are not in the response
            if (err.column) {
              expect(responseMessage.toLowerCase()).not.toContain(err.column.toLowerCase());
            }
            if (err.constraint) {
              expect(responseMessage.toLowerCase()).not.toContain(err.constraint.toLowerCase());
            }
            if (err.table) {
              // Table names like "users" might appear in generic text, but not as DB identifiers
              const tablePattern = new RegExp(`\\b${err.table}\\b`, 'i');
              expect(responseMessage).not.toMatch(tablePattern);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for ANY constraint violation in production, the response SHALL NOT include error details or stack trace', () => {
      fc.assert(
        fc.property(
          constraintViolationErrorArb,
          (err) => {
            process.env.NODE_ENV = 'production';
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            // Production response should not have details or stack fields
            expect(res.body.error.details).toBeUndefined();
            expect(res.body.error.stack).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Response structure correctness', () => {
    it('for ANY constraint violation error, the response SHALL include a traceId', () => {
      fc.assert(
        fc.property(
          constraintViolationErrorArb,
          fc.constantFrom('development', 'production'),
          (err, env) => {
            process.env.NODE_ENV = env;
            const req = createMockReq();
            const res = createMockRes();

            globalErrorHandler(err, req, res, mockNext);

            expect(res.body.error.traceId).toBeDefined();
            expect(typeof res.body.error.traceId).toBe('string');
            expect(res.body.error.traceId.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';

/**
 * Unit Test: Server-Side Log Detail Preservation
 *
 * **Validates: Requirements 24.5**
 *
 * WHEN the Error_Handler sanitizes an error for the client-facing response,
 * THE Error_Handler SHALL preserve the complete unsanitized error detail in the
 * server-side log entry so that no diagnostic information is lost.
 *
 * These tests mock the logger so we can inspect the exact `serverLogDetail`
 * object passed to it, then assert that every internal field (table, column,
 * constraint, stack, SQL-like message, etc.) survives unsanitized in the log
 * while the client response only carries allowlisted/sanitized fields.
 */

// ─── Mock the logger used by the error middleware ────────────────────────────
// The source module (src/middleware/error.ts) imports '../utils/logger.js'.
// Mocking '../../utils/logger.js' here resolves to the same absolute module.
// vi.hoisted is required because vi.mock is hoisted above these declarations.
const { errorMock, warnMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  default: {
    error: errorMock,
    warn: warnMock,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER the mock is declared (vi.mock is hoisted, so this is safe).
import { globalErrorHandler, CLIENT_ERROR_FIELD_ALLOWLIST } from '../error';

// ─── Test Utilities ──────────────────────────────────────────────────────────

function createMockReq(overrides: Record<string, any> = {}): Partial<Request> {
  return {
    method: 'POST',
    originalUrl: '/api/audit_tasks',
    correlationId: 'trace-12345',
    ...overrides,
  } as Partial<Request>;
}

function createMockRes(): { res: Partial<Response>; getBody: () => any; getStatus: () => number } {
  let body: any = null;
  let statusCode = 200;
  const res: Partial<Response> = {
    status: vi.fn().mockImplementation((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((data: any) => {
      body = data;
      return res;
    }),
  };
  return { res, getBody: () => body, getStatus: () => statusCode };
}

const mockNext = vi.fn();

/**
 * Builds a 5xx error rich with internal diagnostic fields that MUST NOT leak to
 * the client but MUST be preserved verbatim in the server log. The message and
 * fields are crafted so the handler does NOT remap it to a 409 constraint
 * conflict (no `23505` code, no `constraint` field, no unique/duplicate text).
 */
function buildInternal500Error() {
  const err: any = new Error(
    'Query failed: SELECT * FROM users WHERE email = $1 (internal executor error)'
  );
  err.statusCode = 500;
  err.errorCode = 'INTERNAL_ERROR';
  err.code = 'XX000';
  err.column = 'email';
  err.table = 'users';
  err.details = { hint: 'check unique index on users.email', schema: 'public' };
  // err.stack is set automatically by the Error constructor.
  return err;
}

/**
 * Builds a database constraint-violation error. The handler remaps this to a
 * 409 conflict and logs it via logger.warn while sanitizing the client response.
 */
function buildConstraintError() {
  const err: any = new Error(
    'duplicate key value violates unique constraint "users_email_key"'
  );
  err.code = '23505';
  err.constraint = 'users_email_key';
  err.column = 'email';
  err.table = 'users';
  err.details = { detail: 'Key (email)=(a@b.com) already exists.' };
  return err;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Server-Side Log Detail Preservation (Requirement 24.5)', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    errorMock.mockClear();
    warnMock.mockClear();
    mockNext.mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('preserves the complete unsanitized error in the server log (>= 500 -> logger.error)', () => {
    process.env.NODE_ENV = 'production';
    const err = buildInternal500Error();
    const req = createMockReq();
    const { res } = createMockRes();

    globalErrorHandler(err, req as Request, res as Response, mockNext);

    // 5xx errors are logged via logger.error.
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();

    const [, serverLogDetail] = errorMock.mock.calls[0];

    // Every internal field is preserved verbatim in the server log.
    expect(serverLogDetail).toMatchObject({
      method: 'POST',
      url: '/api/audit_tasks',
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      message: err.message, // full unsanitized SQL-bearing message
      details: err.details,
      code: 'XX000',
      column: 'email',
      table: 'users',
      stack: err.stack,
    });

    // The complete (unsanitized) message must include the SQL fragment and
    // table/column references — none of it stripped server-side.
    expect(serverLogDetail.message).toContain('SELECT * FROM users');
    expect(typeof serverLogDetail.stack).toBe('string');
    expect(serverLogDetail.stack.length).toBeGreaterThan(0);
  });

  it('client response only contains allowlisted/sanitized fields (no internal leakage)', () => {
    process.env.NODE_ENV = 'production';
    const err = buildInternal500Error();
    const req = createMockReq();
    const { res, getBody } = createMockRes();

    globalErrorHandler(err, req as Request, res as Response, mockNext);

    const clientError = getBody().error;

    // Client error fields must be a subset of the allowlist.
    const allowed = new Set<string>(CLIENT_ERROR_FIELD_ALLOWLIST);
    for (const key of Object.keys(clientError)) {
      expect(allowed.has(key)).toBe(true);
    }

    // No internal diagnostic fields leak to the client.
    expect(clientError.table).toBeUndefined();
    expect(clientError.column).toBeUndefined();
    expect(clientError.constraint).toBeUndefined();
    expect(clientError.stack).toBeUndefined();
    expect(clientError.details).toBeUndefined();

    // The client message must NOT contain the raw SQL/table details.
    expect(clientError.message).not.toContain('SELECT * FROM users');
    expect(clientError.message).not.toContain('email');

    // Sanity: the client still gets a generic, allowlisted shape.
    expect(typeof clientError.message).toBe('string');
    expect(typeof clientError.code).toBe('string');
    expect(typeof clientError.traceId).toBe('string');
  });

  it('preserves constraint diagnostics server-side while omitting them from the sanitized client response', () => {
    process.env.NODE_ENV = 'production';
    const err = buildConstraintError();
    const req = createMockReq();
    const { res, getBody } = createMockRes();

    globalErrorHandler(err, req as Request, res as Response, mockNext);

    // Constraint violations are remapped to 409 and logged via logger.warn.
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();

    const [, serverLogDetail] = warnMock.mock.calls[0];
    const clientError = getBody().error;

    // The exact internal fields stripped from the client survive in the log.
    expect(clientError.constraint).toBeUndefined();
    expect(serverLogDetail.constraint).toBe('users_email_key');

    expect(clientError.column).toBeUndefined();
    expect(serverLogDetail.column).toBe('email');

    expect(clientError.table).toBeUndefined();
    expect(serverLogDetail.table).toBe('users');

    expect(clientError.details).toBeUndefined();
    expect(serverLogDetail.details).toEqual(err.details);

    // Full unsanitized message + code preserved server-side.
    expect(serverLogDetail.code).toBe('23505');
    expect(serverLogDetail.message).toContain('users_email_key');
    // Client message must not leak the constraint name.
    expect(clientError.message).not.toContain('users_email_key');
  });

  it('logs the full detail via logger.warn for client (4xx) errors', () => {
    process.env.NODE_ENV = 'production';
    const err: any = new Error('Invalid value for column "national_id" in table users');
    err.statusCode = 400;
    err.errorCode = 'VALIDATION_ERROR';
    err.column = 'national_id';
    err.table = 'users';
    const req = createMockReq({ method: 'GET', originalUrl: '/api/users/42' });
    const { res } = createMockRes();

    globalErrorHandler(err, req as Request, res as Response, mockNext);

    // 4xx errors are logged via logger.warn.
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();

    const [, serverLogDetail] = warnMock.mock.calls[0];
    expect(serverLogDetail).toMatchObject({
      method: 'GET',
      url: '/api/users/42',
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: err.message,
      column: 'national_id',
      table: 'users',
      stack: err.stack,
    });
    // Full message preserved server-side.
    expect(serverLogDetail.message).toContain('national_id');
    expect(serverLogDetail.message).toContain('users');
  });
});

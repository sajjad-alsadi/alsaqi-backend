// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { Request, Response } from 'express';
import { globalErrorHandler } from '../error';

/**
 * Property Test: Error Response Contains TraceId (Property 14)
 *
 * **Validates: Requirements 10.3**
 *
 * For any error processed by the `globalErrorHandler`, the JSON response SHALL
 * include a `traceId` field (non-empty string) in the error object.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** UUID v4 format regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creates a mock Express request */
function createMockRequest(correlationId?: string): Partial<Request> {
  return {
    method: 'GET',
    originalUrl: '/test',
    headers: {},
    ...(correlationId ? { correlationId } : {}),
  };
}

/** Creates a mock Express response that captures the JSON output */
function createMockResponse(): { res: Partial<Response>; getBody: () => any; getStatus: () => number } {
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

  return {
    res,
    getBody: () => body,
    getStatus: () => statusCode,
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a random HTTP status code in the error range */
const errorStatusCodeArb = fc.constantFrom(400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504);

/** Generates a random error message */
const errorMessageArb = fc.oneof(
  fc.constantFrom(
    'Something went wrong',
    'Connection refused',
    'Timeout exceeded',
    'Invalid input',
    'Permission denied',
    'Record not found',
    'Internal server error',
    'Database connection lost',
  ),
  fc.string({ minLength: 1, maxLength: 200 }),
);

/** Generates a random error code string */
const errorCodeArb = fc.constantFrom(
  'INTERNAL_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'RATE_LIMIT_EXCEEDED',
);

/** Generates a generic Error with optional statusCode and errorCode */
const genericErrorArb = fc.tuple(errorMessageArb, errorStatusCodeArb, errorCodeArb).map(
  ([message, statusCode, errorCode]) => {
    const err: any = new Error(message);
    err.statusCode = statusCode;
    err.errorCode = errorCode;
    return err;
  }
);

/** Generates a TypeError */
const typeErrorArb = fc.constantFrom(
  'Cannot read properties of undefined',
  'is not a function',
  'is not iterable',
  'Cannot set properties of null',
).map((msg) => {
  const err: any = new TypeError(msg);
  err.statusCode = 500;
  return err;
});

/** Generates a custom error with different status codes */
const customErrorArb = fc.tuple(
  errorMessageArb,
  errorStatusCodeArb,
  errorCodeArb,
  fc.option(fc.object(), { nil: undefined }),
).map(([message, statusCode, errorCode, details]) => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.errorCode = errorCode;
  err.details = details;
  return err;
});

/** Generates a database constraint violation error */
const dbConstraintErrorArb = fc.constantFrom(
  'duplicate key value violates unique constraint "users_email_key"',
  'unique constraint violation on audit_tasks',
  'duplicate key error: departments_name_unique',
).map((msg) => {
  const err: any = new Error(msg);
  err.code = '23505';
  err.constraint = 'some_constraint';
  return err;
});

/** Generates a database connection error */
const dbConnectionErrorArb = fc.constantFrom(
  'ECONNREFUSED',
  'connection terminated unexpectedly',
  'too many clients already',
  'Connection timed out',
).map((msg) => {
  const err: any = new Error(msg);
  err.statusCode = 503;
  err.errorCode = 'SERVICE_UNAVAILABLE';
  return err;
});

/** Generates any type of error */
const anyErrorArb = fc.oneof(
  genericErrorArb,
  typeErrorArb,
  customErrorArb,
  dbConstraintErrorArb,
  dbConnectionErrorArb,
);

/** Generates a valid UUID v4 string for correlationId */
const uuidArb = fc.uuid();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 14: Error Response Contains TraceId', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  it('always includes a non-empty traceId in error response (development mode)', () => {
    fc.assert(
      fc.property(anyErrorArb, (error) => {
        process.env.NODE_ENV = 'development';

        const req = createMockRequest();
        const { res, getBody } = createMockResponse();
        const next = vi.fn();

        globalErrorHandler(error, req as Request, res as Response, next);

        const body = getBody();
        expect(body).not.toBeNull();
        expect(body.error).toBeDefined();
        expect(body.error.traceId).toBeDefined();
        expect(typeof body.error.traceId).toBe('string');
        expect(body.error.traceId.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('always includes a non-empty traceId in error response (production mode)', () => {
    fc.assert(
      fc.property(anyErrorArb, (error) => {
        process.env.NODE_ENV = 'production';

        const req = createMockRequest();
        const { res, getBody } = createMockResponse();
        const next = vi.fn();

        globalErrorHandler(error, req as Request, res as Response, next);

        const body = getBody();
        expect(body).not.toBeNull();
        expect(body.error).toBeDefined();
        expect(body.error.traceId).toBeDefined();
        expect(typeof body.error.traceId).toBe('string');
        expect(body.error.traceId.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('uses the request correlationId when present', () => {
    fc.assert(
      fc.property(anyErrorArb, uuidArb, (error, correlationId) => {
        process.env.NODE_ENV = 'development';

        const req = createMockRequest(correlationId);
        const { res, getBody } = createMockResponse();
        const next = vi.fn();

        globalErrorHandler(error, req as Request, res as Response, next);

        const body = getBody();
        expect(body.error.traceId).toBe(correlationId);
      }),
      { numRuns: 100 }
    );
  });

  it('generates a valid UUID traceId when no correlationId is present', () => {
    fc.assert(
      fc.property(anyErrorArb, (error) => {
        process.env.NODE_ENV = 'development';

        const req = createMockRequest(); // no correlationId
        const { res, getBody } = createMockResponse();
        const next = vi.fn();

        globalErrorHandler(error, req as Request, res as Response, next);

        const body = getBody();
        expect(body.error.traceId).toMatch(UUID_REGEX);
      }),
      { numRuns: 100 }
    );
  });

  it('traceId is consistent between error.traceId and meta.requestId', () => {
    fc.assert(
      fc.property(anyErrorArb, fc.constantFrom('development', 'production'), (error, env) => {
        process.env.NODE_ENV = env;

        const req = createMockRequest();
        const { res, getBody } = createMockResponse();
        const next = vi.fn();

        globalErrorHandler(error, req as Request, res as Response, next);

        const body = getBody();
        expect(body.error.traceId).toBe(body.meta.requestId);
      }),
      { numRuns: 100 }
    );
  });
});

// @vitest-environment node
// Feature: api-quality-improvements, Property 4: Invalid ID rejection
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { validateIdParam } from '../validate.js';

/**
 * Property 4: Invalid ID rejection
 *
 * **Validates: Requirements 3.5**
 *
 * For any string that is neither a valid non-negative integer (`/^\d+$/`)
 * nor a valid UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`),
 * the `validateIdParam()` middleware SHALL respond with HTTP 400 and a validation
 * error envelope, and SHALL NOT call `next()`.
 */

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generates arbitrary strings that are NOT valid integers and NOT valid UUIDs.
 * These represent malformed ID values that should be rejected.
 */
const invalidIdArb = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
  const isInteger = /^\d+$/.test(s);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  return !isInteger && !isUuid;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockReqResNext(id: string) {
  const req = {
    params: { id },
  } as any;

  const jsonFn = vi.fn().mockReturnThis();
  const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
  const res = {
    status: statusFn,
    json: jsonFn,
  } as any;

  const next = vi.fn();

  return { req, res, next, statusFn, jsonFn };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 4: Invalid ID rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with HTTP 400 for any string that is not a valid integer or UUID', () => {
    const middleware = validateIdParam();

    fc.assert(
      fc.property(invalidIdArb, (invalidId) => {
        const { req, res, next, statusFn, jsonFn } = createMockReqResNext(invalidId);

        middleware(req, res, next);

        // MUST respond with HTTP 400
        expect(statusFn).toHaveBeenCalledWith(400);

        // MUST return an error envelope with success === false
        expect(jsonFn).toHaveBeenCalledTimes(1);
        const responseBody = jsonFn.mock.calls[0][0];
        expect(responseBody.success).toBe(false);
        expect(responseBody.data).toBeNull();
        expect(responseBody.error).toBeDefined();
        expect(responseBody.error.code).toBe('VALIDATION_ERROR');
        expect(responseBody.error.message).toContain('must be a valid integer or UUID');

        // MUST NOT call next()
        expect(next).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  it('ensures error envelope contains required metadata fields', () => {
    const middleware = validateIdParam();

    fc.assert(
      fc.property(invalidIdArb, (invalidId) => {
        const { req, res, next, jsonFn } = createMockReqResNext(invalidId);

        middleware(req, res, next);

        const responseBody = jsonFn.mock.calls[0][0];

        // Error envelope structure checks
        expect(responseBody).toHaveProperty('success', false);
        expect(responseBody).toHaveProperty('data', null);
        expect(responseBody).toHaveProperty('error');
        expect(responseBody.error).toHaveProperty('code', 'VALIDATION_ERROR');
        expect(responseBody.error).toHaveProperty('message');
        expect(responseBody.error).toHaveProperty('traceId');
        expect(responseBody).toHaveProperty('meta');
        expect(responseBody.meta).toHaveProperty('requestId');
        expect(responseBody.meta).toHaveProperty('timestamp');
        expect(responseBody.meta).toHaveProperty('version');

        // traceId and requestId should be valid UUIDs
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(responseBody.error.traceId).toMatch(uuidRegex);
        expect(responseBody.meta.requestId).toMatch(uuidRegex);

        // timestamp should be ISO 8601
        expect(new Date(responseBody.meta.timestamp).toISOString()).toBe(
          responseBody.meta.timestamp
        );
      }),
      { numRuns: 100 }
    );
  });

  it('includes field-level error details in the envelope', () => {
    const middleware = validateIdParam();

    fc.assert(
      fc.property(invalidIdArb, (invalidId) => {
        const { req, res, next, jsonFn } = createMockReqResNext(invalidId);

        middleware(req, res, next);

        const responseBody = jsonFn.mock.calls[0][0];

        // Should include details array with field-level error
        expect(responseBody.error.details).toBeDefined();
        expect(Array.isArray(responseBody.error.details)).toBe(true);
        expect(responseBody.error.details.length).toBeGreaterThan(0);

        // The detail should reference the 'id' path
        const idError = responseBody.error.details.find(
          (d: { path: string }) => d.path === 'id'
        );
        expect(idError).toBeDefined();
        expect(idError.message).toContain('must be a valid integer or UUID');
        expect(idError.code).toBe('format');
      }),
      { numRuns: 100 }
    );
  });
});

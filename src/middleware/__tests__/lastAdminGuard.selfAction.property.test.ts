// @vitest-environment node
// Feature: api-quality-improvements, Property 6: Self-action prohibition
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { lastAdminGuard } from '../lastAdminGuard.js';

/**
 * Property 6: Self-action prohibition
 *
 * **Validates: Requirements 4.7**
 *
 * For any authenticated request where the requesting user's ID equals the
 * target `:id` parameter, the `lastAdminGuard` middleware SHALL reject the
 * request with HTTP 403 and an error envelope stating the user cannot act
 * on their own account, and SHALL NOT call `next()`.
 */

describe('Property 6: Self-action prohibition', () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock DB — should never be reached for self-action checks
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
      }),
    };
  });

  function createMockReqResNext(userId: string) {
    const req = {
      params: { id: userId },
      user: { id: userId },
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

  it('rejects with 403 when req.user.id === req.params.id for any UUID', async () => {
    const middleware = lastAdminGuard(mockDb);

    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        const { req, res, next, statusFn, jsonFn } = createMockReqResNext(userId);

        await middleware(req, res, next);

        // MUST respond with HTTP 403
        expect(statusFn).toHaveBeenCalledWith(403);

        // MUST return an error envelope with success === false
        expect(jsonFn).toHaveBeenCalledTimes(1);
        const responseBody = jsonFn.mock.calls[0][0];
        expect(responseBody.success).toBe(false);
        expect(responseBody.data).toBeNull();
        expect(responseBody.error).toBeDefined();
        expect(responseBody.error.code).toBe('FORBIDDEN');
        expect(responseBody.error.message).toContain('own account');

        // MUST NOT call next()
        expect(next).not.toHaveBeenCalled();

        // DB should not be queried since self-action check fires first
        expect(mockDb.prepare).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  it('rejects with 403 for any arbitrary string ID where user acts on self', async () => {
    const middleware = lastAdminGuard(mockDb);

    // Generate non-empty strings to simulate various ID formats
    const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 64 });

    await fc.assert(
      fc.asyncProperty(nonEmptyStringArb, async (userId) => {
        const { req, res, next, statusFn, jsonFn } = createMockReqResNext(userId);

        await middleware(req, res, next);

        // MUST respond with HTTP 403
        expect(statusFn).toHaveBeenCalledWith(403);

        // MUST return error envelope
        const responseBody = jsonFn.mock.calls[0][0];
        expect(responseBody.success).toBe(false);
        expect(responseBody.error.code).toBe('FORBIDDEN');

        // MUST NOT call next()
        expect(next).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  it('ensures error envelope contains required metadata fields', async () => {
    const middleware = lastAdminGuard(mockDb);

    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        const { req, res, next, jsonFn } = createMockReqResNext(userId);

        await middleware(req, res, next);

        const responseBody = jsonFn.mock.calls[0][0];

        // Error envelope structure checks
        expect(responseBody).toHaveProperty('success', false);
        expect(responseBody).toHaveProperty('data', null);
        expect(responseBody).toHaveProperty('error');
        expect(responseBody.error).toHaveProperty('code', 'FORBIDDEN');
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
        expect(new Date(responseBody.meta.timestamp).toISOString()).toBe(responseBody.meta.timestamp);
      }),
      { numRuns: 100 }
    );
  });
});

// @vitest-environment node
// Feature: api-quality-improvements, Property 5: Last-admin protection
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { lastAdminGuard } from '../lastAdminGuard.js';

/**
 * Property 5: Last-admin protection
 *
 * **Validates: Requirements 4.2, 4.3**
 *
 * For any set of users where the target user is the sole active admin
 * (i.e., no other user has role = 'Admin' AND status = 'Active'),
 * the lastAdminGuard middleware SHALL reject the request with HTTP 403
 * and an error envelope stating the last admin cannot be removed.
 * next() SHALL never be called.
 *
 * Strategy:
 * - Generate two DIFFERENT user IDs (target != current user) to avoid self-action check
 * - Mock DB: first prepare().get() returns { role: 'Admin' } (target is admin)
 * - Mock DB: second prepare().get() returns { count: 0 } (no other active admins)
 * - Assert response is HTTP 403 with "last admin" in message
 * - Assert next() is never called
 */

describe('Property 5: Last-admin protection', () => {
  // Generate two distinct UUIDs to ensure target != current user
  const distinctUserIdPairArb = fc
    .tuple(fc.uuid(), fc.uuid())
    .filter(([a, b]) => a !== b);

  it('rejects with HTTP 403 when target is the sole active admin', async () => {
    await fc.assert(
      fc.asyncProperty(distinctUserIdPairArb, async ([currentUserId, targetId]) => {
        // Track which call we're on to return different results
        let callCount = 0;

        const mockDb = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockImplementation(async () => {
              callCount++;
              if (callCount === 1) {
                // First call: SELECT role FROM users WHERE id = ?
                return { role: 'Admin' };
              }
              // Second call: SELECT COUNT(*) ... (no other active admins)
              return { count: 0 };
            }),
          }),
        } as any;

        const statusFn = vi.fn().mockReturnThis();
        const jsonFn = vi.fn().mockReturnThis();

        const req = {
          params: { id: targetId },
          user: { id: currentUserId },
        } as any;

        const res = {
          status: statusFn,
          json: jsonFn,
        } as any;

        const next = vi.fn();

        const middleware = lastAdminGuard(mockDb);
        await middleware(req, res, next);

        // MUST respond with HTTP 403
        expect(statusFn).toHaveBeenCalledWith(403);

        // MUST include "last admin" in the error message
        expect(jsonFn).toHaveBeenCalledTimes(1);
        const responseBody = jsonFn.mock.calls[0][0];
        expect(responseBody).toHaveProperty('success', false);
        expect(responseBody).toHaveProperty('error');
        expect(responseBody.error.message.toLowerCase()).toContain('last admin');

        // next() MUST NOT be called
        expect(next).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});

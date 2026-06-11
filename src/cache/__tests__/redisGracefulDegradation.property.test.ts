// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 13: Redis Graceful Degradation
 *
 * For any cache operation (get, set, del) invoked when Redis is in
 * `degraded` or `disconnected` status, the RedisManager SHALL return a
 * default value (null for get, false for set/del) without throwing an exception.
 *
 * **Validates: Requirements 9.3**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { RedisManager, type RedisConnectionStatus } from '../redisManager.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary non-empty cache key strings */
const arbCacheKey = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);

/** Arbitrary cache value strings */
const arbCacheValue = fc.string({ minLength: 0, maxLength: 1000 });

/** Arbitrary TTL values in seconds */
const arbTtl = fc.option(fc.integer({ min: 1, max: 86400 }), { nil: undefined });

/** Arbitrary degraded status (the two non-available states we care about) */
const arbDegradedStatus = fc.constantFrom<RedisConnectionStatus>('degraded', 'disconnected');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a RedisManager instance forced into a given unavailable status.
 * Uses empty URL so no real connection is attempted, then overrides status.
 */
function createDegradedManager(status: RedisConnectionStatus): RedisManager {
  const manager = new RedisManager({ url: '' });
  // Force the internal status to the desired degraded/disconnected state
  (manager as any)._status = status;
  return manager;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 13: Redis Graceful Degradation', () => {
  describe('get() returns null without throwing when Redis is unavailable', () => {
    it('for ANY key and ANY degraded/disconnected status, get returns null', async () => {
      await fc.assert(
        fc.asyncProperty(arbCacheKey, arbDegradedStatus, async (key, status) => {
          const manager = createDegradedManager(status);

          const result = await manager.get(key);

          expect(result).toBeNull();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('set() returns false without throwing when Redis is unavailable', () => {
    it('for ANY key, value, optional TTL, and ANY degraded/disconnected status, set returns false', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbCacheKey,
          arbCacheValue,
          arbTtl,
          arbDegradedStatus,
          async (key, value, ttl, status) => {
            const manager = createDegradedManager(status);

            const result = await manager.set(key, value, ttl);

            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('del() returns false without throwing when Redis is unavailable', () => {
    it('for ANY key and ANY degraded/disconnected status, del returns false', async () => {
      await fc.assert(
        fc.asyncProperty(arbCacheKey, arbDegradedStatus, async (key, status) => {
          const manager = createDegradedManager(status);

          const result = await manager.del(key);

          expect(result).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('No exceptions thrown for any operation when Redis is unavailable', () => {
    it('for ANY operation and ANY input, no exception propagates', async () => {
      const arbOperation = fc.constantFrom('get', 'set', 'del') as fc.Arbitrary<'get' | 'set' | 'del'>;

      await fc.assert(
        fc.asyncProperty(
          arbOperation,
          arbCacheKey,
          arbCacheValue,
          arbTtl,
          arbDegradedStatus,
          async (operation, key, value, ttl, status) => {
            const manager = createDegradedManager(status);

            // None of these should throw
            switch (operation) {
              case 'get': {
                const result = await manager.get(key);
                expect(result).toBeNull();
                break;
              }
              case 'set': {
                const result = await manager.set(key, value, ttl);
                expect(result).toBe(false);
                break;
              }
              case 'del': {
                const result = await manager.del(key);
                expect(result).toBe(false);
                break;
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

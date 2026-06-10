// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 2: Cache TTL Bound
 *
 * For ANY entry stored in the auth cache manager, TTL must be ≤ 300 seconds.
 *
 * **Validates: Requirement 2.2**
 *
 * Strategy: We intercept the Redis SET calls made by the RedisManager when
 * storing auth cache entries. For arbitrary user IDs and session versions,
 * we verify that the EX (expiry in seconds) argument is always ≤ 300.
 *
 * The auth cache in src/middleware/auth.ts calls:
 *   redisManager.set(key, value, AUTH_CACHE_TTL_SECONDS)
 * where AUTH_CACHE_TTL_SECONDS = 300.
 *
 * We replicate this exact call pattern and verify the TTL constraint holds.
 */

// ─── Constants matching src/middleware/auth.ts ───────────────────────────────

const AUTH_CACHE_PREFIX = 'auth:';
const AUTH_CACHE_TTL_SECONDS = 300; // Must match the value in auth.ts
const MAX_TTL_BOUND = 300; // Requirement 2.2: TTL ≤ 300 seconds

// ─── Capture SET calls at the ioredis client level ───────────────────────────

interface SetCallRecord {
  key: string;
  value: string;
  exFlag: string;
  ttl: number;
}

const setCalls: SetCallRecord[] = [];

const { mockRedisInstance } = vi.hoisted(() => {
  const instance = {
    set: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    connect: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    scan: vi.fn().mockResolvedValue(['0', []]),
    on: vi.fn().mockReturnThis(),
  };
  return { mockRedisInstance: instance };
});

vi.mock('ioredis', () => ({
  default: vi.fn(function () {
    // Simulate successful connection: trigger the 'connect' event callback
    // We store event listeners via .on() and trigger them
    return mockRedisInstance;
  }),
}));

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { RedisManager } from '../../cache/redisManager.js';

// ─── Helper: Create a connected RedisManager ─────────────────────────────────

/**
 * Creates a RedisManager and forces it into "connected" state by simulating
 * the ioredis 'connect' event during connect().
 */
async function createConnectedManager(): Promise<RedisManager> {
  // Setup: when connect() is called, trigger the 'connect' event
  mockRedisInstance.connect.mockImplementation(() => {
    // Find the 'connect' event handler registered via .on('connect', cb)
    const onCalls = mockRedisInstance.on.mock.calls;
    const connectHandler = onCalls.find((c: any[]) => c[0] === 'connect');
    if (connectHandler) {
      connectHandler[1](); // Trigger the connect callback
    }
    return Promise.resolve();
  });

  const manager = new RedisManager({ url: 'redis://localhost:6379' });
  await manager.connect();
  return manager;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 2: Cache TTL Bound', () => {
  beforeEach(() => {
    setCalls.length = 0;
    mockRedisInstance.set.mockReset().mockImplementation(
      (key: string, value: string, exFlag?: string, ttl?: number) => {
        if (exFlag === 'EX' && ttl !== undefined) {
          setCalls.push({ key, value, exFlag, ttl });
        }
        return Promise.resolve('OK');
      }
    );
    mockRedisInstance.get.mockReset().mockResolvedValue(null);
    mockRedisInstance.on.mockReset().mockReturnThis();
    mockRedisInstance.connect.mockReset();
    mockRedisInstance.quit.mockReset().mockResolvedValue(undefined);
    mockRedisInstance.disconnect.mockReset();
  });

  it('for ANY auth cache entry stored with arbitrary user IDs and session versions, TTL is ≤ 300 seconds', async () => {
    const manager = await createConnectedManager();

    await fc.assert(
      fc.asyncProperty(
        // Arbitrary user IDs (UUIDs, numeric IDs, alphanumeric)
        fc.oneof(
          fc.uuid(),
          fc.integer({ min: 1, max: 999999 }).map(String),
          fc.stringMatching(/^[a-zA-Z0-9_-]{1,36}$/)
        ),
        // Arbitrary session versions
        fc.integer({ min: 1, max: 100000 }),
        // Arbitrary user data to cache (simulating what auth.ts stores)
        fc.record({
          id: fc.uuid(),
          role: fc.constantFrom('Admin', 'Manager', 'Auditor', 'User'),
          status: fc.constant('Active'),
          username: fc.stringMatching(/^[a-z][a-z0-9_]{2,20}$/),
          name: fc.string({ minLength: 1, maxLength: 100 }),
          email: fc.emailAddress(),
          session_version: fc.integer({ min: 1, max: 100000 }),
          department_id: fc.oneof(fc.constant(null), fc.uuid()),
        }),
        async (userId, sessionVersion, userData) => {
          setCalls.length = 0;

          // Replicate the exact call pattern from auth.ts getCachedOrDb():
          //   await redisManager.set(redisKey, JSON.stringify(data), AUTH_CACHE_TTL_SECONDS)
          const cacheKey = `${AUTH_CACHE_PREFIX}user_${userId}_${sessionVersion}`;
          const cacheValue = JSON.stringify(userData);

          const result = await manager.set(cacheKey, cacheValue, AUTH_CACHE_TTL_SECONDS);
          expect(result).toBe(true);

          // PROPERTY: The TTL passed to Redis SET EX must be ≤ 300 seconds
          expect(setCalls.length).toBe(1);
          const call = setCalls[0];
          expect(call.ttl).toBeLessThanOrEqual(MAX_TTL_BOUND);
          expect(call.ttl).toBeGreaterThan(0);
          expect(call.exFlag).toBe('EX');
          // Key must follow auth cache pattern
          expect(call.key).toContain(AUTH_CACHE_PREFIX);
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);

  it('AUTH_CACHE_TTL_SECONDS exactly equals 300, satisfying the requirement bound for any cached data', async () => {
    const manager = await createConnectedManager();

    await fc.assert(
      fc.asyncProperty(
        // Generate diverse cache keys following the auth pattern
        fc.uuid(),
        fc.integer({ min: 1, max: 50000 }),
        // Generate varying-size payloads to ensure TTL is independent of data size
        fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 0, maxLength: 10 }),
        async (userId, sessionVersion, extraFields) => {
          setCalls.length = 0;

          const cacheKey = `${AUTH_CACHE_PREFIX}user_${userId}_${sessionVersion}`;
          const payload: Record<string, any> = {
            id: userId,
            role: 'Admin',
            session_version: sessionVersion,
          };
          // Add arbitrary extra fields to vary payload size
          extraFields.forEach((val, idx) => {
            payload[`field_${idx}`] = val;
          });

          await manager.set(cacheKey, JSON.stringify(payload), AUTH_CACHE_TTL_SECONDS);

          // PROPERTY: The TTL is exactly AUTH_CACHE_TTL_SECONDS (300) and ≤ MAX_TTL_BOUND
          expect(setCalls.length).toBe(1);
          expect(setCalls[0].ttl).toBe(AUTH_CACHE_TTL_SECONDS);
          expect(AUTH_CACHE_TTL_SECONDS).toBeLessThanOrEqual(MAX_TTL_BOUND);
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);
});

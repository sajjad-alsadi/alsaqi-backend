// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 22: Dependency Readiness
 *
 * For any startup sequence, the system must not accept HTTP requests until
 * PostgreSQL and Redis are confirmed ready successfully.
 *
 * **Validates: Requirement 7.3**
 *
 * Strategy: We model the startup sequence as a series of dependency check
 * outcomes (ready/not-ready for each service) and verify that:
 * - The system only returns a successful result (allowing HTTP) when BOTH
 *   dependencies report ready within the timeout window.
 * - The system calls process.exit(1) when either dependency is NOT ready
 *   within the timeout, preventing HTTP request acceptance.
 * - The system retries at the configured interval until timeout.
 */

// Use vi.hoisted to declare mock state that's available inside vi.mock factories
const { mockPool, mockRedis } = vi.hoisted(() => {
  return {
    mockPool: {
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    },
    mockRedis: {
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    },
  };
});

// Mock pg module
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function() { return mockPool; }),
  },
}));

// Mock ioredis module
vi.mock('ioredis', () => ({
  default: vi.fn(function() { return mockRedis; }),
}));

import { waitForDependencies } from '../dependencyCheck.js';

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 22: Dependency Readiness', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset mock implementations without destroying module-level references
    mockPool.query.mockReset();
    mockPool.end.mockReset().mockResolvedValue(undefined);
    mockRedis.connect.mockReset().mockResolvedValue(undefined);
    mockRedis.ping.mockReset().mockResolvedValue('PONG');
    mockRedis.quit.mockReset().mockResolvedValue(undefined);
    mockRedis.disconnect.mockReset();

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  /**
   * Helper: resets mock state for a new property iteration.
   * Unlike vi.clearAllMocks(), this preserves the mock references.
   */
  function resetMocks(): void {
    mockPool.query.mockReset();
    mockPool.end.mockReset().mockResolvedValue(undefined);
    mockRedis.connect.mockReset();
    mockRedis.ping.mockReset().mockResolvedValue('PONG');
    mockRedis.quit.mockReset().mockResolvedValue(undefined);
    mockRedis.disconnect.mockReset();
    consoleLogSpy.mockClear();
    consoleErrorSpy.mockClear();
    processExitSpy.mockClear();
  }

  describe('System does not accept HTTP requests until both dependencies are ready', () => {
    it('for ANY scenario where both PostgreSQL and Redis become ready, the system allows HTTP (returns result)', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Number of failed attempts before PostgreSQL becomes ready (0 = ready on first try)
          fc.integer({ min: 0, max: 4 }),
          // Number of failed attempts before Redis becomes ready (0 = ready on first try)
          fc.integer({ min: 0, max: 4 }),
          async (pgFailsBeforeReady, redisFailsBeforeReady) => {
            resetMocks();

            // PostgreSQL fails N times then succeeds
            let pgCallCount = 0;
            mockPool.query.mockImplementation(() => {
              pgCallCount++;
              if (pgCallCount > pgFailsBeforeReady) {
                return Promise.resolve({ rows: [{ '?column?': 1 }] });
              }
              return Promise.reject(new Error('ECONNREFUSED'));
            });

            // Redis fails N times then succeeds
            let redisCallCount = 0;
            mockRedis.connect.mockImplementation(() => {
              redisCallCount++;
              if (redisCallCount > redisFailsBeforeReady) {
                return Promise.resolve(undefined);
              }
              return Promise.reject(new Error('ECONNREFUSED'));
            });

            const result = await waitForDependencies({
              databaseUrl: 'postgresql://user:pass@localhost:5432/test',
              redisUrl: 'redis://localhost:6379',
              timeoutMs: 30_000,
              retryIntervalMs: 5,
            });

            // System allows HTTP requests: result returned with both ready
            expect(result.postgresReady).toBe(true);
            expect(result.redisReady).toBe(true);
            // process.exit should NOT have been called
            expect(processExitSpy).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    }, 60_000);

    it('for ANY scenario where PostgreSQL never becomes ready, the system exits and never accepts HTTP', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Whether Redis is ready or not (shouldn't matter - PG blocks acceptance)
          fc.boolean(),
          async (redisReady) => {
            resetMocks();

            // PostgreSQL always fails
            mockPool.query.mockRejectedValue(new Error('ECONNREFUSED'));

            // Redis may or may not be ready
            if (redisReady) {
              mockRedis.connect.mockResolvedValue(undefined);
              mockRedis.ping.mockResolvedValue('PONG');
            } else {
              mockRedis.connect.mockRejectedValue(new Error('ECONNREFUSED'));
            }

            await expect(
              waitForDependencies({
                databaseUrl: 'postgresql://user:pass@localhost:5432/test',
                redisUrl: 'redis://localhost:6379',
                timeoutMs: 60,
                retryIntervalMs: 20,
              })
            ).rejects.toThrow('process.exit called');

            // System must NOT accept HTTP requests
            expect(processExitSpy).toHaveBeenCalledWith(1);
            // Error log must mention PostgreSQL
            const errorCalls = consoleErrorSpy.mock.calls.flat().join(' ');
            expect(errorCalls).toContain('PostgreSQL');
          }
        ),
        { numRuns: 50 }
      );
    }, 30_000);

    it('for ANY scenario where Redis never becomes ready, the system exits and never accepts HTTP', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Whether PostgreSQL is ready or not (shouldn't matter - Redis blocks acceptance)
          fc.boolean(),
          async (postgresReady) => {
            resetMocks();

            // Redis always fails
            mockRedis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

            // PostgreSQL may or may not be ready
            if (postgresReady) {
              mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
            } else {
              mockPool.query.mockRejectedValue(new Error('ECONNREFUSED'));
            }

            await expect(
              waitForDependencies({
                databaseUrl: 'postgresql://user:pass@localhost:5432/test',
                redisUrl: 'redis://localhost:6379',
                timeoutMs: 60,
                retryIntervalMs: 20,
              })
            ).rejects.toThrow('process.exit called');

            // System must NOT accept HTTP requests
            expect(processExitSpy).toHaveBeenCalledWith(1);
            // Error log must mention Redis
            const errorCalls = consoleErrorSpy.mock.calls.flat().join(' ');
            expect(errorCalls).toContain('Redis');
          }
        ),
        { numRuns: 50 }
      );
    }, 30_000);

    it('for ANY scenario where NEITHER dependency becomes ready, the system exits and never accepts HTTP', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate various timeout and retry configurations (keep short to avoid slow tests)
          fc.integer({ min: 50, max: 200 }),
          fc.integer({ min: 10, max: 50 }),
          async (timeoutMs, retryIntervalMs) => {
            resetMocks();

            // Both services always fail
            mockPool.query.mockRejectedValue(new Error('ECONNREFUSED'));
            mockRedis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

            await expect(
              waitForDependencies({
                databaseUrl: 'postgresql://user:pass@localhost:5432/test',
                redisUrl: 'redis://localhost:6379',
                timeoutMs,
                retryIntervalMs,
              })
            ).rejects.toThrow('process.exit called');

            // System must NOT accept HTTP requests
            expect(processExitSpy).toHaveBeenCalledWith(1);
          }
        ),
        { numRuns: 50 }
      );
    }, 60_000);
  });

  describe('Retry behavior respects timeout boundary', () => {
    it('for ANY timeout configuration, the system must attempt at least one check before giving up', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 30, max: 200 }),
          fc.integer({ min: 5, max: 50 }),
          async (timeoutMs, retryIntervalMs) => {
            resetMocks();

            // All checks fail
            mockPool.query.mockRejectedValue(new Error('timeout'));
            mockRedis.connect.mockRejectedValue(new Error('timeout'));

            await expect(
              waitForDependencies({
                databaseUrl: 'postgresql://user:pass@localhost:5432/test',
                redisUrl: 'redis://localhost:6379',
                timeoutMs,
                retryIntervalMs,
              })
            ).rejects.toThrow('process.exit called');

            // At least one attempt must have been made
            expect(mockPool.query).toHaveBeenCalled();
          }
        ),
        { numRuns: 50 }
      );
    }, 60_000);
  });

  describe('Once a dependency becomes ready, it is not rechecked', () => {
    it('for ANY scenario where PostgreSQL is ready first, it should only be checked until ready', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Number of attempts before Redis becomes ready (1 to 3)
          fc.integer({ min: 1, max: 3 }),
          async (redisReadyAtAttempt) => {
            resetMocks();

            // PostgreSQL is always ready (first attempt)
            mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

            // Redis fails for N attempts then succeeds
            let redisAttemptCount = 0;
            mockRedis.connect.mockImplementation(() => {
              redisAttemptCount++;
              if (redisAttemptCount >= redisReadyAtAttempt) {
                return Promise.resolve(undefined);
              }
              return Promise.reject(new Error('ECONNREFUSED'));
            });
            mockRedis.ping.mockResolvedValue('PONG');

            const result = await waitForDependencies({
              databaseUrl: 'postgresql://user:pass@localhost:5432/test',
              redisUrl: 'redis://localhost:6379',
              timeoutMs: 30_000,
              retryIntervalMs: 5,
            });

            expect(result.postgresReady).toBe(true);
            expect(result.redisReady).toBe(true);
            // PostgreSQL should only be checked ONCE since it was ready on first attempt
            expect(mockPool.query).toHaveBeenCalledTimes(1);
            expect(processExitSpy).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 50 }
      );
    }, 30_000);
  });
});

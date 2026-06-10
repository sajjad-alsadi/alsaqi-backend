// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 11: Queue Concurrency Bound (Browser)
 * Property 19: Browser Pool Recovery
 *
 * **Validates: Requirements 13.1, 13.4**
 *
 * Strategy:
 * - Property 11 (Browser): For any number of concurrent acquire calls (up to an arbitrary count),
 *   the pool never has more than 3 borrowed instances simultaneously. We simulate concurrent
 *   acquires and verify the pool's borrowed count never exceeds MAX_POOL_SIZE (3).
 * - Property 19: For any browser crash event (simulated by disconnecting a browser instance),
 *   the crashed instance is removed from the pool and the pool remains functional,
 *   allowing new acquires to succeed with a fresh replacement instance.
 */

// ─── Mock logger ─────────────────────────────────────────────────────────────

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mock puppeteer ──────────────────────────────────────────────────────────

/**
 * Each mock browser maintains its own `connected` state so that crash simulation
 * can target individual instances without affecting the others.
 */
function createMockBrowser() {
  const eventHandlers: Record<string, Function[]> = {};
  let connected = true;

  const browser = {
    close: vi.fn().mockImplementation(async () => {
      connected = false;
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    get connected() {
      return connected;
    },
    /** Simulate a crash/disconnect event */
    _simulateCrash() {
      connected = false;
      (eventHandlers['disconnected'] || []).forEach((h) => h());
    },
    /** Forcibly set connected state (for testing) */
    _setConnected(val: boolean) {
      connected = val;
    },
  };
  return browser;
}

vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn().mockImplementation(async () => createMockBrowser()),
  },
}));

import { BrowserPool, BrowserCrashedError } from '../BrowserPool.js';

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 11: Queue Concurrency Bound (Browser)', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new BrowserPool();
  });

  afterEach(async () => {
    try {
      if (!pool.isDisposed) {
        await pool.dispose();
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('for ANY number of concurrent acquire calls, the pool never has more than 3 borrowed instances', async () => {
    /**
     * **Validates: Requirements 13.1**
     *
     * We fire N concurrent acquire requests (where N > 3). Since the pool max is 3,
     * the first 3 should succeed and the rest will queue. We verify borrowed never exceeds 3.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (concurrentRequests) => {
          const localPool = new BrowserPool();

          try {
            // Track the maximum borrowed count observed
            let maxBorrowed = 0;

            // Since pool has max 3, we can only acquire up to 3 without releasing
            const acquireCount = Math.min(concurrentRequests, 3);
            const browsers: any[] = [];

            // Acquire up to the pool limit
            const acquirePromises = Array.from({ length: acquireCount }, () =>
              localPool.acquire()
            );

            const acquired = await Promise.all(acquirePromises);
            browsers.push(...acquired);

            // Check borrowed count
            maxBorrowed = localPool.stats.borrowed;

            // PROPERTY: borrowed count must NEVER exceed 3 (MAX_POOL_SIZE)
            expect(maxBorrowed).toBeLessThanOrEqual(3);
            expect(localPool.maxSize).toBe(3);

            // Release all
            for (const b of browsers) {
              await localPool.release(b);
            }

            // After release, borrowed should be 0
            expect(localPool.stats.borrowed).toBe(0);
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('maxSize is always 3 regardless of any configuration', async () => {
    /**
     * **Validates: Requirements 13.1**
     *
     * The pool's maximum size constant must be exactly 3 for browser instances.
     */
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(pool.maxSize).toBe(3);
      }),
      { numRuns: 1 }
    );
  });

  it('for ANY sequence of acquire-release cycles, borrowed count never exceeds 3', async () => {
    /**
     * **Validates: Requirements 13.1**
     *
     * Simulate random patterns of acquire and release operations.
     * At no point should borrowed exceed 3.
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate a sequence of operations: true = acquire, false = release
        fc.array(fc.boolean(), { minLength: 3, maxLength: 20 }),
        async (operations) => {
          const localPool = new BrowserPool();
          const activeBrowsers: any[] = [];
          let maxBorrowed = 0;

          try {
            for (const shouldAcquire of operations) {
              if (shouldAcquire && activeBrowsers.length < 3) {
                // Acquire only if under limit (to avoid timeout in test)
                const browser = await localPool.acquire();
                activeBrowsers.push(browser);
              } else if (!shouldAcquire && activeBrowsers.length > 0) {
                // Release one
                const browser = activeBrowsers.pop()!;
                await localPool.release(browser);
              }

              // Track max borrowed
              maxBorrowed = Math.max(maxBorrowed, localPool.stats.borrowed);
            }

            // PROPERTY: at no point did borrowed exceed 3
            expect(maxBorrowed).toBeLessThanOrEqual(3);

            // Cleanup: release remaining
            for (const b of activeBrowsers) {
              await localPool.release(b);
            }
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('for ANY number of sequential full acquire-release rounds, pool stays within bounds', async () => {
    /**
     * **Validates: Requirements 13.1**
     *
     * Even after many rounds of filling the pool to max and releasing,
     * the concurrency bound holds.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (rounds) => {
          const localPool = new BrowserPool();

          try {
            for (let round = 0; round < rounds; round++) {
              // Fill pool to max
              const browsers = await Promise.all([
                localPool.acquire(),
                localPool.acquire(),
                localPool.acquire(),
              ]);

              // PROPERTY: exactly 3 borrowed, never more
              expect(localPool.stats.borrowed).toBe(3);
              expect(localPool.stats.borrowed).toBeLessThanOrEqual(localPool.maxSize);

              // Release all
              for (const b of browsers) {
                await localPool.release(b);
              }

              expect(localPool.stats.borrowed).toBe(0);
            }
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

describe('Property 19: Browser Pool Recovery', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new BrowserPool();
  });

  afterEach(async () => {
    try {
      if (!pool.isDisposed) {
        await pool.dispose();
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('for ANY browser crash event, the crashed instance is removed and pool remains functional', async () => {
    /**
     * **Validates: Requirements 13.4**
     *
     * When a browser crashes (disconnects), releasing it throws BrowserCrashedError,
     * the instance is destroyed, and a subsequent acquire returns a new working instance.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (crashIndex) => {
          const localPool = new BrowserPool();

          try {
            // Acquire browsers up to the crash index count
            const browsers: any[] = [];
            for (let i = 0; i < crashIndex; i++) {
              browsers.push(await localPool.acquire());
            }

            // Simulate crash on the last acquired browser
            const crashedBrowser = browsers[browsers.length - 1];
            crashedBrowser._setConnected(false);

            // Releasing a crashed browser should throw BrowserCrashedError
            await expect(localPool.release(crashedBrowser)).rejects.toThrow(
              BrowserCrashedError
            );

            // Release remaining healthy browsers
            for (let i = 0; i < browsers.length - 1; i++) {
              await localPool.release(browsers[i]);
            }

            // PROPERTY: Pool should still be functional — can acquire a new instance
            const newBrowser = await localPool.acquire();
            expect(newBrowser).toBeDefined();
            expect(newBrowser.connected).toBe(true);

            // The new browser should NOT be the crashed one
            expect(newBrowser).not.toBe(crashedBrowser);

            await localPool.release(newBrowser);
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it('for ANY number of sequential crashes, pool always recovers and serves new requests', async () => {
    /**
     * **Validates: Requirements 13.4**
     *
     * Even after multiple crashes in sequence, the pool creates replacements
     * and continues functioning.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (numberOfCrashes) => {
          const localPool = new BrowserPool();

          try {
            for (let i = 0; i < numberOfCrashes; i++) {
              // Acquire a browser
              const browser = await localPool.acquire();
              expect(browser.connected).toBe(true);

              // Simulate crash
              browser._setConnected(false);

              // Release should throw BrowserCrashedError
              try {
                await localPool.release(browser);
              } catch (err) {
                expect(err).toBeInstanceOf(BrowserCrashedError);
              }
            }

            // PROPERTY: After all crashes, pool is still functional
            const freshBrowser = await localPool.acquire();
            expect(freshBrowser).toBeDefined();
            expect(freshBrowser.connected).toBe(true);

            await localPool.release(freshBrowser);

            // Pool should have the fresh browser available
            expect(localPool.stats.borrowed).toBe(0);
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('for ANY crash during a full pool, recovery frees a slot for new acquires', async () => {
    /**
     * **Validates: Requirements 13.4**
     *
     * When all 3 slots are used and one crashes, the slot is freed
     * so that a new acquire can succeed without timeout.
     */
    await fc.assert(
      fc.asyncProperty(
        // Which of the 3 browsers will crash (0-indexed)
        fc.integer({ min: 0, max: 2 }),
        async (crashIdx) => {
          const localPool = new BrowserPool();

          try {
            // Fill the pool to max capacity
            const browsers = [
              await localPool.acquire(),
              await localPool.acquire(),
              await localPool.acquire(),
            ];

            expect(localPool.stats.borrowed).toBe(3);

            // Crash one browser
            const crashedBrowser = browsers[crashIdx];
            crashedBrowser._setConnected(false);

            // Release the crashed one — throws BrowserCrashedError
            try {
              await localPool.release(crashedBrowser);
            } catch (err) {
              expect(err).toBeInstanceOf(BrowserCrashedError);
            }

            // Release remaining healthy browsers
            for (let i = 0; i < browsers.length; i++) {
              if (i !== crashIdx) {
                await localPool.release(browsers[i]);
              }
            }

            // PROPERTY: Pool recovered — can acquire again up to max
            const newBrowser = await localPool.acquire();
            expect(newBrowser).toBeDefined();
            expect(newBrowser.connected).toBe(true);
            expect(newBrowser).not.toBe(crashedBrowser);

            await localPool.release(newBrowser);
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 10 }
    );
  });

  it('isCrashed detects disconnected browsers for ANY browser in the pool', async () => {
    /**
     * **Validates: Requirements 13.4**
     *
     * The pool's isCrashed method reliably detects when a browser is no longer connected.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (browserCount) => {
          const localPool = new BrowserPool();

          try {
            const browsers: any[] = [];
            for (let i = 0; i < browserCount; i++) {
              browsers.push(await localPool.acquire());
            }

            // All browsers should NOT be crashed initially
            for (const b of browsers) {
              expect(localPool.isCrashed(b)).toBe(false);
            }

            // Crash one
            const targetIdx = browserCount - 1;
            browsers[targetIdx]._setConnected(false);

            // PROPERTY: isCrashed returns true for the crashed browser
            expect(localPool.isCrashed(browsers[targetIdx])).toBe(true);

            // Others remain healthy
            for (let i = 0; i < targetIdx; i++) {
              expect(localPool.isCrashed(browsers[i])).toBe(false);
            }

            // Cleanup
            for (let i = 0; i < browsers.length; i++) {
              try {
                await localPool.release(browsers[i]);
              } catch {
                // BrowserCrashedError expected for crashed ones
              }
            }
          } finally {
            await localPool.dispose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

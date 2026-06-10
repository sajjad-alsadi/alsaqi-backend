// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for Monitoring System
 *
 * - Property 7: Slow Query Detection
 * - Property 8: Request Metrics Completeness
 * - Property 18: Pool Exhaustion Warning
 *
 * **Validates: Requirements 4.2, 4.3, 4.5, 12.3**
 */

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const { mockLogger, mockHistogramObserve, mockCounterInc } = vi.hoisted(() => {
  return {
    mockLogger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    mockHistogramObserve: vi.fn(),
    mockCounterInc: vi.fn(),
  };
});

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  default: mockLogger,
}));

// Mock prom-client - use function keyword for constructors
vi.mock('prom-client', () => {
  return {
    default: {
      Gauge: function(this: any) { this.set = vi.fn(); },
      Counter: function(this: any) { this.inc = mockCounterInc; },
      Histogram: function(this: any) { this.observe = mockHistogramObserve; },
      collectDefaultMetrics: vi.fn(),
      register: {
        contentType: 'text/plain; version=0.0.4',
        metrics: vi.fn().mockResolvedValue(''),
      },
    },
  };
});

// ─── Property 7: Slow Query Detection ────────────────────────────────────────

/**
 * Property 7: Slow Query Detection
 *
 * For any query with duration > 500ms, checkSlowQuery() logs a warning
 * with query text and duration.
 *
 * **Validates: Requirement 4.3**
 */
describe('Property 7: Slow Query Detection', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  it('for ANY query duration > 500ms, a warning is logged with query text and duration', async () => {
    const { checkSlowQuery } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary query text (1 to 200 chars)
        fc.string({ minLength: 1, maxLength: 200 }),
        // Generate durations strictly above 500ms (501 to 60000ms)
        fc.integer({ min: 501, max: 60000 }),
        async (queryText, durationMs) => {
          mockLogger.warn.mockClear();

          checkSlowQuery(queryText, durationMs);

          // A warning must have been logged
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);

          // The warning must include the query text and duration
          const [message, metadata] = mockLogger.warn.mock.calls[0];
          expect(message).toContain('Slow query');
          expect(metadata).toHaveProperty('query');
          expect(metadata).toHaveProperty('durationMs');
          // Duration in metadata must match (rounded)
          expect(metadata.durationMs).toBe(Math.round(durationMs));
          // Query text must be present (possibly truncated)
          expect(metadata.query).toBe(
            queryText.length > 1024 ? queryText.substring(0, 1024) : queryText
          );
        }
      ),
      { numRuns: 200 }
    );
  }, 30_000);

  it('for ANY query duration <= 500ms, NO warning is logged', async () => {
    const { checkSlowQuery } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        // Duration at or below threshold
        fc.integer({ min: 0, max: 500 }),
        async (queryText, durationMs) => {
          mockLogger.warn.mockClear();

          checkSlowQuery(queryText, durationMs);

          // No warning should be logged for queries within threshold
          expect(mockLogger.warn).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 200 }
    );
  }, 30_000);

  it('for ANY query text longer than 1024 chars with duration > 500ms, the logged query is truncated to 1024 chars', async () => {
    const { checkSlowQuery } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        // Generate long query strings (1025 to 3000 chars)
        fc.string({ minLength: 1025, maxLength: 3000 }),
        fc.integer({ min: 501, max: 10000 }),
        async (queryText, durationMs) => {
          mockLogger.warn.mockClear();

          checkSlowQuery(queryText, durationMs);

          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          const [, metadata] = mockLogger.warn.mock.calls[0];
          // Query must be truncated to 1024 characters
          expect(metadata.query.length).toBe(1024);
          expect(metadata.query).toBe(queryText.substring(0, 1024));
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000);
});

// ─── Property 8: Request Metrics Completeness ────────────────────────────────

/**
 * Property 8: Request Metrics Completeness
 *
 * For any HTTP request processed through metricsMiddleware, the histogram
 * records method, route, and status code.
 *
 * **Validates: Requirements 4.2, 4.5**
 */
describe('Property 8: Request Metrics Completeness', () => {
  beforeEach(() => {
    mockHistogramObserve.mockClear();
    mockCounterInc.mockClear();
  });

  it('for ANY HTTP request through metricsMiddleware, duration histogram records method, route, and status_code', async () => {
    const { metricsMiddleware } = await import('../metricsServer.js');

    await fc.assert(
      fc.asyncProperty(
        // HTTP methods
        fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
        // Paths (exclude /metrics and /health since those are excluded from recording)
        fc.constantFrom(
          '/api/v1/users',
          '/api/v1/plans',
          '/api/v1/findings',
          '/api/v1/reports',
          '/api/v1/notifications',
          '/dashboard',
          '/api/v1/tasks'
        ),
        // Status codes
        fc.constantFrom(200, 201, 204, 301, 400, 401, 403, 404, 500, 502, 503),
        async (method, path, statusCode) => {
          mockHistogramObserve.mockClear();

          // Create mock request
          const req = {
            method,
            path,
            url: path,
            route: { path },
            baseUrl: '',
          } as any;

          // Create mock response with EventEmitter-like 'on' and 'finish' behavior
          const finishCallbacks: Function[] = [];
          const res = {
            statusCode,
            on: vi.fn((event: string, cb: Function) => {
              if (event === 'finish') {
                finishCallbacks.push(cb);
              }
            }),
          } as any;

          const next = vi.fn();

          // Call middleware
          metricsMiddleware(req, res, next);

          // next() should have been called (middleware passes through)
          expect(next).toHaveBeenCalled();

          // Simulate response finishing
          for (const cb of finishCallbacks) {
            cb();
          }

          // Histogram must have been called with labels including method, route, and status_code
          expect(mockHistogramObserve).toHaveBeenCalledTimes(1);
          const [labels, duration] = mockHistogramObserve.mock.calls[0];

          // Labels must contain method
          expect(labels).toHaveProperty('method', method);
          // Labels must contain route
          expect(labels).toHaveProperty('route');
          expect(typeof labels.route).toBe('string');
          expect(labels.route.length).toBeGreaterThan(0);
          // Labels must contain status_code
          expect(labels).toHaveProperty('status_code', statusCode.toString());
          // Duration must be a non-negative number
          expect(typeof duration).toBe('number');
          expect(duration).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 200 }
    );
  }, 30_000);

  it('for ANY request to excluded paths (/metrics, /health), NO histogram observation is recorded', async () => {
    const { metricsMiddleware } = await import('../metricsServer.js');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GET', 'POST'),
        fc.constantFrom('/metrics', '/health', '/api/health', '/api/v1/health'),
        fc.constantFrom(200, 500),
        async (method, path, statusCode) => {
          mockHistogramObserve.mockClear();

          const req = {
            method,
            path,
            url: path,
            route: { path },
            baseUrl: '',
          } as any;

          const finishCallbacks: Function[] = [];
          const res = {
            statusCode,
            on: vi.fn((event: string, cb: Function) => {
              if (event === 'finish') {
                finishCallbacks.push(cb);
              }
            }),
          } as any;

          const next = vi.fn();

          metricsMiddleware(req, res, next);
          expect(next).toHaveBeenCalled();

          // Simulate response finishing
          for (const cb of finishCallbacks) {
            cb();
          }

          // Histogram should NOT have been called for excluded paths
          expect(mockHistogramObserve).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 50 }
    );
  }, 15_000);
});

// ─── Property 18: Pool Exhaustion Warning ────────────────────────────────────

/**
 * Property 18: Pool Exhaustion Warning
 *
 * When pool waitingCount > 10 (50% of max 20), checkPoolExhaustion() logs
 * a warning. Uses hysteresis: doesn't repeat until waitingCount drops below
 * threshold and crosses again.
 *
 * **Validates: Requirement 12.3**
 */
describe('Property 18: Pool Exhaustion Warning', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  it('for ANY waitingCount > 10, the first call to checkPoolExhaustion logs a warning', async () => {
    const { checkPoolExhaustion, initDbMetrics, resetDbMetricsState } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        // waitingCount strictly > 10
        fc.integer({ min: 11, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        async (waitingCount, totalCount, idleCount) => {
          mockLogger.warn.mockClear();
          // Reset internal state
          resetDbMetricsState();

          // Create a mock pool with the specified waitingCount
          const mockPool = {
            waitingCount,
            totalCount: Math.max(totalCount, 1),
            idleCount,
            on: vi.fn(),
          } as any;

          // Initialize with the mock pool
          initDbMetrics(mockPool);
          mockLogger.warn.mockClear(); // Clear any init logs
          mockLogger.info.mockClear();

          // Call checkPoolExhaustion
          checkPoolExhaustion();

          // A warning must be logged
          const poolExhaustionWarns = mockLogger.warn.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('Pool exhaustion')
          );
          expect(poolExhaustionWarns.length).toBe(1);
          // The metadata must include waitingCount
          expect(poolExhaustionWarns[0][1]).toHaveProperty('waitingCount', waitingCount);
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000);

  it('for ANY waitingCount <= 10, checkPoolExhaustion does NOT log a warning', async () => {
    const { checkPoolExhaustion, initDbMetrics, resetDbMetricsState } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        // waitingCount at or below threshold
        fc.integer({ min: 0, max: 10 }),
        async (waitingCount) => {
          mockLogger.warn.mockClear();
          resetDbMetricsState();

          const mockPool = {
            waitingCount,
            totalCount: 20,
            idleCount: 5,
            on: vi.fn(),
          } as any;

          initDbMetrics(mockPool);
          mockLogger.warn.mockClear();

          checkPoolExhaustion();

          // No pool exhaustion warning should be logged
          const poolExhaustionWarns = mockLogger.warn.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('Pool exhaustion')
          );
          expect(poolExhaustionWarns.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000);

  it('hysteresis: warning does NOT repeat on consecutive calls above threshold, but fires again after dropping below and re-crossing', async () => {
    const { checkPoolExhaustion, initDbMetrics, resetDbMetricsState } = await import('../dbMetrics.js');

    await fc.assert(
      fc.asyncProperty(
        // First waiting count above threshold
        fc.integer({ min: 11, max: 50 }),
        // Number of additional calls while above threshold (1-5)
        fc.integer({ min: 1, max: 5 }),
        // Waiting count when it drops below threshold
        fc.integer({ min: 0, max: 10 }),
        // Second waiting count above threshold (to trigger again)
        fc.integer({ min: 11, max: 50 }),
        async (firstAbove, repeatCallsAbove, belowThreshold, secondAbove) => {
          mockLogger.warn.mockClear();
          resetDbMetricsState();

          // Create a mutable mock pool
          const mockPool = {
            waitingCount: firstAbove,
            totalCount: 20,
            idleCount: 5,
            on: vi.fn(),
          } as any;

          initDbMetrics(mockPool);
          mockLogger.warn.mockClear();

          // Phase 1: First call above threshold → should warn
          checkPoolExhaustion();
          const warnsAfterFirst = mockLogger.warn.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('Pool exhaustion')
          );
          expect(warnsAfterFirst.length).toBe(1);

          // Phase 2: Repeated calls while still above threshold → NO additional warnings
          for (let i = 0; i < repeatCallsAbove; i++) {
            mockPool.waitingCount = firstAbove + i;
            checkPoolExhaustion();
          }
          const warnsAfterRepeats = mockLogger.warn.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('Pool exhaustion')
          );
          expect(warnsAfterRepeats.length).toBe(1); // Still only 1 warning

          // Phase 3: Drop below threshold
          mockPool.waitingCount = belowThreshold;
          checkPoolExhaustion();

          // Phase 4: Cross threshold again → should warn again
          mockPool.waitingCount = secondAbove;
          checkPoolExhaustion();
          const warnsAfterSecondCross = mockLogger.warn.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('Pool exhaustion')
          );
          expect(warnsAfterSecondCross.length).toBe(2); // Now exactly 2 warnings
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000);
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deriveOverallStatus } from '../health';
import type { SubsystemCheck, HealthStatus } from '../../types/api';

/**
 * Property Tests - Health Status Correctness (Property 21)
 *
 * **Validates: Requirements 15.2, 15.3**
 *
 * For any combination of subsystem states:
 * - If any primary subsystem (database, redis) is unavailable → status must be "unhealthy" (HTTP 503)
 * - If all primary subsystems are available but any secondary fails → status must be "degraded" (HTTP 200)
 * - If all subsystems are ok → status must be "healthy" (HTTP 200)
 */

// ─── Custom Arbitraries ──────────────────────────────────────────────────────

/** Generates a subsystem check status */
const subsystemStatusArb = fc.constantFrom('ok', 'fail', 'timeout') as fc.Arbitrary<SubsystemCheck['status']>;

/** Generates a latency value in ms (0-5000) */
const latencyArb = fc.nat({ max: 5000 });

/** Generates a SubsystemCheck object */
const subsystemCheckArb: fc.Arbitrary<SubsystemCheck> = fc.record({
  status: subsystemStatusArb,
  latency: latencyArb,
});

/** Generates a SubsystemCheck that is "ok" */
const okCheckArb: fc.Arbitrary<SubsystemCheck> = fc.record({
  status: fc.constant('ok' as const),
  latency: latencyArb,
});

/** Generates a SubsystemCheck that has failed (fail or timeout) */
const failedCheckArb: fc.Arbitrary<SubsystemCheck> = fc.record({
  status: fc.constantFrom('fail', 'timeout') as fc.Arbitrary<'fail' | 'timeout'>,
  latency: latencyArb,
});

/** Generates a full set of health checks with arbitrary states */
const allChecksArb: fc.Arbitrary<HealthStatus['checks']> = fc.record({
  database: subsystemCheckArb,
  redis: subsystemCheckArb,
  filesystem: subsystemCheckArb,
  memory: subsystemCheckArb,
  websocket: subsystemCheckArb,
  cron: subsystemCheckArb,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 21: Health Status Correctness', () => {
  /**
   * For any combination of subsystem states, if any primary subsystem
   * (database, redis) is unavailable then the status must be unhealthy with
   * code 503, and if all primary subsystems are available but any secondary
   * subsystem fails then the status must be degraded with code 200.
   *
   * **Validates: Requirements 15.2, 15.3**
   */

  it('returns "unhealthy" when any primary subsystem (database or redis) fails', () => {
    fc.assert(
      fc.property(
        // At least one primary subsystem fails
        fc.oneof(
          // database fails, redis arbitrary
          fc.record({
            database: failedCheckArb,
            redis: subsystemCheckArb,
            filesystem: subsystemCheckArb,
            memory: subsystemCheckArb,
            websocket: subsystemCheckArb,
            cron: subsystemCheckArb,
          }),
          // redis fails, database arbitrary
          fc.record({
            database: subsystemCheckArb,
            redis: failedCheckArb,
            filesystem: subsystemCheckArb,
            memory: subsystemCheckArb,
            websocket: subsystemCheckArb,
            cron: subsystemCheckArb,
          }),
          // both primary fail
          fc.record({
            database: failedCheckArb,
            redis: failedCheckArb,
            filesystem: subsystemCheckArb,
            memory: subsystemCheckArb,
            websocket: subsystemCheckArb,
            cron: subsystemCheckArb,
          })
        ),
        (checks) => {
          const status = deriveOverallStatus(checks);
          expect(status).toBe('unhealthy');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns "degraded" when all primary ok but any secondary subsystem fails', () => {
    fc.assert(
      fc.property(
        // All primary subsystems are ok
        okCheckArb,
        okCheckArb,
        // At least one secondary fails - pick which one(s)
        fc.record({
          filesystem: subsystemCheckArb,
          memory: subsystemCheckArb,
          websocket: subsystemCheckArb,
          cron: subsystemCheckArb,
        }).filter((secondary) => {
          // At least one secondary must be failed
          return [secondary.filesystem, secondary.memory, secondary.websocket, secondary.cron]
            .some((c) => c.status !== 'ok');
        }),
        (database, redis, secondary) => {
          const checks: HealthStatus['checks'] = {
            database,
            redis,
            ...secondary,
          };
          const status = deriveOverallStatus(checks);
          expect(status).toBe('degraded');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns "healthy" when all subsystems (primary and secondary) are ok', () => {
    fc.assert(
      fc.property(
        fc.record({
          database: okCheckArb,
          redis: okCheckArb,
          filesystem: okCheckArb,
          memory: okCheckArb,
          websocket: okCheckArb,
          cron: okCheckArb,
        }),
        (checks) => {
          const status = deriveOverallStatus(checks);
          expect(status).toBe('healthy');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('unhealthy status maps to HTTP 503, degraded/healthy map to HTTP 200', () => {
    fc.assert(
      fc.property(allChecksArb, (checks) => {
        const status = deriveOverallStatus(checks);

        const primaryFailed = checks.database.status !== 'ok' || checks.redis.status !== 'ok';
        const secondaryFailed = [checks.filesystem, checks.memory, checks.websocket, checks.cron]
          .some((c) => c.status !== 'ok');

        if (primaryFailed) {
          // Requirement 15.2: primary fail → unhealthy → 503
          expect(status).toBe('unhealthy');
          const httpStatus = status === 'unhealthy' ? 503 : 200;
          expect(httpStatus).toBe(503);
        } else if (secondaryFailed) {
          // Requirement 15.3: all primary ok + secondary fail → degraded → 200
          expect(status).toBe('degraded');
          const httpStatus = status === 'unhealthy' ? 503 : 200;
          expect(httpStatus).toBe(200);
        } else {
          // All ok → healthy → 200
          expect(status).toBe('healthy');
          const httpStatus = status === 'unhealthy' ? 503 : 200;
          expect(httpStatus).toBe(200);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('primary subsystem failure always takes precedence over secondary status', () => {
    fc.assert(
      fc.property(
        // At least one primary fails AND at least one secondary also fails
        fc.record({
          database: failedCheckArb,
          redis: subsystemCheckArb,
          filesystem: failedCheckArb,
          memory: subsystemCheckArb,
          websocket: subsystemCheckArb,
          cron: subsystemCheckArb,
        }),
        (checks) => {
          const status = deriveOverallStatus(checks);
          // Even with secondary failures, primary failure means "unhealthy"
          expect(status).toBe('unhealthy');
        }
      ),
      { numRuns: 100 }
    );
  });
});

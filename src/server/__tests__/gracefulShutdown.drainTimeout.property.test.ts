// @vitest-environment node
// Feature: backend-security-hardening, Property 31: Drain timeout parsing and clamping
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  clampDrainTimeoutMs,
  DRAIN_TIMEOUT_MIN_MS,
  DRAIN_TIMEOUT_MAX_MS,
  DRAIN_TIMEOUT_DEFAULT_MS,
} from '../gracefulShutdown.js';

/**
 * Property 31: Drain timeout parsing and clamping
 *
 * **Validates: Requirements 23.2**
 *
 * For any raw drain-timeout configuration value, `clampDrainTimeoutMs` resolves to
 * a millisecond count guaranteed to sit within the inclusive accepted range
 * [1000, 120000]. Out-of-range finite integers are clamped to the nearest bound,
 * while absent (`undefined`) or non-finite (`NaN`, `±Infinity`) values fall back to
 * the documented default of 30000 ms.
 *
 * This validates three facets of the contract:
 *   1. The result is always within [DRAIN_TIMEOUT_MIN_MS, DRAIN_TIMEOUT_MAX_MS].
 *   2. Out-of-range finite integers clamp to the nearest bound.
 *   3. `undefined` / non-finite input resolves to DRAIN_TIMEOUT_DEFAULT_MS.
 */
describe('Property 31: Drain timeout parsing and clamping', () => {
  it('always returns a value within [1000, 120000] for any input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.constantFrom(
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY
          )
        ),
        (raw) => {
          const result = clampDrainTimeoutMs(raw as number | undefined);
          expect(result).toBeGreaterThanOrEqual(DRAIN_TIMEOUT_MIN_MS);
          expect(result).toBeLessThanOrEqual(DRAIN_TIMEOUT_MAX_MS);
          expect(Number.isInteger(result)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('clamps out-of-range finite integers to the nearest bound', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: DRAIN_TIMEOUT_MAX_MS + 1, max: Number.MAX_SAFE_INTEGER }),
        (above) => {
          expect(clampDrainTimeoutMs(above)).toBe(DRAIN_TIMEOUT_MAX_MS);
        }
      ),
      { numRuns: 200 }
    );

    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: DRAIN_TIMEOUT_MIN_MS - 1 }),
        (below) => {
          expect(clampDrainTimeoutMs(below)).toBe(DRAIN_TIMEOUT_MIN_MS);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns in-range finite integers unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: DRAIN_TIMEOUT_MIN_MS, max: DRAIN_TIMEOUT_MAX_MS }),
        (inRange) => {
          expect(clampDrainTimeoutMs(inRange)).toBe(inRange);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('uses the default of 30000 for undefined / non-finite input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          undefined,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY
        ),
        (raw) => {
          expect(clampDrainTimeoutMs(raw as number | undefined)).toBe(
            DRAIN_TIMEOUT_DEFAULT_MS
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

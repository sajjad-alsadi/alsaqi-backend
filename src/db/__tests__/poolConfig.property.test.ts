// @vitest-environment node
// Feature: backend-security-hardening, Property 3: Pool configuration parsing and validation
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 3: Pool configuration parsing and validation
 *
 * For any values of the pool environment variables, `parsePoolConfig` accepts a value
 * only when it is an integer within its range (max 1..1000, acquire-timeout 1..60000),
 * substitutes the documented default (20, 2000) when a variable is unset, and otherwise
 * returns a failure that names the rejected variable and its accepted range.
 *
 * **Validates: Requirements 1.6, 2.1, 2.2, 2.3**
 */

import { parsePoolConfig } from '../poolConfig.js';

// ─── Specs under test ──────────────────────────────────────────────────────────

const MAX_VAR = 'DB_POOL_MAX';
const MAX_MIN = 1;
const MAX_MAX = 1000;
const MAX_DEFAULT = 20;
const MAX_RANGE = 'integer 1..1000';

const TIMEOUT_VAR = 'DB_POOL_ACQUIRE_TIMEOUT_MS';
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 60000;
const TIMEOUT_DEFAULT = 2000;
const TIMEOUT_RANGE = 'integer 1..60000';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds an env object, omitting keys whose value is `undefined`. */
function buildEnv(
  max: string | undefined,
  timeout: string | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (max !== undefined) env.DB_POOL_MAX = max;
  if (timeout !== undefined) env.DB_POOL_ACQUIRE_TIMEOUT_MS = timeout;
  return env;
}

/** Optional surrounding whitespace so trimming behavior is exercised. */
const whitespacePad = fc.constantFrom('', ' ', '  ', '\t', ' \t ', '\n');

/** A string that renders an integer within [min, max], possibly with whitespace/sign. */
function inRangeIntStringArb(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .integer({ min, max })
    .chain((n) =>
      fc.tuple(whitespacePad, whitespacePad, fc.constantFrom('', '+')).map(
        ([pre, post, sign]) => `${pre}${sign}${n}${post}`
      )
    );
}

/** A string for an out-of-range integer (below min or above max). */
function outOfRangeIntStringArb(min: number, max: number): fc.Arbitrary<string> {
  return fc.oneof(
    fc.integer({ min: max + 1, max: max + 1_000_000 }).map(String),
    fc.integer({ min: min - 1_000_000, max: min - 1 }).map(String)
  );
}

/** A non-empty, non-integer string (after trimming). */
function nonIntegerStringArb(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((s) => {
      const t = s.trim();
      return t !== '' && !/^[+-]?\d+$/.test(t);
    });
}

/** An "unset-equivalent" value: undefined or whitespace-only. */
const unsetEquivalentArb = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constantFrom(' ', '   ', '\t', '\n', ' \t\n ')
);

// ─── Properties ────────────────────────────────────────────────────────────────

describe('Property 3: Pool configuration parsing and validation', () => {
  it('accepts any in-range integer for both variables and returns those values', () => {
    fc.assert(
      fc.property(
        inRangeIntStringArb(MAX_MIN, MAX_MAX),
        inRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
        (maxStr, timeoutStr) => {
          const result = parsePoolConfig(buildEnv(maxStr, timeoutStr));
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.config.max).toBe(Number.parseInt(maxStr.trim(), 10));
            expect(result.config.connectionTimeoutMillis).toBe(
              Number.parseInt(timeoutStr.trim(), 10)
            );
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('substitutes the documented defaults when a variable is unset or whitespace-only', () => {
    fc.assert(
      fc.property(unsetEquivalentArb, unsetEquivalentArb, (maxRaw, timeoutRaw) => {
        const result = parsePoolConfig(buildEnv(maxRaw, timeoutRaw));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.config.max).toBe(MAX_DEFAULT);
          expect(result.config.connectionTimeoutMillis).toBe(TIMEOUT_DEFAULT);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects an out-of-range DB_POOL_MAX naming the variable and its accepted range', () => {
    fc.assert(
      fc.property(
        outOfRangeIntStringArb(MAX_MIN, MAX_MAX),
        inRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
        (badMax, goodTimeout) => {
          const result = parsePoolConfig(buildEnv(badMax, goodTimeout));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.variable).toBe(MAX_VAR);
            expect(result.error.acceptedRange).toBe(MAX_RANGE);
            expect(result.error.received).toBe(badMax);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('rejects an out-of-range DB_POOL_ACQUIRE_TIMEOUT_MS naming the variable and its accepted range', () => {
    fc.assert(
      fc.property(
        inRangeIntStringArb(MAX_MIN, MAX_MAX),
        outOfRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
        (goodMax, badTimeout) => {
          const result = parsePoolConfig(buildEnv(goodMax, badTimeout));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.variable).toBe(TIMEOUT_VAR);
            expect(result.error.acceptedRange).toBe(TIMEOUT_RANGE);
            expect(result.error.received).toBe(badTimeout);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('rejects a non-integer value, naming the offending variable', () => {
    fc.assert(
      fc.property(
        nonIntegerStringArb(),
        inRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
        (badMax, goodTimeout) => {
          const result = parsePoolConfig(buildEnv(badMax, goodTimeout));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.variable).toBe(MAX_VAR);
            expect(result.error.acceptedRange).toBe(MAX_RANGE);
            expect(result.error.received).toBe(badMax);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('reports the rejected variable for any accepted value only when it is an integer in range', () => {
    // Universal invariant: a result is `ok` iff BOTH variables are unset/whitespace
    // or an in-range integer; otherwise it fails naming exactly one rejected variable.
    const candidateArb = fc.oneof(
      unsetEquivalentArb,
      inRangeIntStringArb(MAX_MIN, MAX_MAX),
      outOfRangeIntStringArb(MAX_MIN, MAX_MAX),
      nonIntegerStringArb()
    );
    const timeoutCandidateArb = fc.oneof(
      unsetEquivalentArb,
      inRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
      outOfRangeIntStringArb(TIMEOUT_MIN, TIMEOUT_MAX),
      nonIntegerStringArb()
    );

    const isAcceptable = (raw: string | undefined, min: number, max: number): boolean => {
      if (raw === undefined) return true;
      const t = raw.trim();
      if (t === '') return true;
      if (!/^[+-]?\d+$/.test(t)) return false;
      const n = Number.parseInt(t, 10);
      return Number.isInteger(n) && n >= min && n <= max;
    };

    fc.assert(
      fc.property(candidateArb, timeoutCandidateArb, (maxRaw, timeoutRaw) => {
        const result = parsePoolConfig(buildEnv(maxRaw, timeoutRaw));
        const maxOk = isAcceptable(maxRaw, MAX_MIN, MAX_MAX);
        const timeoutOk = isAcceptable(timeoutRaw, TIMEOUT_MIN, TIMEOUT_MAX);

        if (maxOk && timeoutOk) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // max is validated first, so it is named when it is the offender.
            const expectedVar = !maxOk ? MAX_VAR : TIMEOUT_VAR;
            expect(result.error.variable).toBe(expectedVar);
            expect(result.error.acceptedRange.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 300 }
    );
  });
});

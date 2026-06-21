// @vitest-environment node
// Feature: production-launch-readiness, Property 3: Deterministic, clamped pool-config resolution
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 3: حلّ إعداد التجمّع حتمي ومُقيَّد
 *
 * For ANY environment map, `resolvePoolRuntimeConfig(env)` produces values within
 * the defined bounds:
 *   - statementTimeoutMs        ∈ [1000, 120000], default 30000
 *   - acquisitionTimeoutMillis  ∈ [1000, 30000],  default 10000
 *   - max  a positive integer   ∈ [1, API_DB_CONN_CAP], default 10
 * Out-of-range numeric inputs clamp to the nearest bound; missing/non-numeric
 * inputs resolve to the documented default.
 *
 * Validates: Requirements 7.1, 7.4, 7.5
 */

import {
  resolvePoolRuntimeConfig,
  DEFAULT_API_DB_CONN_CAP,
} from '../poolConfig.js';

// ─── Documented bounds (mirror of the resolver under test) ───────────────────

const STATEMENT_TIMEOUT_DEFAULT = 30000;
const STATEMENT_TIMEOUT_MIN = 1000;
const STATEMENT_TIMEOUT_MAX = 120000;

const ACQUIRE_TIMEOUT_DEFAULT = 10000;
const ACQUIRE_TIMEOUT_MIN = 1000;
const ACQUIRE_TIMEOUT_MAX = 30000;

const POOL_MAX_DEFAULT = 10;
const POOL_MAX_MIN = 1;

// ─── Independent reference oracle ────────────────────────────────────────────

/** Parses to a finite number, or null for unset/whitespace/non-numeric input. */
function toFinite(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function expectedConnCap(raw: string | undefined): number {
  const value = toFinite(raw);
  if (value === null) return DEFAULT_API_DB_CONN_CAP;
  const floored = Math.floor(value);
  return floored < POOL_MAX_MIN ? POOL_MAX_MIN : floored;
}

function expectedMax(raw: string | undefined, cap: number): number {
  const value = toFinite(raw);
  const resolved = value === null ? POOL_MAX_DEFAULT : Math.floor(value);
  return clamp(resolved, POOL_MAX_MIN, cap);
}

function expectedClampedMs(
  raw: string | undefined,
  min: number,
  max: number,
  def: number
): number {
  const value = toFinite(raw);
  return value === null ? def : clamp(value, min, max);
}

// ─── Env-value generators spanning the documented input space ────────────────

const whitespacePad = fc.constantFrom('', ' ', '  ', '\t', ' \t ', '\n');

/** undefined, empty, or whitespace-only → should resolve to the default. */
const missingArb = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constantFrom('', ' ', '   ', '\t', '\n', ' \t\n ')
);

/** Non-numeric junk strings → should resolve to the default. */
const nonNumericArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => {
    const t = s.trim();
    return t !== '' && !Number.isFinite(Number(t));
  });

/** Numeric strings (integers + decimals + signs), possibly padded — wide range. */
function numericStringArb(min: number, max: number): fc.Arbitrary<string> {
  const ints = fc.integer({ min, max }).map(String);
  const decimals = fc
    .double({ min, max, noNaN: true, noDefaultInfinity: true })
    .map((d) => String(d));
  return fc
    .tuple(fc.oneof(ints, decimals), whitespacePad, whitespacePad)
    .map(([n, pre, post]) => `${pre}${n}${post}`);
}

/** A value generator that covers undefined/empty/non-numeric/below/above/in-range/decimals. */
function envValueArb(min: number, max: number): fc.Arbitrary<string | undefined> {
  return fc.oneof(
    missingArb,
    nonNumericArb,
    // below-min
    numericStringArb(min - 1_000_000, min - 1),
    // above-max
    numericStringArb(max + 1, max + 1_000_000),
    // in-range (includes decimals)
    numericStringArb(min, max)
  );
}

/** Builds an env object, omitting keys whose value is `undefined`. */
function buildEnv(
  poolMax: string | undefined,
  acquire: string | undefined,
  statement: string | undefined,
  connCap: string | undefined
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (poolMax !== undefined) env.DB_POOL_MAX = poolMax;
  if (acquire !== undefined) env.DB_POOL_ACQUIRE_TIMEOUT_MS = acquire;
  if (statement !== undefined) env.DB_STATEMENT_TIMEOUT_MS = statement;
  if (connCap !== undefined) env.API_DB_CONN_CAP = connCap;
  return env;
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe('Property 3: حلّ إعداد التجمّع حتمي ومُقيَّد (resolvePoolRuntimeConfig)', () => {
  it('always produces values within the documented bounds for ANY env map', () => {
    fc.assert(
      fc.property(
        envValueArb(POOL_MAX_MIN, 500),
        envValueArb(ACQUIRE_TIMEOUT_MIN, ACQUIRE_TIMEOUT_MAX),
        envValueArb(STATEMENT_TIMEOUT_MIN, STATEMENT_TIMEOUT_MAX),
        envValueArb(POOL_MAX_MIN, 500),
        (poolMax, acquire, statement, connCap) => {
          const cfg = resolvePoolRuntimeConfig(
            buildEnv(poolMax, acquire, statement, connCap)
          );
          const cap = expectedConnCap(connCap);

          // statementTimeoutMs ∈ [1000, 120000]
          expect(cfg.statementTimeoutMs).toBeGreaterThanOrEqual(
            STATEMENT_TIMEOUT_MIN
          );
          expect(cfg.statementTimeoutMs).toBeLessThanOrEqual(
            STATEMENT_TIMEOUT_MAX
          );

          // acquisitionTimeoutMillis ∈ [1000, 30000]
          expect(cfg.acquisitionTimeoutMillis).toBeGreaterThanOrEqual(
            ACQUIRE_TIMEOUT_MIN
          );
          expect(cfg.acquisitionTimeoutMillis).toBeLessThanOrEqual(
            ACQUIRE_TIMEOUT_MAX
          );

          // max: positive integer ∈ [1, cap]
          expect(Number.isInteger(cfg.max)).toBe(true);
          expect(cfg.max).toBeGreaterThanOrEqual(POOL_MAX_MIN);
          expect(cfg.max).toBeLessThanOrEqual(cap);

          // connectionTimeoutMillis mirrors acquisitionTimeoutMillis
          expect(cfg.connectionTimeoutMillis).toBe(cfg.acquisitionTimeoutMillis);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('clamps out-of-range and defaults missing/non-numeric inputs (matches reference oracle)', () => {
    fc.assert(
      fc.property(
        envValueArb(POOL_MAX_MIN, 500),
        envValueArb(ACQUIRE_TIMEOUT_MIN, ACQUIRE_TIMEOUT_MAX),
        envValueArb(STATEMENT_TIMEOUT_MIN, STATEMENT_TIMEOUT_MAX),
        envValueArb(POOL_MAX_MIN, 500),
        (poolMax, acquire, statement, connCap) => {
          const cfg = resolvePoolRuntimeConfig(
            buildEnv(poolMax, acquire, statement, connCap)
          );
          const cap = expectedConnCap(connCap);

          expect(cfg.statementTimeoutMs).toBe(
            expectedClampedMs(
              statement,
              STATEMENT_TIMEOUT_MIN,
              STATEMENT_TIMEOUT_MAX,
              STATEMENT_TIMEOUT_DEFAULT
            )
          );
          expect(cfg.acquisitionTimeoutMillis).toBe(
            expectedClampedMs(
              acquire,
              ACQUIRE_TIMEOUT_MIN,
              ACQUIRE_TIMEOUT_MAX,
              ACQUIRE_TIMEOUT_DEFAULT
            )
          );
          expect(cfg.max).toBe(expectedMax(poolMax, cap));
        }
      ),
      { numRuns: 300 }
    );
  });

  it('resolves documented defaults when all inputs are missing/non-numeric', () => {
    fc.assert(
      fc.property(
        fc.oneof(missingArb, nonNumericArb),
        fc.oneof(missingArb, nonNumericArb),
        fc.oneof(missingArb, nonNumericArb),
        (poolMax, acquire, statement) => {
          // No API_DB_CONN_CAP → default cap, default 10 ≤ cap so max === 10.
          const cfg = resolvePoolRuntimeConfig(
            buildEnv(poolMax, acquire, statement, undefined)
          );
          expect(cfg.statementTimeoutMs).toBe(STATEMENT_TIMEOUT_DEFAULT);
          expect(cfg.acquisitionTimeoutMillis).toBe(ACQUIRE_TIMEOUT_DEFAULT);
          expect(cfg.max).toBe(POOL_MAX_DEFAULT);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('is deterministic: identical env maps yield identical resolved config', () => {
    fc.assert(
      fc.property(
        envValueArb(POOL_MAX_MIN, 500),
        envValueArb(ACQUIRE_TIMEOUT_MIN, ACQUIRE_TIMEOUT_MAX),
        envValueArb(STATEMENT_TIMEOUT_MIN, STATEMENT_TIMEOUT_MAX),
        envValueArb(POOL_MAX_MIN, 500),
        (poolMax, acquire, statement, connCap) => {
          const env = buildEnv(poolMax, acquire, statement, connCap);
          const a = resolvePoolRuntimeConfig(env);
          const b = resolvePoolRuntimeConfig(env);
          expect(a).toEqual(b);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('never resolves DB_POOL_MAX above API_DB_CONN_CAP even for huge inputs', () => {
    fc.assert(
      fc.property(
        // Large positive pool-max values
        fc.integer({ min: 1, max: 10_000_000 }).map(String),
        // Small caps in [1, 50]
        fc.integer({ min: 1, max: 50 }).map(String),
        (bigMax, smallCap) => {
          const cfg = resolvePoolRuntimeConfig(
            buildEnv(bigMax, undefined, undefined, smallCap)
          );
          expect(cfg.max).toBeLessThanOrEqual(Number.parseInt(smallCap, 10));
          expect(cfg.max).toBeGreaterThanOrEqual(POOL_MAX_MIN);
        }
      ),
      { numRuns: 200 }
    );
  });
});

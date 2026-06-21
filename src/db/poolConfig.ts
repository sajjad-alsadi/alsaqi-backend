/**
 * Pure configuration helpers for the Database_Layer.
 *
 * These functions contain no side effects (no logging, no process exit, no I/O)
 * so they can be unit- and property-tested in isolation. `initDb` consumes them
 * to make fail-fast startup decisions.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3
 */

// ---------------------------------------------------------------------------
// Pool configuration (Requirements 2.1, 2.2, 2.3)
// ---------------------------------------------------------------------------

/** Validated connection-pool configuration. */
export interface PoolConfig {
  /** Maximum pooled connections. Range 1..1000, default 20 (Req 2.1). */
  max: number;
  /** Connection acquisition timeout in ms. Range 1..60000, default 2000 (Req 2.2). */
  connectionTimeoutMillis: number;
}

/** Describes which pool variable was rejected and why. */
export interface PoolConfigError {
  /** The environment variable that was rejected. */
  variable: string;
  /** Human-readable accepted range, e.g. "integer 1..1000". */
  acceptedRange: string;
  /** The raw value that was received. */
  received: string;
}

/** Result of {@link parsePoolConfig}. */
export type PoolConfigResult =
  | { ok: true; config: PoolConfig }
  | { ok: false; error: PoolConfigError };

interface PoolVarSpec {
  variable: string;
  min: number;
  max: number;
  default: number;
}

const POOL_MAX_SPEC: PoolVarSpec = {
  variable: "DB_POOL_MAX",
  min: 1,
  max: 1000,
  default: 20,
};

const POOL_ACQUIRE_TIMEOUT_SPEC: PoolVarSpec = {
  variable: "DB_POOL_ACQUIRE_TIMEOUT_MS",
  min: 1,
  max: 60000,
  default: 2000,
};

/** Matches a base-10 integer with no decimal point, exponent, or stray characters. */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function describeRange(spec: PoolVarSpec): string {
  return `integer ${spec.min}..${spec.max}`;
}

/**
 * Parses and validates a single pool variable.
 *
 * - An unset variable (undefined) or one that trims to empty is treated as
 *   unset and resolves to the documented default (Req 2.1, 2.2).
 * - A present value must be an integer within the accepted range; otherwise it
 *   is rejected (Req 2.3).
 */
function parsePoolVar(
  raw: string | undefined,
  spec: PoolVarSpec
):
  | { ok: true; value: number }
  | { ok: false; error: PoolConfigError } {
  if (raw === undefined) {
    return { ok: true, value: spec.default };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: spec.default };
  }

  if (!INTEGER_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: {
        variable: spec.variable,
        acceptedRange: describeRange(spec),
        received: raw,
      },
    };
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    return {
      ok: false,
      error: {
        variable: spec.variable,
        acceptedRange: describeRange(spec),
        received: raw,
      },
    };
  }

  return { ok: true, value };
}

/**
 * Pure parser for the connection-pool configuration.
 *
 * Returns either a valid {@link PoolConfig} or a descriptive
 * {@link PoolConfigError} naming the rejected variable and its accepted range.
 *
 * Requirements: 2.1, 2.2, 2.3
 */
export function parsePoolConfig(env: NodeJS.ProcessEnv): PoolConfigResult {
  const maxResult = parsePoolVar(env.DB_POOL_MAX, POOL_MAX_SPEC);
  if (!maxResult.ok) {
    return { ok: false, error: maxResult.error };
  }

  const timeoutResult = parsePoolVar(
    env.DB_POOL_ACQUIRE_TIMEOUT_MS,
    POOL_ACQUIRE_TIMEOUT_SPEC
  );
  if (!timeoutResult.ok) {
    return { ok: false, error: timeoutResult.error };
  }

  return {
    ok: true,
    config: {
      max: maxResult.value,
      connectionTimeoutMillis: timeoutResult.value,
    },
  };
}

// ---------------------------------------------------------------------------
// DATABASE_URL classification (Requirements 1.1, 1.4)
// ---------------------------------------------------------------------------

/** Classification of a `DATABASE_URL` value. */
export type DbUrlKind = "valid-external" | "missing" | "http-url";

/** Result of {@link classifyDatabaseUrl}. */
export interface DbUrlClassification {
  kind: DbUrlKind;
  /** The trimmed value, or null when the input is missing/whitespace-only. */
  normalized: string | null;
}

/**
 * Pure classifier for `DATABASE_URL`.
 *
 * - Returns `missing` for unset or whitespace-only input.
 * - Returns `http-url` for any value beginning with `http://` or `https://`
 *   after trimming surrounding whitespace, matched case-insensitively.
 * - Returns `valid-external` for anything else.
 *
 * Requirements: 1.1, 1.4
 */
export function classifyDatabaseUrl(
  raw: string | undefined
): DbUrlClassification {
  if (raw === undefined) {
    return { kind: "missing", normalized: null };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "missing", normalized: null };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return { kind: "http-url", normalized: trimmed };
  }

  return { kind: "valid-external", normalized: trimmed };
}

// ---------------------------------------------------------------------------
// Embedded-DB permission (Requirements 1.2, 1.3)
// ---------------------------------------------------------------------------

/**
 * Pure predicate: may PGlite (the embedded DB) be used?
 *
 * Returns true if and only if `ALLOW_EMBEDDED_DB` is exactly the string
 * `"true"`, independent of `NODE_ENV`.
 *
 * Requirements: 1.2, 1.3
 */
export function isEmbeddedDbAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.ALLOW_EMBEDDED_DB === "true";
}

// ---------------------------------------------------------------------------
// Resolved runtime pool configuration — clamping resolver (Requirements 7.1, 7.4, 7.5)
// ---------------------------------------------------------------------------

/**
 * The default upper bound on the connection-pool size when `API_DB_CONN_CAP`
 * is not provided in the environment. This documents the maximum number of
 * concurrent connections allocated to API_Container. `DB_POOL_MAX` is never
 * resolved above this cap (Req 7.4).
 */
export const DEFAULT_API_DB_CONN_CAP = 100;

/**
 * Fully-resolved, clamped runtime configuration for the PostgreSQL connection
 * pool. Unlike {@link parsePoolConfig} — which *rejects* out-of-range values —
 * this resolver is total: every input maps to a valid in-range value. Missing
 * or non-numeric values resolve to the documented default, and out-of-range
 * values are clamped to the nearest bound (Req 7.1, 7.4, 7.5).
 */
export interface ResolvedPoolConfig {
  /** Maximum pooled connections. `DB_POOL_MAX`, default 10, in [1 .. API_DB_CONN_CAP]. */
  max: number;
  /**
   * Time to wait for a connection from the pool, in ms. Mirrors
   * {@link acquisitionTimeoutMillis} since `pg` uses `connectionTimeoutMillis`
   * to bound pool acquisition.
   */
  connectionTimeoutMillis: number;
  /** Pool acquisition timeout in ms. `DB_POOL_ACQUIRE_TIMEOUT_MS`, default 10000, clamped to [1000 .. 30000]. */
  acquisitionTimeoutMillis: number;
  /** Per-statement timeout in ms. `DB_STATEMENT_TIMEOUT_MS`, default 30000, clamped to [1000 .. 120000]. */
  statementTimeoutMs: number;
}

const STATEMENT_TIMEOUT_DEFAULT = 30000;
const STATEMENT_TIMEOUT_MIN = 1000;
const STATEMENT_TIMEOUT_MAX = 120000;

const ACQUIRE_TIMEOUT_DEFAULT = 10000;
const ACQUIRE_TIMEOUT_MIN = 1000;
const ACQUIRE_TIMEOUT_MAX = 30000;

const POOL_MAX_DEFAULT = 10;
const POOL_MAX_MIN = 1;

/**
 * Resolves a raw environment value to a finite number, or `null` when the
 * value is unset, whitespace-only, or non-numeric. Accepts integers and
 * decimals; rejects `NaN`, `Infinity`, and stray characters.
 */
function toFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

/** Clamps `value` into the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Resolves a clamped millisecond timeout. Missing/non-numeric values resolve to
 * `def`; in-range values pass through; out-of-range values clamp to the nearest
 * bound.
 */
function resolveClampedMs(
  raw: string | undefined,
  min: number,
  max: number,
  def: number
): number {
  const value = toFiniteNumber(raw);
  if (value === null) {
    return def;
  }
  return clamp(value, min, max);
}

/**
 * Resolves the connection cap (`API_DB_CONN_CAP`). Missing/non-numeric values
 * resolve to {@link DEFAULT_API_DB_CONN_CAP}; otherwise the floored value is
 * used, never below 1.
 */
function resolveConnCap(raw: string | undefined): number {
  const value = toFiniteNumber(raw);
  if (value === null) {
    return DEFAULT_API_DB_CONN_CAP;
  }
  const floored = Math.floor(value);
  return floored < POOL_MAX_MIN ? POOL_MAX_MIN : floored;
}

/**
 * Resolves the pool size (`DB_POOL_MAX`) as a positive integer clamped to
 * [1 .. cap]. Missing/non-numeric values resolve to the default (10, itself
 * clamped to the cap); in-range values are floored to an integer; out-of-range
 * values clamp to the nearest bound.
 */
function resolveMax(raw: string | undefined, cap: number): number {
  const value = toFiniteNumber(raw);
  const resolved = value === null ? POOL_MAX_DEFAULT : Math.floor(value);
  return clamp(resolved, POOL_MAX_MIN, cap);
}

/**
 * Pure, total resolver for the runtime pool configuration.
 *
 * Guarantees (Req 7.1, 7.4, 7.5):
 * - `statementTimeoutMs` in [1000, 120000], default 30000.
 * - `acquisitionTimeoutMillis` in [1000, 30000], default 10000.
 * - `max` a positive integer in [1, API_DB_CONN_CAP], default 10.
 * - Missing or non-numeric inputs resolve to the documented default.
 * - Out-of-range inputs clamp to the nearest bound.
 *
 * `connectionTimeoutMillis` mirrors `acquisitionTimeoutMillis` because the `pg`
 * driver uses `connectionTimeoutMillis` to bound pool-acquisition waits.
 *
 * Requirements: 7.1, 7.4, 7.5
 */
export function resolvePoolRuntimeConfig(
  env: Record<string, string | undefined>
): ResolvedPoolConfig {
  const cap = resolveConnCap(env.API_DB_CONN_CAP);
  const max = resolveMax(env.DB_POOL_MAX, cap);
  const acquisitionTimeoutMillis = resolveClampedMs(
    env.DB_POOL_ACQUIRE_TIMEOUT_MS,
    ACQUIRE_TIMEOUT_MIN,
    ACQUIRE_TIMEOUT_MAX,
    ACQUIRE_TIMEOUT_DEFAULT
  );
  const statementTimeoutMs = resolveClampedMs(
    env.DB_STATEMENT_TIMEOUT_MS,
    STATEMENT_TIMEOUT_MIN,
    STATEMENT_TIMEOUT_MAX,
    STATEMENT_TIMEOUT_DEFAULT
  );

  return {
    max,
    connectionTimeoutMillis: acquisitionTimeoutMillis,
    acquisitionTimeoutMillis,
    statementTimeoutMs,
  };
}

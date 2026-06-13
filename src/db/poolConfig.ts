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

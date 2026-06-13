/**
 * Typed Environment Configuration Accessors
 *
 * Centralizes the security-hardening environment variables from the design's
 * Configuration (environment) model into a single, strongly-typed accessor layer.
 * Each accessor reads a single variable, applies the documented default when the
 * variable is unset, and clamps numeric values to their documented accepted range.
 *
 * This module is intentionally a convenience accessor layer with sane defaults; it
 * is NOT the fail-fast validation layer. Strict parsing/validation that aborts startup
 * (e.g. `parsePoolConfig`, `parseFailedJobRetention`, `parsePdfTimeout`,
 * `parseFailedJobRetention`) lives in the dedicated DB / queue / worker modules.
 *
 * Public signatures contain no `any` and export explicit interfaces.
 *
 * Configuration model (Design → Data Models → Configuration):
 *
 * | Variable                       | Type / Range               | Default          |
 * |--------------------------------|----------------------------|------------------|
 * | DB_POOL_MAX                    | integer 1..1000            | 20               |
 * | DB_POOL_ACQUIRE_TIMEOUT_MS     | integer 1..60000           | 2000             |
 * | FILE_ACCESS_SECRET             | string >= 32 chars         | — (required)     |
 * | FILE_SIGNED_URL_MAX_TTL_S      | integer 1..900             | 900              |
 * | FILE_STREAM_THRESHOLD_BYTES    | integer 1024..1073741824   | 1048576 (1 MB)   |
 * | AUTH_RATE_LIMIT_MAX            | integer >= 1               | 10               |
 * | AUTH_RATE_LIMIT_WINDOW_S       | integer >= 1               | 900              |
 * | API_PREFIX                     | string path                | /api/v1          |
 * | QUEUE_FAILED_RETENTION         | integer 1..100000          | 1000             |
 * | PDF_JOB_TIMEOUT_S              | integer 5..300             | 30               |
 * | SHUTDOWN_DRAIN_TIMEOUT_MS      | integer 1000..120000       | 30000            |
 *
 * Validates: Requirements 2.1, 2.2, 9.1, 11.4, 12.3, 18.1, 19.1, 21.1, 22.1, 23.2
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Read-only view of the process environment used by the accessors. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Inclusive integer range with a documented default. */
export interface IntRangeSpec {
  /** Inclusive minimum accepted value. */
  readonly min: number;
  /** Inclusive maximum accepted value. */
  readonly max: number;
  /** Documented default applied when the variable is unset or invalid. */
  readonly default: number;
}

/**
 * Fully-resolved security-hardening environment configuration.
 * Every numeric field is guaranteed to sit within its documented accepted range.
 */
export interface EnvironmentConfig {
  /** Maximum PostgreSQL pool size (1..1000, default 20). Req 2.1. */
  readonly dbPoolMax: number;
  /** Pool connection-acquisition timeout in ms (1..60000, default 2000). Req 2.2. */
  readonly dbPoolAcquireTimeoutMs: number;
  /**
   * Dedicated file-access signing secret. `undefined` when unset.
   * No default exists; fail-fast validation is enforced separately at startup. Req 9.1.
   */
  readonly fileAccessSecret: string | undefined;
  /** Maximum issued signed-URL TTL in seconds (1..900, default 900). Req 11.4. */
  readonly fileSignedUrlMaxTtlS: number;
  /** Streaming threshold in bytes (1024..1073741824, default 1048576). Req 12.3. */
  readonly fileStreamThresholdBytes: number;
  /** Auth rate-limit maximum attempts per window (>= 1, default 10). Req 18.1. */
  readonly authRateLimitMax: number;
  /** Auth rate-limit window in seconds (>= 1, default 900). Req 18.1. */
  readonly authRateLimitWindowS: number;
  /** Configured API path prefix (default "/api/v1"). Req 19.1. */
  readonly apiPrefix: string;
  /** Bounded failed-job retention count (1..100000, default 1000). Req 21.1. */
  readonly queueFailedRetention: number;
  /** PDF job timeout in seconds (5..300, default 30). Req 22.1. */
  readonly pdfJobTimeoutS: number;
  /** Graceful-shutdown drain timeout in ms (1000..120000, default 30000). Req 23.2. */
  readonly shutdownDrainTimeoutMs: number;
}

// ─── Documented Defaults & Ranges ──────────────────────────────────────────────

/**
 * Documented default values for every configurable variable.
 * `fileAccessSecret` has no default (required), so it is intentionally absent.
 */
export const CONFIG_DEFAULTS = {
  dbPoolMax: 20,
  dbPoolAcquireTimeoutMs: 2000,
  fileSignedUrlMaxTtlS: 900,
  fileStreamThresholdBytes: 1_048_576,
  authRateLimitMax: 10,
  authRateLimitWindowS: 900,
  apiPrefix: '/api/v1',
  queueFailedRetention: 1000,
  pdfJobTimeoutS: 30,
  shutdownDrainTimeoutMs: 30_000,
} as const satisfies Record<string, number | string>;

/** Inclusive accepted ranges (with defaults) for each numeric variable. */
export const CONFIG_RANGES = {
  DB_POOL_MAX: { min: 1, max: 1000, default: CONFIG_DEFAULTS.dbPoolMax },
  DB_POOL_ACQUIRE_TIMEOUT_MS: { min: 1, max: 60_000, default: CONFIG_DEFAULTS.dbPoolAcquireTimeoutMs },
  FILE_SIGNED_URL_MAX_TTL_S: { min: 1, max: 900, default: CONFIG_DEFAULTS.fileSignedUrlMaxTtlS },
  FILE_STREAM_THRESHOLD_BYTES: { min: 1024, max: 1_073_741_824, default: CONFIG_DEFAULTS.fileStreamThresholdBytes },
  AUTH_RATE_LIMIT_MAX: { min: 1, max: Number.MAX_SAFE_INTEGER, default: CONFIG_DEFAULTS.authRateLimitMax },
  AUTH_RATE_LIMIT_WINDOW_S: { min: 1, max: Number.MAX_SAFE_INTEGER, default: CONFIG_DEFAULTS.authRateLimitWindowS },
  QUEUE_FAILED_RETENTION: { min: 1, max: 100_000, default: CONFIG_DEFAULTS.queueFailedRetention },
  PDF_JOB_TIMEOUT_S: { min: 5, max: 300, default: CONFIG_DEFAULTS.pdfJobTimeoutS },
  SHUTDOWN_DRAIN_TIMEOUT_MS: { min: 1000, max: 120_000, default: CONFIG_DEFAULTS.shutdownDrainTimeoutMs },
} as const satisfies Record<string, IntRangeSpec>;

// ─── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Parses an integer environment value, falling back to the range default when the
 * value is unset, non-integer, or otherwise unparseable, and clamping in-range
 * values to the inclusive [min, max] bounds.
 */
function readIntInRange(raw: string | undefined, spec: IntRangeSpec): number {
  if (raw === undefined) {
    return spec.default;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return spec.default;
  }

  // Strict integer check: reject floats, hex, and trailing garbage.
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return spec.default;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    return spec.default;
  }

  if (parsed < spec.min) {
    return spec.min;
  }
  if (parsed > spec.max) {
    return spec.max;
  }
  return parsed;
}

/** Trims a string env value and returns `undefined` for unset/whitespace-only values. */
function readNonEmptyString(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function defaultEnv(env?: EnvSource): EnvSource {
  return env ?? (process.env as EnvSource);
}

// ─── Individual Accessors ──────────────────────────────────────────────────────

/** Maximum PostgreSQL pool size (1..1000, default 20). Req 2.1. */
export function getDbPoolMax(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).DB_POOL_MAX, CONFIG_RANGES.DB_POOL_MAX);
}

/** Pool connection-acquisition timeout in ms (1..60000, default 2000). Req 2.2. */
export function getDbPoolAcquireTimeoutMs(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).DB_POOL_ACQUIRE_TIMEOUT_MS, CONFIG_RANGES.DB_POOL_ACQUIRE_TIMEOUT_MS);
}

/**
 * Dedicated file-access signing secret, or `undefined` when unset/whitespace-only.
 * No default; required-secret enforcement happens at startup. Req 9.1.
 */
export function getFileAccessSecret(env?: EnvSource): string | undefined {
  return readNonEmptyString(defaultEnv(env).FILE_ACCESS_SECRET);
}

/** Maximum issued signed-URL TTL in seconds (1..900, default 900). Req 11.4. */
export function getFileSignedUrlMaxTtlS(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).FILE_SIGNED_URL_MAX_TTL_S, CONFIG_RANGES.FILE_SIGNED_URL_MAX_TTL_S);
}

/** Streaming threshold in bytes (1024..1073741824, default 1048576). Req 12.3. */
export function getFileStreamThresholdBytes(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).FILE_STREAM_THRESHOLD_BYTES, CONFIG_RANGES.FILE_STREAM_THRESHOLD_BYTES);
}

/** Auth rate-limit maximum attempts per window (>= 1, default 10). Req 18.1. */
export function getAuthRateLimitMax(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).AUTH_RATE_LIMIT_MAX, CONFIG_RANGES.AUTH_RATE_LIMIT_MAX);
}

/** Auth rate-limit window in seconds (>= 1, default 900). Req 18.1. */
export function getAuthRateLimitWindowS(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).AUTH_RATE_LIMIT_WINDOW_S, CONFIG_RANGES.AUTH_RATE_LIMIT_WINDOW_S);
}

/** Configured API path prefix (default "/api/v1"). Req 19.1. */
export function getApiPrefix(env?: EnvSource): string {
  return readNonEmptyString(defaultEnv(env).API_PREFIX) ?? CONFIG_DEFAULTS.apiPrefix;
}

/** Bounded failed-job retention count (1..100000, default 1000). Req 21.1. */
export function getQueueFailedRetention(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).QUEUE_FAILED_RETENTION, CONFIG_RANGES.QUEUE_FAILED_RETENTION);
}

/** PDF job timeout in seconds (5..300, default 30). Req 22.1. */
export function getPdfJobTimeoutS(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).PDF_JOB_TIMEOUT_S, CONFIG_RANGES.PDF_JOB_TIMEOUT_S);
}

/** Graceful-shutdown drain timeout in ms (1000..120000, default 30000). Req 23.2. */
export function getShutdownDrainTimeoutMs(env?: EnvSource): number {
  return readIntInRange(defaultEnv(env).SHUTDOWN_DRAIN_TIMEOUT_MS, CONFIG_RANGES.SHUTDOWN_DRAIN_TIMEOUT_MS);
}

// ─── Aggregate Accessor ─────────────────────────────────────────────────────────

/**
 * Resolves the complete security-hardening configuration from the given environment
 * (defaults to `process.env`). All numeric fields are guaranteed in-range.
 */
export function getEnvironmentConfig(env?: EnvSource): EnvironmentConfig {
  const source = defaultEnv(env);
  return {
    dbPoolMax: getDbPoolMax(source),
    dbPoolAcquireTimeoutMs: getDbPoolAcquireTimeoutMs(source),
    fileAccessSecret: getFileAccessSecret(source),
    fileSignedUrlMaxTtlS: getFileSignedUrlMaxTtlS(source),
    fileStreamThresholdBytes: getFileStreamThresholdBytes(source),
    authRateLimitMax: getAuthRateLimitMax(source),
    authRateLimitWindowS: getAuthRateLimitWindowS(source),
    apiPrefix: getApiPrefix(source),
    queueFailedRetention: getQueueFailedRetention(source),
    pdfJobTimeoutS: getPdfJobTimeoutS(source),
    shutdownDrainTimeoutMs: getShutdownDrainTimeoutMs(source),
  };
}

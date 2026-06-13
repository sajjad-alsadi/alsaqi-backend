import { describe, it, expect } from 'vitest';

import {
  CONFIG_DEFAULTS,
  CONFIG_RANGES,
  getEnvironmentConfig,
  getDbPoolMax,
  getDbPoolAcquireTimeoutMs,
  getFileAccessSecret,
  getFileSignedUrlMaxTtlS,
  getFileStreamThresholdBytes,
  getAuthRateLimitMax,
  getAuthRateLimitWindowS,
  getApiPrefix,
  getQueueFailedRetention,
  getPdfJobTimeoutS,
  getShutdownDrainTimeoutMs,
  type EnvSource,
} from './environmentConfig.js';

// ─── Defaults ──────────────────────────────────────────────────────────────────

describe('environmentConfig defaults', () => {
  const empty: EnvSource = {};

  it('returns documented defaults when no variables are set', () => {
    expect(getDbPoolMax(empty)).toBe(20);
    expect(getDbPoolAcquireTimeoutMs(empty)).toBe(2000);
    expect(getFileSignedUrlMaxTtlS(empty)).toBe(900);
    expect(getFileStreamThresholdBytes(empty)).toBe(1_048_576);
    expect(getAuthRateLimitMax(empty)).toBe(10);
    expect(getAuthRateLimitWindowS(empty)).toBe(900);
    expect(getApiPrefix(empty)).toBe('/api/v1');
    expect(getQueueFailedRetention(empty)).toBe(1000);
    expect(getPdfJobTimeoutS(empty)).toBe(30);
    expect(getShutdownDrainTimeoutMs(empty)).toBe(30_000);
  });

  it('treats FILE_ACCESS_SECRET as undefined when unset (no default)', () => {
    expect(getFileAccessSecret(empty)).toBeUndefined();
  });

  it('getEnvironmentConfig resolves a fully-defaulted config object', () => {
    expect(getEnvironmentConfig(empty)).toEqual({
      dbPoolMax: 20,
      dbPoolAcquireTimeoutMs: 2000,
      fileAccessSecret: undefined,
      fileSignedUrlMaxTtlS: 900,
      fileStreamThresholdBytes: 1_048_576,
      authRateLimitMax: 10,
      authRateLimitWindowS: 900,
      apiPrefix: '/api/v1',
      queueFailedRetention: 1000,
      pdfJobTimeoutS: 30,
      shutdownDrainTimeoutMs: 30_000,
    });
  });
});

// ─── Valid parsing ───────────────────────────────────────────────────────────

describe('environmentConfig valid values', () => {
  it('parses in-range integer values', () => {
    const env: EnvSource = {
      DB_POOL_MAX: '50',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '5000',
      FILE_SIGNED_URL_MAX_TTL_S: '300',
      FILE_STREAM_THRESHOLD_BYTES: '2097152',
      AUTH_RATE_LIMIT_MAX: '25',
      AUTH_RATE_LIMIT_WINDOW_S: '600',
      QUEUE_FAILED_RETENTION: '5000',
      PDF_JOB_TIMEOUT_S: '60',
      SHUTDOWN_DRAIN_TIMEOUT_MS: '15000',
    };
    expect(getDbPoolMax(env)).toBe(50);
    expect(getDbPoolAcquireTimeoutMs(env)).toBe(5000);
    expect(getFileSignedUrlMaxTtlS(env)).toBe(300);
    expect(getFileStreamThresholdBytes(env)).toBe(2_097_152);
    expect(getAuthRateLimitMax(env)).toBe(25);
    expect(getAuthRateLimitWindowS(env)).toBe(600);
    expect(getQueueFailedRetention(env)).toBe(5000);
    expect(getPdfJobTimeoutS(env)).toBe(60);
    expect(getShutdownDrainTimeoutMs(env)).toBe(15000);
  });

  it('trims and returns a configured FILE_ACCESS_SECRET', () => {
    expect(getFileAccessSecret({ FILE_ACCESS_SECRET: '  ' + 'x'.repeat(32) + '  ' })).toBe('x'.repeat(32));
  });

  it('trims and returns a configured API_PREFIX', () => {
    expect(getApiPrefix({ API_PREFIX: '  /api/v2  ' })).toBe('/api/v2');
  });
});

// ─── Clamping & fallback ────────────────────────────────────────────────────

describe('environmentConfig clamping and fallback', () => {
  it('clamps values above the maximum to the maximum', () => {
    expect(getDbPoolMax({ DB_POOL_MAX: '99999' })).toBe(1000);
    expect(getDbPoolAcquireTimeoutMs({ DB_POOL_ACQUIRE_TIMEOUT_MS: '999999' })).toBe(60_000);
    expect(getFileSignedUrlMaxTtlS({ FILE_SIGNED_URL_MAX_TTL_S: '100000' })).toBe(900);
    expect(getPdfJobTimeoutS({ PDF_JOB_TIMEOUT_S: '10000' })).toBe(300);
    expect(getShutdownDrainTimeoutMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: '9999999' })).toBe(120_000);
    expect(getQueueFailedRetention({ QUEUE_FAILED_RETENTION: '500000' })).toBe(100_000);
  });

  it('clamps values below the minimum to the minimum', () => {
    expect(getDbPoolMax({ DB_POOL_MAX: '0' })).toBe(1);
    expect(getDbPoolAcquireTimeoutMs({ DB_POOL_ACQUIRE_TIMEOUT_MS: '0' })).toBe(1);
    expect(getFileStreamThresholdBytes({ FILE_STREAM_THRESHOLD_BYTES: '10' })).toBe(1024);
    expect(getPdfJobTimeoutS({ PDF_JOB_TIMEOUT_S: '1' })).toBe(5);
    expect(getShutdownDrainTimeoutMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: '5' })).toBe(1000);
  });

  it('falls back to defaults for non-integer, empty, or garbage values', () => {
    expect(getDbPoolMax({ DB_POOL_MAX: 'abc' })).toBe(20);
    expect(getDbPoolMax({ DB_POOL_MAX: '12.5' })).toBe(20);
    expect(getDbPoolMax({ DB_POOL_MAX: '10abc' })).toBe(20);
    expect(getDbPoolMax({ DB_POOL_MAX: '   ' })).toBe(20);
    expect(getPdfJobTimeoutS({ PDF_JOB_TIMEOUT_S: '' })).toBe(30);
  });

  it('falls back to default API_PREFIX for whitespace-only values', () => {
    expect(getApiPrefix({ API_PREFIX: '   ' })).toBe('/api/v1');
  });

  it('treats whitespace-only FILE_ACCESS_SECRET as undefined', () => {
    expect(getFileAccessSecret({ FILE_ACCESS_SECRET: '   ' })).toBeUndefined();
  });
});

// ─── Range metadata integrity ──────────────────────────────────────────────────

describe('environmentConfig range metadata', () => {
  it('keeps defaults consistent between CONFIG_DEFAULTS and CONFIG_RANGES', () => {
    expect(CONFIG_RANGES.DB_POOL_MAX.default).toBe(CONFIG_DEFAULTS.dbPoolMax);
    expect(CONFIG_RANGES.PDF_JOB_TIMEOUT_S.default).toBe(CONFIG_DEFAULTS.pdfJobTimeoutS);
    expect(CONFIG_RANGES.SHUTDOWN_DRAIN_TIMEOUT_MS.default).toBe(CONFIG_DEFAULTS.shutdownDrainTimeoutMs);
  });

  it('declares each default within its own accepted range', () => {
    for (const spec of Object.values(CONFIG_RANGES)) {
      expect(spec.default).toBeGreaterThanOrEqual(spec.min);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
    }
  });
});

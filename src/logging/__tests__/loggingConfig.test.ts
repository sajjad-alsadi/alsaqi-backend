// @vitest-environment node
/**
 * Verification Tests: Log_Aggregator (Loki) retention & query config (Task 18.3)
 *
 * These tests parse logging/loki-config.yml and assert the retention / query
 * shape required by Requirement 14 (design region ي-14):
 *   - retention_period defaults to 365d and the allowed range [90d..2555d]
 *     is documented                                                  (Req 14.3)
 *   - the compactor deletes expired data well under the 24h budget   (Req 14.4)
 *   - every query is bounded by a <= 30s timeout                     (Req 14.5)
 *
 * They also assert the LogQL `traceId` query SEMANTICS for Req 14.6 via a pure
 * helper (`filterLogsByTraceId`): a non-matching range + traceId query returns
 * an EMPTY result set, NOT an error; a matching query returns the entries.
 *
 * **Validates: Requirements 14.3, 14.5, 14.6**
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  filterLogsByTraceId,
  type LogEntry,
} from '../logQuery';

// ─── Paths ───────────────────────────────────────────────────────────────────
// Resolve the logging/ directory relative to the repo root (three levels up from
// this file: src/logging/__tests__/ → repo root).
const PROJECT_ROOT = resolve(__dirname, '../../../');
const LOGGING_DIR = resolve(PROJECT_ROOT, 'logging');
const LOKI_CONFIG_PATH = resolve(LOGGING_DIR, 'loki-config.yml');
const LOKI_README_PATH = resolve(LOGGING_DIR, 'README.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reads + parses a YAML file, asserting it exists and parses to an object. */
function loadYaml(path: string): Record<string, any> {
  expect(existsSync(path), `expected config file to exist: ${path}`).toBe(true);
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  expect(parsed, `expected ${path} to parse to a non-null object`).toBeTypeOf('object');
  expect(parsed).not.toBeNull();
  return parsed as Record<string, any>;
}

/**
 * Parses a Loki/Prometheus-style duration string (e.g. "30s", "2h", "365d",
 * "2555d") into a number of seconds so timeouts / windows can be compared
 * numerically.
 */
function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(String(value).trim());
  expect(match, `expected a duration string, got: ${value}`).not.toBeNull();
  const amount = Number(match![1]);
  const unit = match![2];
  const unitSeconds: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    y: 31536000,
  };
  return amount * unitSeconds[unit];
}

const SECONDS_PER_DAY = 86400;

// ─── Tests: retention defaults & range (Req 14.3) ──────────────────────────────

describe('Loki config — retention (Requirement 14.3)', () => {
  let loki: Record<string, any>;
  let rawConfig: string;
  let rawReadme: string;

  beforeAll(() => {
    loki = loadYaml(LOKI_CONFIG_PATH);
    rawConfig = readFileSync(LOKI_CONFIG_PATH, 'utf-8');
    rawReadme = existsSync(LOKI_README_PATH)
      ? readFileSync(LOKI_README_PATH, 'utf-8')
      : '';
  });

  it('parses as valid YAML with a limits_config block', () => {
    expect(loki.limits_config).toBeTypeOf('object');
  });

  it('defaults retention_period to 365d via ${LOKI_RETENTION_PERIOD:-365d}', () => {
    const retention = String(loki.limits_config.retention_period);
    // The env-substitution default must resolve to 365d when unset.
    expect(retention).toMatch(/\$\{\s*LOKI_RETENTION_PERIOD\s*:-\s*365d\s*\}/);
    // And the documented default itself is 365 days.
    expect(durationToSeconds('365d')).toBe(365 * SECONDS_PER_DAY);
  });

  it('documents the allowed retention range [90d .. 2555d]', () => {
    // The bounds are documented in the config and/or README (Req 14.3:
    // configurable in the range 90..2555 days). Accept either location.
    const documentation = `${rawConfig}\n${rawReadme}`;
    expect(documentation).toMatch(/90d/);
    expect(documentation).toMatch(/2555d/);
    // Sanity-check the numeric bounds the strings represent.
    expect(durationToSeconds('90d')).toBe(90 * SECONDS_PER_DAY);
    expect(durationToSeconds('2555d')).toBe(2555 * SECONDS_PER_DAY);
    expect(durationToSeconds('90d')).toBeLessThan(durationToSeconds('365d'));
    expect(durationToSeconds('365d')).toBeLessThan(durationToSeconds('2555d'));
  });
});

// ─── Tests: query timeout (Req 14.5) ───────────────────────────────────────────

describe('Loki config — query timeout (Requirement 14.5)', () => {
  let loki: Record<string, any>;

  beforeAll(() => {
    loki = loadYaml(LOKI_CONFIG_PATH);
  });

  it('caps the querier query_timeout at <= 30s', () => {
    const timeout = loki.querier?.query_timeout;
    expect(timeout, 'expected querier.query_timeout to be set').toBeTruthy();
    expect(durationToSeconds(timeout)).toBeLessThanOrEqual(30);
  });

  it('caps the limits_config query_timeout at <= 30s', () => {
    const timeout = loki.limits_config?.query_timeout;
    expect(timeout, 'expected limits_config.query_timeout to be set').toBeTruthy();
    expect(durationToSeconds(timeout)).toBeLessThanOrEqual(30);
  });
});

// ─── Tests: deletion budget context (supports Req 14.4) ────────────────────────

describe('Loki config — compactor deletion (Requirement 14.4 context)', () => {
  let loki: Record<string, any>;

  beforeAll(() => {
    loki = loadYaml(LOKI_CONFIG_PATH);
  });

  it('enables retention-based deletion in the compactor', () => {
    expect(loki.compactor?.retention_enabled).toBe(true);
  });

  it('keeps retention_delete_delay well under the 24h budget', () => {
    const delay = loki.compactor?.retention_delete_delay;
    expect(delay, 'expected compactor.retention_delete_delay to be set').toBeTruthy();
    // Must be comfortably below 24h so an expired entry is removed in time.
    expect(durationToSeconds(delay)).toBeLessThan(24 * 3600);
  });
});

// ─── Tests: LogQL traceId query semantics (Req 14.5, 14.6) ─────────────────────

describe('LogQL traceId query semantics (Requirements 14.5, 14.6)', () => {
  // A small in-range fixture: three entries inside the [1000, 5000] ms window.
  const range = { start: 1000, end: 5000 };
  const entries: LogEntry[] = [
    { timestamp: 1500, traceId: 'trace-A', level: 'info', message: 'a1' },
    { timestamp: 2500, traceId: 'trace-B', level: 'warn', message: 'b1' },
    { timestamp: 3500, traceId: 'trace-A', level: 'error', message: 'a2' },
    // Out-of-range entry that DOES carry trace-A but must NOT be returned.
    { timestamp: 9000, traceId: 'trace-A', level: 'info', message: 'a3-late' },
  ];

  it('returns an EMPTY array (no throw) when no entry matches the traceId (Req 14.6)', () => {
    let result: LogEntry[] | undefined;
    expect(() => {
      result = filterLogsByTraceId(entries, 'does-not-exist', range);
    }).not.toThrow();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('returns an EMPTY array when the traceId exists only OUTSIDE the range (Req 14.6)', () => {
    // trace-A's only matching entry inside a tiny window is excluded by range.
    const tinyWindow = { start: 2000, end: 3000 };
    const result = filterLogsByTraceId(entries, 'trace-A', tinyWindow);
    expect(result).toEqual([]);
  });

  it('returns every in-range entry that matches the traceId (Req 14.5)', () => {
    const result = filterLogsByTraceId(entries, 'trace-A', range);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.message)).toEqual(['a1', 'a2']);
    // The out-of-range trace-A entry must be excluded.
    expect(result.some((e) => e.message === 'a3-late')).toBe(false);
  });

  it('treats an empty entry set as an empty result, not an error (Req 14.6)', () => {
    expect(filterLogsByTraceId([], 'trace-A', range)).toEqual([]);
  });

  it('matches traceId exactly (no partial / substring matches)', () => {
    const result = filterLogsByTraceId(entries, 'trace', range);
    expect(result).toEqual([]);
  });
});

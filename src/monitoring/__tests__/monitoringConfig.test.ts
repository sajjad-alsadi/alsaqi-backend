// @vitest-environment node
/**
 * Verification Tests: Monitoring configuration files (Task 17.4)
 *
 * These tests parse the Prometheus / Alertmanager configuration files that
 * drive the Observability_Stack and assert that their structure matches the
 * launch requirements:
 *   - scrape interval / timeout                                      (Req 13.1)
 *   - endpoint-unreachable alert (up == 0) firing after ~60s         (Req 13.3)
 *   - request error rate > 5% over a 5-minute window                 (Req 13.4)
 *   - Alertmanager routes to a receiver with send_resolved: true     (Req 13.5)
 *
 * They act as the "promtool/schema" parse-and-shape check called for by the
 * task: every file must be valid YAML and the key thresholds / windows must
 * match the documented values.
 *
 * **Validates: Requirements 13.1, 13.3, 13.4**
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

// ─── Paths ───────────────────────────────────────────────────────────────────
// Resolve the monitoring/ directory relative to the repo root (two levels up
// from this file: src/monitoring/__tests__/ → repo root).
const PROJECT_ROOT = resolve(__dirname, '../../../');
const MONITORING_DIR = resolve(PROJECT_ROOT, 'monitoring');
const PROMETHEUS_PATH = resolve(MONITORING_DIR, 'prometheus.yml');
const ALERT_RULES_PATH = resolve(MONITORING_DIR, 'alert.rules.yml');
const ALERTMANAGER_PATH = resolve(MONITORING_DIR, 'alertmanager.yml');

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
 * Parses a Prometheus duration string (e.g. "15s", "5m", "1h", "60s") into a
 * number of seconds so windows/timeouts can be compared numerically.
 */
function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/.exec(value.trim());
  expect(match, `expected a Prometheus duration string, got: ${value}`).not.toBeNull();
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

/** Recursively collects every alert rule from a Prometheus rules document. */
function collectRules(rulesDoc: Record<string, any>): Array<Record<string, any>> {
  const groups = Array.isArray(rulesDoc.groups) ? rulesDoc.groups : [];
  const rules: Array<Record<string, any>> = [];
  for (const group of groups) {
    if (Array.isArray(group?.rules)) {
      for (const rule of group.rules) rules.push(rule);
    }
  }
  return rules;
}

/** Recursively collects all `send_resolved` values found anywhere in a tree. */
function collectSendResolvedFlags(node: unknown, found: boolean[] = []): boolean[] {
  if (Array.isArray(node)) {
    for (const item of node) collectSendResolvedFlags(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'send_resolved' && typeof value === 'boolean') {
        found.push(value);
      } else {
        collectSendResolvedFlags(value, found);
      }
    }
  }
  return found;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Monitoring config — prometheus.yml (Requirement 13.1)', () => {
  let prometheus: Record<string, any>;

  beforeAll(() => {
    prometheus = loadYaml(PROMETHEUS_PATH);
  });

  it('parses as valid YAML with a global block', () => {
    expect(prometheus.global).toBeTypeOf('object');
  });

  it('scrapes the metrics endpoint every 15s', () => {
    expect(prometheus.global.scrape_interval).toBe('15s');
    expect(durationToSeconds(prometheus.global.scrape_interval)).toBe(15);
  });

  it('uses a scrape timeout of at most 10s', () => {
    expect(prometheus.global.scrape_timeout).toBe('10s');
    expect(durationToSeconds(prometheus.global.scrape_timeout)).toBeLessThanOrEqual(10);
  });

  it('defines a scrape job that targets the API /metrics endpoint', () => {
    const jobs = Array.isArray(prometheus.scrape_configs) ? prometheus.scrape_configs : [];
    const apiJob = jobs.find((j: any) => j?.job_name === 'alsaqi-api');
    expect(apiJob, 'expected a scrape_config job named "alsaqi-api"').toBeTruthy();
    expect(apiJob.metrics_path).toBe('/metrics');
  });
});

describe('Monitoring config — alert.rules.yml (Requirements 13.3, 13.4)', () => {
  let rules: Array<Record<string, any>>;

  beforeAll(() => {
    rules = collectRules(loadYaml(ALERT_RULES_PATH));
  });

  it('parses as valid YAML with at least one alert rule', () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it('fires when the metrics endpoint is unreachable (up == 0) for ~60s (Req 13.3)', () => {
    const unreachable = rules.find((r) => {
      const expr = String(r?.expr ?? '');
      return /\bup\b/.test(expr) && /==\s*0/.test(expr);
    });
    expect(unreachable, 'expected an alert with expr `up ... == 0`').toBeTruthy();
    expect(unreachable!.for, 'expected a `for:` duration on the unreachable alert').toBeTruthy();

    const forSeconds = durationToSeconds(String(unreachable!.for));
    // "more than 60 seconds": accept a small tolerance band around 60s.
    expect(forSeconds).toBeGreaterThanOrEqual(60);
    expect(forSeconds).toBeLessThanOrEqual(120);
  });

  it('fires when the request error rate exceeds 5% over a 5m window (Req 13.4)', () => {
    const errorRate = rules.find((r) => {
      const expr = String(r?.expr ?? '');
      const hasFivePercentThreshold = />\s*0\.05/.test(expr);
      const hasFiveMinuteWindow = /\[5m\]/.test(expr);
      return hasFivePercentThreshold && hasFiveMinuteWindow;
    });
    expect(
      errorRate,
      'expected an alert with a `> 0.05` threshold over a `[5m]` rate window',
    ).toBeTruthy();
    // The error-rate expr should be a ratio (errors / total requests).
    expect(String(errorRate!.expr)).toMatch(/rate\(/);
  });
});

describe('Monitoring config — alertmanager.yml (Requirement 13.5 context)', () => {
  let alertmanager: Record<string, any>;

  beforeAll(() => {
    alertmanager = loadYaml(ALERTMANAGER_PATH);
  });

  it('parses as valid YAML with a route and receivers', () => {
    expect(alertmanager.route).toBeTypeOf('object');
    expect(Array.isArray(alertmanager.receivers)).toBe(true);
    expect(alertmanager.receivers.length).toBeGreaterThan(0);
  });

  it('routes to a receiver that actually exists', () => {
    const routedReceiver = alertmanager.route?.receiver;
    expect(routedReceiver, 'expected route.receiver to be set').toBeTruthy();
    const receiverNames = alertmanager.receivers.map((r: any) => r?.name);
    expect(receiverNames).toContain(routedReceiver);
  });

  it('configures send_resolved: true so recovery notifications are delivered', () => {
    const flags = collectSendResolvedFlags(alertmanager.receivers);
    expect(flags.length, 'expected at least one notifier with send_resolved').toBeGreaterThan(0);
    // Every configured notifier that sets the flag must enable resolved notices.
    expect(flags.every((flag) => flag === true)).toBe(true);
  });
});

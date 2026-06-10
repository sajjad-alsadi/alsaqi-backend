/**
 * Database Metrics & Slow Query Logging
 *
 * - Instruments database queries to detect execution > 500ms (slow query logging)
 * - Exports Pool metrics (totalCount, idleCount, waitingCount, usedCount) via /metrics
 * - Logs warning when waitingCount > 10 (50% of max 20) with hysteresis
 * - Registers pool event listeners: error → error level, connect/acquire/remove → debug level
 *
 * Requirements: 4.3, 4.4, 12.1, 12.2, 12.3, 12.4
 */

import client from 'prom-client';
import type { Pool } from 'pg';
import logger from '../utils/logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SLOW_QUERY_THRESHOLD_MS = 500;
const QUERY_TEXT_MAX_LENGTH = 1024;
const POOL_WAITING_WARN_THRESHOLD = 10; // 50% of max 20

// ─── Prometheus Gauges for Pool Metrics ──────────────────────────────────────
// Requirement 4.4, 12.4: Pool metrics updated on each /metrics scrape

export const poolTotalCount = new client.Gauge({
  name: 'alsaqi_db_pool_total_count',
  help: 'Total number of connections in the pool (active + idle)',
  collect() {
    if (_pool) {
      this.set(_pool.totalCount);
    }
  },
});

export const poolIdleCount = new client.Gauge({
  name: 'alsaqi_db_pool_idle_count',
  help: 'Number of idle connections in the pool',
  collect() {
    if (_pool) {
      this.set(_pool.idleCount);
    }
  },
});

export const poolWaitingCount = new client.Gauge({
  name: 'alsaqi_db_pool_waiting_count',
  help: 'Number of queued requests waiting for a connection',
  collect() {
    if (_pool) {
      this.set(_pool.waitingCount);
    }
  },
});

export const poolUsedCount = new client.Gauge({
  name: 'alsaqi_db_pool_used_count',
  help: 'Number of connections currently checked out (in use)',
  collect() {
    if (_pool) {
      // usedCount = totalCount - idleCount
      this.set(_pool.totalCount - _pool.idleCount);
    }
  },
});

// ─── Slow Query Counter (for metrics) ────────────────────────────────────────

export const slowQueryCounter = new client.Counter({
  name: 'alsaqi_db_slow_queries_total',
  help: 'Total number of slow queries (> 500ms)',
});

// ─── Internal State ──────────────────────────────────────────────────────────

let _pool: Pool | null = null;
let _waitingThresholdBreached = false;

// ─── Slow Query Detection ────────────────────────────────────────────────────

/**
 * Logs a slow query warning when execution exceeds the threshold.
 * Requirement 4.3: Queries > 500ms → log as slow query with text (max 1024 chars) and duration
 */
export function checkSlowQuery(queryText: string, durationMs: number): void {
  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    const truncatedQuery = queryText.length > QUERY_TEXT_MAX_LENGTH
      ? queryText.substring(0, QUERY_TEXT_MAX_LENGTH)
      : queryText;

    logger.warn('[DB] Slow query detected', {
      query: truncatedQuery,
      durationMs: Math.round(durationMs),
      threshold: SLOW_QUERY_THRESHOLD_MS,
    });

    slowQueryCounter.inc();
  }
}

// ─── Pool Exhaustion Warning (Hysteresis) ────────────────────────────────────

/**
 * Checks pool waiting count and logs a warning when it exceeds the threshold.
 * Uses hysteresis: logs once when threshold is crossed, doesn't repeat until
 * waitingCount drops below threshold and crosses again.
 *
 * Requirement 12.3: When waitingCount > 10 (50% of max 20) → warn once,
 * don't repeat until drops below threshold and crosses again
 */
export function checkPoolExhaustion(): void {
  if (!_pool) return;

  const waitingCount = _pool.waitingCount;

  if (waitingCount > POOL_WAITING_WARN_THRESHOLD) {
    if (!_waitingThresholdBreached) {
      _waitingThresholdBreached = true;
      logger.warn('[DB] Pool exhaustion warning: waitingCount exceeded threshold', {
        waitingCount,
        threshold: POOL_WAITING_WARN_THRESHOLD,
        totalCount: _pool.totalCount,
        idleCount: _pool.idleCount,
      });
    }
  } else {
    // Reset the flag when waitingCount drops below threshold
    _waitingThresholdBreached = false;
  }
}

// ─── Pool Event Listeners ────────────────────────────────────────────────────

/**
 * Registers event listeners on the pg Pool.
 *
 * Requirement 12.1: On Pool error event → log at error level with event type and timestamp
 * Requirement 12.2: On Pool connect/acquire/remove events → log at debug level
 */
function registerPoolEventListeners(pool: Pool): void {
  pool.on('error', (err) => {
    logger.error('[DB Pool] Pool error event', {
      eventType: 'error',
      timestamp: new Date().toISOString(),
      message: err.message,
      code: (err as any).code,
    });
  });

  pool.on('connect', () => {
    logger.debug('[DB Pool] Pool connect event', {
      eventType: 'connect',
      timestamp: new Date().toISOString(),
    });
    // Check pool exhaustion on each pool activity
    checkPoolExhaustion();
  });

  pool.on('acquire', () => {
    logger.debug('[DB Pool] Pool acquire event', {
      eventType: 'acquire',
      timestamp: new Date().toISOString(),
    });
    // Check pool exhaustion on each pool activity
    checkPoolExhaustion();
  });

  pool.on('remove', () => {
    logger.debug('[DB Pool] Pool remove event', {
      eventType: 'remove',
      timestamp: new Date().toISOString(),
    });
    checkPoolExhaustion();
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initializes database metrics collection by registering pool event listeners
 * and setting up Prometheus gauges for pool metrics.
 *
 * Must be called after the pg.Pool is created and db is initialized.
 *
 * @param pool - The pg.Pool instance to monitor
 */
export function initDbMetrics(pool: Pool): void {
  _pool = pool;
  registerPoolEventListeners(pool);
  logger.info('[Monitoring] Database metrics initialized: pool events registered, Prometheus gauges active');
}

/**
 * Returns the currently registered pool (for testing).
 */
export function getMonitoredPool(): Pool | null {
  return _pool;
}

/**
 * Resets internal state (for testing purposes).
 */
export function resetDbMetricsState(): void {
  _pool = null;
  _waitingThresholdBreached = false;
}

/**
 * Graceful Shutdown with Request Draining — Requirement 23
 *
 * Provides a server-agnostic shutdown handler that, on a shutdown signal (or an
 * uncaught exception), stops accepting new connections, drains in-flight requests
 * within a bounded, configurable timeout, and exits the process with a success or
 * failure code depending on whether draining completed in time.
 *
 * Behaviour (Requirement 23):
 *  - 23.1 On a shutdown signal the server stops accepting new connections.
 *  - 23.2 In-flight requests are allowed to complete within a configurable drain
 *         timeout (1000..120000 ms, default 30000 ms).
 *  - 23.3 If all in-flight requests complete before the timeout, the process exits 0.
 *  - 23.4 If the timeout elapses first, remaining connections are terminated and the
 *         process exits with a non-zero code.
 *  - 23.5 / 23.6 An uncaught exception follows the same drain-then-exit path rather
 *         than exiting immediately.
 *
 * Public signatures contain no `any`.
 */

import type { Server } from 'http';
import { CONFIG_RANGES } from '../config/environmentConfig.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Inclusive lower bound for the drain timeout in milliseconds (Req 23.2). */
export const DRAIN_TIMEOUT_MIN_MS = CONFIG_RANGES.SHUTDOWN_DRAIN_TIMEOUT_MS.min;
/** Inclusive upper bound for the drain timeout in milliseconds (Req 23.2). */
export const DRAIN_TIMEOUT_MAX_MS = CONFIG_RANGES.SHUTDOWN_DRAIN_TIMEOUT_MS.max;
/** Documented default drain timeout in milliseconds (Req 23.2). */
export const DRAIN_TIMEOUT_DEFAULT_MS = CONFIG_RANGES.SHUTDOWN_DRAIN_TIMEOUT_MS.default;

/** Success exit code used when draining completes within the timeout (Req 23.3). */
const EXIT_SUCCESS = 0;
/** Failure exit code used when the drain timeout elapses (Req 23.4, 23.6). */
const EXIT_DRAIN_TIMEOUT = 1;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Options accepted by {@link createGracefulShutdown}. */
export interface GracefulShutdownOptions {
  /**
   * Requested drain timeout in milliseconds. The value is clamped to
   * [1000, 120000]; absent, non-finite, or out-of-range values resolve to the
   * documented default of 30000 (Req 23.2).
   */
  readonly drainTimeoutMs: number;
}

/**
 * A shutdown handler. Invoked with the triggering signal name (e.g. `"SIGTERM"`,
 * `"SIGINT"`, or `"uncaughtException"`). The returned promise resolves immediately
 * before the process exits; the call is idempotent across repeated invocations.
 */
export type GracefulShutdownHandler = (signal: string) => Promise<void>;

// ─── Drain-timeout parsing & clamping (Property 31, Req 23.2) ────────────────────

/**
 * Normalizes an arbitrary drain-timeout configuration value to a millisecond count
 * within [1000, 120000].
 *
 * Out-of-range finite numbers are clamped to the nearest bound; absent, non-finite,
 * or non-integer values fall back to the documented default of 30000 ms.
 *
 * @param raw - The raw configured value (may be undefined or non-finite).
 * @returns A drain timeout guaranteed to sit within the accepted inclusive range.
 */
export function clampDrainTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DRAIN_TIMEOUT_DEFAULT_MS;
  }
  const value = Math.trunc(raw);
  if (value < DRAIN_TIMEOUT_MIN_MS) {
    return DRAIN_TIMEOUT_MIN_MS;
  }
  if (value > DRAIN_TIMEOUT_MAX_MS) {
    return DRAIN_TIMEOUT_MAX_MS;
  }
  return value;
}

// ─── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Creates a graceful-shutdown handler bound to the given HTTP server.
 *
 * The handler stops the server from accepting new connections, closes idle
 * keep-alive sockets so they do not block draining, and waits for in-flight
 * requests to finish. If everything drains before the (clamped) timeout the
 * process exits 0; otherwise the remaining connections are forcibly terminated and
 * the process exits non-zero.
 *
 * The same handler is intended to be wired to `SIGTERM`, `SIGINT`, and
 * `uncaughtException` so that crashes drain rather than exiting abruptly.
 *
 * @param server - The HTTP server whose connections should be drained.
 * @param options - Shutdown options including the requested drain timeout.
 * @returns An idempotent shutdown handler.
 */
export function createGracefulShutdown(
  server: Server,
  options: GracefulShutdownOptions
): GracefulShutdownHandler {
  const drainTimeoutMs = clampDrainTimeoutMs(options.drainTimeoutMs);
  let started = false;

  return function shutdown(signal: string): Promise<void> {
    // Idempotent: a second signal during shutdown is a no-op.
    if (started) {
      return Promise.resolve();
    }
    started = true;

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (code: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        // Resolve the promise before exiting so awaiting callers observe completion.
        resolve();
        process.exit(code);
      };

      console.log(
        `[shutdown] ${signal} received; draining in-flight requests ` +
        `(timeout ${drainTimeoutMs}ms)...`
      );

      // 23.1: Stop accepting new connections. The callback fires once every
      // existing connection has ended → all in-flight requests drained (23.3).
      server.close(() => {
        console.log('[shutdown] all in-flight requests drained; exiting cleanly.');
        finish(EXIT_SUCCESS);
      });

      // Close idle keep-alive sockets so they do not hold the drain open. Guarded
      // for runtimes/servers where the API is unavailable.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }

      // 23.4 / 23.6: On timeout, terminate remaining connections and exit non-zero.
      timer = setTimeout(() => {
        console.error(
          `[shutdown] drain timeout of ${drainTimeoutMs}ms elapsed; ` +
          'terminating remaining connections and exiting.'
        );
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        finish(EXIT_DRAIN_TIMEOUT);
      }, drainTimeoutMs);

      // Do not let the drain timer keep the event loop alive on its own.
      timer.unref();
    });
  };
}

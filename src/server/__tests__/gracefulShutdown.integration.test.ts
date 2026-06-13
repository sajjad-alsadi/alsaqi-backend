// @vitest-environment node
// Feature: backend-security-hardening, Task 12.12: Graceful shutdown behavior integration test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import { createGracefulShutdown } from '../gracefulShutdown.js';

/**
 * Integration tests for `createGracefulShutdown` drive the handler against a fake
 * HTTP server and a stubbed `process.exit`, asserting the full drain-then-exit
 * lifecycle:
 *
 *   - Req 23.1: a shutdown signal stops the server accepting new connections.
 *   - Req 23.3: draining completing before the timeout exits with success (0).
 *   - Req 23.4: the drain timeout elapsing terminates remaining connections and
 *               exits non-zero.
 *   - Req 23.5 / 23.6: an uncaught exception follows the same drain-then-exit path
 *               and the handler is idempotent across repeated invocations.
 *
 * Fake timers drive the timeout deterministically and `process.exit` is stubbed so
 * the test runner is never killed.
 */

/** A controllable fake of the subset of {@link Server} the handler depends on. */
interface FakeServer {
  /** Captured `close` callback so the test can simulate drain completion. */
  closeCallback: (() => void) | undefined;
  close: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
}

function createFakeServer(): FakeServer {
  const fake: FakeServer = {
    closeCallback: undefined,
    close: vi.fn(),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
  // Capture the drain-completion callback rather than invoking it, so tests decide
  // when (or whether) draining finishes.
  fake.close.mockImplementation((cb?: () => void) => {
    fake.closeCallback = cb;
    return fake as unknown as Server;
  });
  return fake;
}

describe('Task 12.12: graceful shutdown behavior (integration)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Stub process.exit so the handler cannot terminate the test runner.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    // Silence the handler's diagnostic logging.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops accepting new connections on a shutdown signal (Req 23.1)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    void shutdown('SIGTERM');

    // server.close() halts acceptance of new connections; idle keep-alive sockets
    // are released so they cannot hold the drain open.
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
  });

  it('exits 0 when draining completes before the timeout (Req 23.3)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    const done = shutdown('SIGTERM');

    // Simulate all in-flight requests completing before the timeout elapses.
    expect(server.closeCallback).toBeTypeOf('function');
    server.closeCallback?.();
    await done;

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    // Draining succeeded, so connections are never force-terminated.
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('terminates remaining connections and exits non-zero when the drain timeout elapses (Req 23.4)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    const done = shutdown('SIGTERM');

    // The close callback never fires; advance past the drain timeout.
    vi.advanceTimersByTime(5000);
    await done;

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    const exitCode = exitSpy.mock.calls[0]?.[0] as number;
    expect(exitCode).not.toBe(0);
  });

  it('follows the same drain-then-exit path under uncaughtException (Req 23.5)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    const done = shutdown('uncaughtException');

    // 23.5: still stops accepting connections and attempts to drain.
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);

    server.closeCallback?.();
    await done;

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when the drain timeout elapses after an uncaughtException (Req 23.6)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    const done = shutdown('uncaughtException');

    vi.advanceTimersByTime(5000);
    await done;

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    const exitCode = exitSpy.mock.calls[0]?.[0] as number;
    expect(exitCode).not.toBe(0);
  });

  it('is idempotent: a second invocation during shutdown is a no-op (Req 23.5)', async () => {
    const server = createFakeServer();
    const shutdown = createGracefulShutdown(server as unknown as Server, {
      drainTimeoutMs: 5000,
    });

    const first = shutdown('SIGTERM');
    // A second signal arriving mid-drain must not re-trigger close or a new drain.
    await shutdown('SIGINT');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);

    server.closeCallback?.();
    await first;

    // Only the single drain path exits the process.
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

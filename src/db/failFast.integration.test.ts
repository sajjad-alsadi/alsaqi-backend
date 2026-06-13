// @vitest-environment node
// Feature: backend-security-hardening, Task 2.7
// Integration tests for DB fail-fast startup and pool-acquisition timeout.
//
// Validates:
//   - Requirement 1.5: a failed external-PostgreSQL connection within the 30s
//     startup budget logs a fatal error and terminates the process with a
//     non-zero exit code without creating a PGlite instance.
//   - Requirement 2.4: a connection-pool acquisition timeout surfaces as a
//     returned/thrown error (POOL_ACQUISITION_TIMEOUT) without terminating the
//     process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePoolError, DBWrapper } from './index.js';

describe('DB pool-acquisition timeout surfaces as an error without exiting (Req 2.4)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit must never be called for a pool-acquisition timeout (Req 2.4).
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`UNEXPECTED process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizePoolError maps the pg "timeout exceeded" message to POOL_ACQUISITION_TIMEOUT', () => {
    const raw = new Error('timeout exceeded when trying to connect');
    const normalized = normalizePoolError(raw);

    expect(normalized.code).toBe('POOL_ACQUISITION_TIMEOUT');
    expect(normalized.statusCode).toBe(503);
    expect(String(normalized.message).toLowerCase()).toContain('pool acquisition timeout');
    expect(normalized.cause).toBe(raw);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('normalizePoolError maps "connection terminated due to connection timeout"', () => {
    const raw = new Error('Connection terminated due to connection timeout');
    const normalized = normalizePoolError(raw);

    expect(normalized.code).toBe('POOL_ACQUISITION_TIMEOUT');
    expect(normalized.statusCode).toBe(503);
  });

  it('normalizePoolError passes a pre-coded POOL_ACQUISITION_TIMEOUT error through', () => {
    const raw: any = new Error('all connections in use');
    raw.code = 'POOL_ACQUISITION_TIMEOUT';
    const normalized = normalizePoolError(raw);

    expect(normalized.code).toBe('POOL_ACQUISITION_TIMEOUT');
    expect(normalized.statusCode).toBe(503);
  });

  it('returns non-timeout errors unchanged and never exits', () => {
    const raw: any = new Error('relation "users" does not exist');
    raw.code = '42P01';
    const normalized = normalizePoolError(raw);

    // Same instance, untouched.
    expect(normalized).toBe(raw);
    expect(normalized.code).toBe('42P01');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('the external transaction wrapper surfaces a pool-acquisition timeout as a thrown POOL_ACQUISITION_TIMEOUT error', async () => {
    // Simulate a saturated pool: acquiring a connection rejects with pg's
    // acquisition-timeout message.
    const acquireError = new Error('timeout exceeded when trying to connect');
    const fakeExternalClient = {
      connect: vi.fn().mockRejectedValue(acquireError),
      query: vi.fn(),
      end: vi.fn(),
    };

    const wrapper = new DBWrapper(fakeExternalClient, /* isExternal */ true);

    const work = vi.fn(async () => 'should-not-run');

    await expect(wrapper.transaction(work)).rejects.toMatchObject({
      code: 'POOL_ACQUISITION_TIMEOUT',
      statusCode: 503,
    });

    // The transaction body never ran because the connection was never acquired.
    expect(work).not.toHaveBeenCalled();
    // The pool timeout must not terminate the process (Req 2.4).
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('DB fail-fast: non-zero exit on failed external connect within budget (Req 1.5)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Configure a production deployment pointing at a (mocked) unreachable
    // external PostgreSQL instance.
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@db.example.test:5432/appdb';
    delete process.env.ALLOW_EMBEDDED_DB;
    delete process.env.DB_SSL_CA_PATH;
    // Use documented pool defaults (no pool env vars).
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('logs a fatal error and exits non-zero (without creating PGlite) when the connection fails', async () => {
    // The pg pool always rejects connection attempts to emulate an unreachable host.
    const connErr: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    connErr.code = 'ECONNREFUSED';

    const queryMock = vi.fn().mockRejectedValue(connErr);
    const FakePoolCtor = vi.fn();
    class FakePool {
      query = queryMock;
      connect = vi.fn().mockRejectedValue(connErr);
      end = vi.fn().mockResolvedValue(undefined);
      on = vi.fn();
      constructor(...args: unknown[]) {
        FakePoolCtor(...args);
      }
    }

    vi.doMock('pg', () => ({ default: { Pool: FakePool } }));

    // Avoid re-registering prom-client metrics (a process-wide singleton registry)
    // when the DB module is re-imported under vi.resetModules().
    vi.doMock('../monitoring/dbMetrics.js', () => ({
      checkSlowQuery: vi.fn(),
      initDbMetrics: vi.fn(),
    }));

    // A PGlite instance must NOT be created on the fail-fast path. Track construction.
    const pgliteCtor = vi.fn();
    vi.doMock('@electric-sql/pglite', () => ({
      PGlite: class {
        constructor(...args: unknown[]) {
          pgliteCtor(...args);
        }
        waitReady = Promise.resolve();
        query = vi.fn();
        close = vi.fn();
      },
    }));

    // Keep the connect budget effectively the full 30s window (independent of
    // how long the suite has been running) so we exercise the in-budget failure
    // path rather than the budget-exceeded path.
    vi.spyOn(process, 'uptime').mockReturnValue(0.01);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    // process.exit is stubbed to throw a sentinel so execution halts like a real exit.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const { initDb } = await import('./index.js');

    await expect(initDb()).rejects.toThrow(/process\.exit:1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Fail-fast must not fall back to the embedded database.
    expect(pgliteCtor).not.toHaveBeenCalled();
    // A fatal log naming the failure was emitted.
    const loggedFatal = errorLog.mock.calls
      .map((c) => String(c[0]))
      .some((line) => /FATAL/i.test(line) && /PostgreSQL connection/i.test(line));
    expect(loggedFatal).toBe(true);
  }, 20000);
});

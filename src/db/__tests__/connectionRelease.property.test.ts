// @vitest-environment node
// Feature: production-launch-readiness, Property 4: Connection-release stability after timeout
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 4: ثبات تحرير الاتصال بعد انتهاء المهلة
 *
 * For ANY sequence of operations executed through the pool — including statements
 * that exceed `statement_timeout` and operations that are cancelled/error — the
 * count of connections checked out from the pool returns, after each operation
 * completes (success OR timeout/error), to its baseline value before the
 * operation. Every affected connection is released back and remains reusable for
 * subsequent requests, and the timeout error is surfaced to the caller without
 * leaking a connection.
 *
 * Validates: Requirements 7.2, 7.3, 7.6
 *
 * Strategy:
 * - Build a FAKE pool/client model (the real pg.Pool is unavailable in unit tests)
 *   that tracks checked-out connections with a counter and a free-list of reusable
 *   physical connections.
 * - Faithfully mirror the real `transaction()` acquire → try → finally(release)
 *   wrapper from src/db/index.ts, including normalizePoolError on acquisition.
 * - Generate sequences mixing: success, statement-timeout cancellation, generic
 *   error, and pool-acquisition timeout.
 * - Assert that after every operation the in-use counter returns to baseline, the
 *   physical connection is returned to the pool and reusable, and timeout errors
 *   surface to the caller.
 */

// ─── normalizePoolError replica (mirror of src/db/index.ts) ──────────────────

interface NormalizedDbError extends Error {
  code?: string;
  statusCode?: number;
  cause?: unknown;
}

function normalizePoolError(err: unknown): NormalizedDbError {
  const source = (err ?? null) as { message?: unknown; code?: unknown } | null;
  const message = String(source?.message ?? '').toLowerCase();
  const isAcquisitionTimeout =
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('connection terminated due to connection timeout') ||
    source?.code === 'POOL_ACQUISITION_TIMEOUT';

  if (!isAcquisitionTimeout) {
    return err as NormalizedDbError;
  }

  const normalized: NormalizedDbError = new Error(
    'pool acquisition timeout: a database connection did not become available within the configured acquisition timeout'
  );
  normalized.code = 'POOL_ACQUISITION_TIMEOUT';
  normalized.statusCode = 503;
  normalized.cause = err;
  return normalized;
}

// ─── Error factories mirroring real driver/pool failures ─────────────────────

/** PostgreSQL cancels a statement that exceeds statement_timeout (SQLSTATE 57014). */
function statementTimeoutError(): Error {
  const e = new Error('canceling statement due to statement timeout');
  (e as { code?: string }).code = '57014';
  return e;
}

/** pg.Pool throws this when no connection becomes available within the timeout. */
function acquisitionTimeoutError(): Error {
  return new Error('timeout exceeded when trying to connect');
}

function genericQueryError(msg: string): Error {
  return new Error(msg);
}

// ─── Fake pool/client model ──────────────────────────────────────────────────

type QueryFailure = 'none' | 'statement-timeout' | 'generic-error';

interface OpBehavior {
  /** When true, the pool fails to hand out a connection (acquisition timeout). */
  acquireTimeout: boolean;
  /** Which query (by 0-based index among BEGIN/body.../COMMIT) fails, or -1 for none. */
  failAtQueryIndex: number;
  failureKind: QueryFailure;
  /** Number of body queries executed inside the transaction. */
  bodyQueryCount: number;
  errorMessage: string;
}

class FakeConnection {
  released = false;
  queries: string[] = [];
  private queryCounter = 0;

  constructor(
    readonly id: number,
    private behavior: OpBehavior,
    private readonly pool: FakePool
  ) {}

  rearm(behavior: OpBehavior): void {
    this.behavior = behavior;
    this.released = false;
    this.queries = [];
    this.queryCounter = 0;
  }

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (this.released) {
      // A released connection must never be used again (leak/double-use guard).
      throw new Error(`FakeConnection ${this.id} used after release`);
    }
    const idx = this.queryCounter++;
    this.queries.push(sql);
    if (idx === this.behavior.failAtQueryIndex) {
      if (this.behavior.failureKind === 'statement-timeout') {
        throw statementTimeoutError();
      }
      if (this.behavior.failureKind === 'generic-error') {
        throw genericQueryError(this.behavior.errorMessage);
      }
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.pool.releaseBack(this);
  }
}

class FakePool {
  inUse = 0;
  peakInUse = 0;
  totalCreated = 0;
  private free: FakeConnection[] = [];
  /** Every physical connection ever created, for reuse/leak inspection. */
  readonly all: FakeConnection[] = [];

  async connect(behavior: OpBehavior): Promise<FakeConnection> {
    if (behavior.acquireTimeout) {
      // No connection is checked out when acquisition times out.
      throw acquisitionTimeoutError();
    }
    let conn = this.free.pop();
    if (conn) {
      conn.rearm(behavior);
    } else {
      conn = new FakeConnection(this.totalCreated++, behavior, this);
      this.all.push(conn);
    }
    this.inUse++;
    if (this.inUse > this.peakInUse) this.peakInUse = this.inUse;
    return conn;
  }

  releaseBack(conn: FakeConnection): void {
    this.inUse--;
    conn.released = true;
    this.free.push(conn);
  }

  /** Connections currently available for reuse. */
  get freeCount(): number {
    return this.free.length;
  }
}

// ─── transaction() wrapper — faithful mirror of src/db/index.ts ──────────────

async function runTransaction<T>(
  pool: FakePool,
  behavior: OpBehavior,
  fn: (conn: FakeConnection) => Promise<T>
): Promise<T> {
  let connection: FakeConnection;
  try {
    connection = await pool.connect(behavior);
  } catch (acquireErr) {
    // Surface pool-acquisition timeouts as a returned (normalized) error without
    // checking out / leaking a connection (Req 7.6).
    throw normalizePoolError(acquireErr);
  }

  try {
    await connection.query('BEGIN');
    const result = await fn(connection);
    await connection.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await connection.query('ROLLBACK');
    } catch {
      // ROLLBACK best-effort; the released connection guard means a cancelled
      // connection may also reject here — ignored, release still happens.
    }
    throw normalizePoolError(e);
  } finally {
    // release-in-finally: the affected connection always returns to the pool.
    connection.release();
  }
}

/** Executes one generated operation through the transaction wrapper. */
async function executeOperation(
  pool: FakePool,
  behavior: OpBehavior
): Promise<{ ok: boolean; error: NormalizedDbError | null }> {
  try {
    await runTransaction(pool, behavior, async (conn) => {
      for (let i = 0; i < behavior.bodyQueryCount; i++) {
        await conn.query(`SELECT ${i}`);
      }
      return 'ok';
    });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e as NormalizedDbError };
  }
}

// ─── Generators ──────────────────────────────────────────────────────────────

const operationArb: fc.Arbitrary<OpBehavior> = fc
  .record({
    kind: fc.constantFrom(
      'success',
      'statement-timeout',
      'generic-error',
      'acquire-timeout'
    ),
    bodyQueryCount: fc.integer({ min: 0, max: 6 }),
    // Relative position of the failure among queries: BEGIN(0) .. body .. COMMIT.
    failPosition: fc.integer({ min: 0, max: 7 }),
    errorMessage: fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => s.trim().length > 0),
  })
  .map(({ kind, bodyQueryCount, failPosition, errorMessage }) => {
    const acquireTimeout = kind === 'acquire-timeout';
    // Total queries within the body path: BEGIN + bodyQueryCount + COMMIT.
    const totalQueries = bodyQueryCount + 2;
    const failureKind: QueryFailure =
      kind === 'statement-timeout'
        ? 'statement-timeout'
        : kind === 'generic-error'
          ? 'generic-error'
          : 'none';
    const failAtQueryIndex =
      failureKind === 'none' ? -1 : failPosition % totalQueries;
    return {
      acquireTimeout,
      failAtQueryIndex,
      failureKind,
      bodyQueryCount,
      errorMessage,
    };
  });

const operationSequenceArb = fc.array(operationArb, {
  minLength: 1,
  maxLength: 25,
});

// ─── Properties ───────────────────────────────────────────────────────────────

describe('Property 4: ثبات تحرير الاتصال بعد انتهاء المهلة (connection release)', () => {
  it('returns the checked-out count to baseline after each operation (success or timeout/error)', async () => {
    await fc.assert(
      fc.asyncProperty(operationSequenceArb, async (operations) => {
        const pool = new FakePool();

        for (const behavior of operations) {
          const baseline = pool.inUse; // baseline before this operation

          await executeOperation(pool, behavior);

          // Invariant: after the operation completes, the in-use counter is back
          // to the baseline — no connection is leaked, regardless of outcome.
          expect(pool.inUse).toBe(baseline);
        }

        // Across the whole sequence, no connection remains checked out.
        expect(pool.inUse).toBe(0);

        // Every physical connection ever created is released and reusable.
        for (const conn of pool.all) {
          expect(conn.released).toBe(true);
        }
        expect(pool.freeCount).toBe(pool.totalCreated);
      }),
      { numRuns: 200 }
    );
  });

  it('caps concurrent checkouts at one per sequential operation (connections are reused)', async () => {
    await fc.assert(
      fc.asyncProperty(operationSequenceArb, async (operations) => {
        const pool = new FakePool();

        for (const behavior of operations) {
          await executeOperation(pool, behavior);
        }

        // Sequential operations each acquire then release before the next, so at
        // most one connection is ever in use at a time, and the pool reuses a
        // single physical connection rather than creating one per operation.
        expect(pool.peakInUse).toBeLessThanOrEqual(1);
        if (operations.some((o) => !o.acquireTimeout)) {
          expect(pool.totalCreated).toBe(1);
        } else {
          // Every operation was an acquisition timeout: no connection created.
          expect(pool.totalCreated).toBe(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('surfaces statement-timeout cancellations to the caller while releasing the connection', async () => {
    const stmtTimeoutArb = fc
      .record({
        bodyQueryCount: fc.integer({ min: 1, max: 6 }),
        failPosition: fc.integer({ min: 0, max: 7 }),
      })
      .map(({ bodyQueryCount, failPosition }) => {
        const totalQueries = bodyQueryCount + 2;
        return {
          acquireTimeout: false,
          failAtQueryIndex: failPosition % totalQueries,
          failureKind: 'statement-timeout' as QueryFailure,
          bodyQueryCount,
          errorMessage: 'unused',
        } satisfies OpBehavior;
      });

    await fc.assert(
      fc.asyncProperty(stmtTimeoutArb, async (behavior) => {
        const pool = new FakePool();
        const result = await executeOperation(pool, behavior);

        // The timeout error is surfaced to the caller.
        expect(result.ok).toBe(false);
        expect(result.error).not.toBeNull();
        expect(String(result.error?.message).toLowerCase()).toContain(
          'statement timeout'
        );

        // The affected connection is released back and reusable; nothing leaked.
        expect(pool.inUse).toBe(0);
        expect(pool.freeCount).toBe(1);
        expect(pool.all[0]?.released).toBe(true);

        // A subsequent operation can reuse the same physical connection.
        await executeOperation(pool, {
          acquireTimeout: false,
          failAtQueryIndex: -1,
          failureKind: 'none',
          bodyQueryCount: 1,
          errorMessage: 'unused',
        });
        expect(pool.inUse).toBe(0);
        expect(pool.totalCreated).toBe(1);
      }),
      { numRuns: 200 }
    );
  });

  it('surfaces pool-acquisition timeouts as 503 POOL_ACQUISITION_TIMEOUT without leaking a connection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        async (bodyQueryCount) => {
          const pool = new FakePool();
          const result = await executeOperation(pool, {
            acquireTimeout: true,
            failAtQueryIndex: -1,
            failureKind: 'none',
            bodyQueryCount,
            errorMessage: 'unused',
          });

          // The acquisition timeout is normalized and surfaced to the caller.
          expect(result.ok).toBe(false);
          expect(result.error?.code).toBe('POOL_ACQUISITION_TIMEOUT');
          expect(result.error?.statusCode).toBe(503);

          // No connection was ever checked out, so none can leak.
          expect(pool.inUse).toBe(0);
          expect(pool.totalCreated).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });
});

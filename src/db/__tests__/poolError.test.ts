import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizePoolError,
  DBWrapper,
  type NormalizedDbError,
  type DBConnection,
  type DatabaseClient,
} from "../index.js";

/**
 * Unit tests for `normalizePoolError` and the external `transaction()` path.
 *
 * Covers (Task 4.5, Requirements 7.3, 7.6):
 *  - A pool acquisition timeout is normalized to an error with
 *    code `POOL_ACQUISITION_TIMEOUT` and `statusCode: 503`.
 *  - The transaction wrapper releases the checked-out client in `finally`
 *    even when the wrapped operation throws (e.g. a cancelled statement),
 *    and the pool connection returns healthy and reusable afterwards.
 */

describe("normalizePoolError", () => {
  it("maps a pg pool acquisition timeout (by message) to POOL_ACQUISITION_TIMEOUT / 503", () => {
    const original = new Error("timeout exceeded when trying to connect");
    const normalized = normalizePoolError(original);

    expect(normalized.code).toBe("POOL_ACQUISITION_TIMEOUT");
    expect(normalized.statusCode).toBe(503);
    expect(normalized.cause).toBe(original);
    expect(normalized.message).toMatch(/pool acquisition timeout/i);
  });

  it("maps a 'Connection terminated due to connection timeout' error to POOL_ACQUISITION_TIMEOUT / 503", () => {
    const original = new Error(
      "Connection terminated due to connection timeout"
    );
    const normalized = normalizePoolError(original);

    expect(normalized.code).toBe("POOL_ACQUISITION_TIMEOUT");
    expect(normalized.statusCode).toBe(503);
  });

  it("maps an error already carrying code POOL_ACQUISITION_TIMEOUT to a 503 normalized error", () => {
    const original = Object.assign(new Error("acquire failed"), {
      code: "POOL_ACQUISITION_TIMEOUT",
    });
    const normalized = normalizePoolError(original);

    expect(normalized.code).toBe("POOL_ACQUISITION_TIMEOUT");
    expect(normalized.statusCode).toBe(503);
    expect(normalized.cause).toBe(original);
  });

  it("returns non-timeout errors unchanged (no code/statusCode injected)", () => {
    const original = Object.assign(new Error("syntax error at or near"), {
      code: "42601",
    });
    const normalized = normalizePoolError(original) as NormalizedDbError;

    // Same instance returned, untouched.
    expect(normalized).toBe(original);
    expect(normalized.code).toBe("42601");
    expect(normalized.statusCode).toBeUndefined();
  });

  it("handles null/undefined input without throwing and does not classify it as a timeout", () => {
    const fromNull = normalizePoolError(null);
    const fromUndefined = normalizePoolError(undefined);

    // Neither is a timeout, so they are returned unchanged.
    expect((fromNull as NormalizedDbError)?.code).toBeUndefined();
    expect((fromUndefined as NormalizedDbError)?.code).toBeUndefined();
  });
});

/**
 * A fake pooled connection. Records the SQL it executed and whether it was
 * released, and lets a test inject a failure for a specific statement to
 * simulate a cancelled statement (statement_timeout).
 */
class FakeConnection implements DBConnection {
  public executed: string[] = [];
  public released = false;
  public releaseCount = 0;

  constructor(
    private readonly failOn?: { sql: string; error: Error } | null
  ) {}

  async query(sql: string): Promise<any> {
    this.executed.push(sql);
    if (this.failOn && sql === this.failOn.sql) {
      throw this.failOn.error;
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
    this.releaseCount += 1;
  }
}

/**
 * A fake external pool that hands out a single connection per `connect()` and
 * supports simulating an acquisition timeout. Tracks checked-out connections
 * so a test can assert the pool stays healthy (every connection released).
 */
class FakePool implements DatabaseClient {
  public connections: FakeConnection[] = [];
  public connectError: Error | null = null;

  constructor(
    private readonly nextConnectionFactory: () => FakeConnection
  ) {}

  // The wrapper uses pool.connect() for external mode.
  async connect(): Promise<DBConnection> {
    if (this.connectError) {
      throw this.connectError;
    }
    const conn = this.nextConnectionFactory();
    this.connections.push(conn);
    return conn;
  }

  // Required by DBConnection; not used for the external transaction path.
  async query(): Promise<any> {
    return { rows: [], rowCount: 0 };
  }
}

describe("DBWrapper.transaction (external pool path)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits successfully and releases the checked-out connection", async () => {
    const conn = new FakeConnection();
    const pool = new FakePool(() => conn);
    const db = new DBWrapper(pool, true);

    const result = await db.transaction(async () => "ok");

    expect(result).toBe("ok");
    expect(conn.executed).toEqual(["BEGIN", "COMMIT"]);
    expect(conn.released).toBe(true);
    expect(conn.releaseCount).toBe(1);
  });

  it("releases the connection in finally when the wrapped operation throws (statement cancelled)", async () => {
    const conn = new FakeConnection();
    const pool = new FakePool(() => conn);
    const db = new DBWrapper(pool, true);

    // Simulate a statement cancelled by statement_timeout inside the tx body.
    const cancelled = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" }
    );

    await expect(
      db.transaction(async () => {
        throw cancelled;
      })
    ).rejects.toBe(cancelled);

    // Rolled back, and the connection was returned to the pool despite the throw.
    expect(conn.executed).toEqual(["BEGIN", "ROLLBACK"]);
    expect(conn.released).toBe(true);
    expect(conn.releaseCount).toBe(1);
  });

  it("returns the connection healthy and reusable after a cancelled statement", async () => {
    // A pool that recycles a single underlying connection: once released it can
    // be checked out again, mirroring a healthy pg.Pool connection.
    const recycled = new FakeConnection();
    const pool = new FakePool(() => recycled);
    const db = new DBWrapper(pool, true);

    const cancelled = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" }
    );

    await expect(
      db.transaction(async () => {
        throw cancelled;
      })
    ).rejects.toBe(cancelled);

    expect(recycled.released).toBe(true);

    // The same connection is reused for a subsequent transaction and works.
    recycled.executed = [];
    const result = await db.transaction(async () => 42);

    expect(result).toBe(42);
    expect(recycled.executed).toEqual(["BEGIN", "COMMIT"]);
    // Released again on the second transaction -> two total releases, no leak.
    expect(recycled.releaseCount).toBe(2);
  });

  it("normalizes a pool acquisition timeout raised by connect() to POOL_ACQUISITION_TIMEOUT / 503", async () => {
    const conn = new FakeConnection();
    const pool = new FakePool(() => conn);
    pool.connectError = new Error("timeout exceeded when trying to connect");
    const db = new DBWrapper(pool, true);

    let caught: NormalizedDbError | undefined;
    try {
      await db.transaction(async () => "never runs");
    } catch (err) {
      caught = err as NormalizedDbError;
    }

    expect(caught).toBeDefined();
    expect(caught!.code).toBe("POOL_ACQUISITION_TIMEOUT");
    expect(caught!.statusCode).toBe(503);
    // No connection was ever checked out, so nothing to release/leak.
    expect(pool.connections).toHaveLength(0);
  });
});

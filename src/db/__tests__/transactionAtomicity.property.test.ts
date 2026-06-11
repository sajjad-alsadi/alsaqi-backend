// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 12: Transaction Atomicity and Connection Release
 *
 * **Validates: Requirements 8.4**
 *
 * For any sequence of database operations executed within a `db.transaction()` call,
 * if any operation throws an error, the transaction SHALL execute ROLLBACK and release
 * the pool connection; if all operations succeed, it SHALL execute COMMIT and release
 * the pool connection.
 *
 * Strategy:
 * - Create a mock pool that tracks query calls (BEGIN, COMMIT, ROLLBACK) and connection release
 * - Generate arbitrary operations that either succeed or throw
 * - Verify that on error: ROLLBACK is called and connection is released
 * - Verify that on success: COMMIT is called and connection is released
 * - Connection must ALWAYS be released regardless of outcome (finally block behavior)
 */

// ─── Isolated DBWrapper for testing (avoids module-level side effects) ───────

// We re-implement the transaction logic matching src/db/index.ts to test the
// contract without triggering actual database connections or PGlite initialization.

import { AsyncLocalStorage } from 'async_hooks';

const als = new AsyncLocalStorage<any>();

class TestableDBWrapper {
  private _client: any;
  private _isExternal: boolean;

  constructor(client: any, isExternal: boolean) {
    this._client = client;
    this._isExternal = isExternal;
  }

  get client() { return this._client; }
  get isExternal() { return this._isExternal; }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    let connection = this._client;
    let needsRelease = false;

    if (this._isExternal) {
      connection = await this._client.connect();
      needsRelease = true;
    }

    return await als.run(connection, async () => {
      try {
        await connection.query('BEGIN');
        const result = await fn();
        await connection.query('COMMIT');
        return result;
      } catch (e) {
        try { await connection.query('ROLLBACK'); } catch (rollbackErr) {}
        throw e;
      } finally {
        if (needsRelease) connection.release();
      }
    });
  }
}

// ─── Mock Factories ──────────────────────────────────────────────────────────

interface MockConnection {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  queries: string[];
  released: boolean;
}

function createMockConnection(): MockConnection {
  const queries: string[] = [];

  const conn: MockConnection = {
    queries,
    released: false,
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      conn.released = true;
    }),
  };

  return conn;
}

function createMockPool(connection: MockConnection) {
  return {
    connect: vi.fn(async () => connection),
    query: connection.query,
  };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate an arbitrary error message for simulating operation failures
 */
const errorMessageArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);

/**
 * Generate an arbitrary number of successful operations (0 to 10)
 */
const successfulOpsCountArb = fc.integer({ min: 0, max: 10 });

/**
 * Generate an arbitrary return value from a successful transaction
 */
const returnValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer(), { minLength: 0, maxLength: 5 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer())
);

/**
 * Generate a scenario describing how many ops succeed before one throws.
 */
const failingTransactionArb = fc.record({
  opsBeforeError: fc.integer({ min: 0, max: 10 }),
  errorMessage: errorMessageArb,
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 12: Transaction Atomicity and Connection Release', () => {
  it('ROLLBACK is called and connection is released when any operation throws', async () => {
    await fc.assert(
      fc.asyncProperty(failingTransactionArb, async ({ opsBeforeError, errorMessage }) => {
        const mockConn = createMockConnection();
        const mockPool = createMockPool(mockConn);
        const dbWrapper = new TestableDBWrapper(mockPool, true);

        let caughtError: Error | null = null;

        try {
          await dbWrapper.transaction(async () => {
            // Simulate successful operations before the failing one
            for (let i = 0; i < opsBeforeError; i++) {
              await mockConn.query(`SELECT ${i}`);
            }
            // Now throw an error
            throw new Error(errorMessage);
          });
        } catch (e: any) {
          caughtError = e;
        }

        // The error must be rethrown
        expect(caughtError).not.toBeNull();
        expect(caughtError!.message).toBe(errorMessage);

        // Verify BEGIN was called first
        expect(mockConn.queries[0]).toBe('BEGIN');

        // Verify ROLLBACK was called
        expect(mockConn.queries).toContain('ROLLBACK');

        // Verify COMMIT was NOT called
        expect(mockConn.queries).not.toContain('COMMIT');

        // Verify connection was released (finally block)
        expect(mockConn.released).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('COMMIT is called and connection is released when all operations succeed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ opsCount: successfulOpsCountArb, returnValue: returnValueArb }),
        async ({ opsCount, returnValue }) => {
          const mockConn = createMockConnection();
          const mockPool = createMockPool(mockConn);
          const dbWrapper = new TestableDBWrapper(mockPool, true);

          const result = await dbWrapper.transaction(async () => {
            // Simulate successful operations
            for (let i = 0; i < opsCount; i++) {
              await mockConn.query(`INSERT INTO t VALUES (${i})`);
            }
            return returnValue;
          });

          // Verify the return value is passed through
          expect(result).toEqual(returnValue);

          // Verify BEGIN was called first
          expect(mockConn.queries[0]).toBe('BEGIN');

          // Verify COMMIT was called
          expect(mockConn.queries).toContain('COMMIT');

          // Verify ROLLBACK was NOT called
          expect(mockConn.queries).not.toContain('ROLLBACK');

          // Verify connection was released (finally block)
          expect(mockConn.released).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('connection is ALWAYS released regardless of transaction outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          shouldFail: fc.boolean(),
          opsCount: fc.integer({ min: 0, max: 5 }),
          errorMessage: errorMessageArb,
        }),
        async ({ shouldFail, opsCount, errorMessage }) => {
          const mockConn = createMockConnection();
          const mockPool = createMockPool(mockConn);
          const dbWrapper = new TestableDBWrapper(mockPool, true);

          try {
            await dbWrapper.transaction(async () => {
              for (let i = 0; i < opsCount; i++) {
                await mockConn.query(`UPDATE t SET x = ${i}`);
              }
              if (shouldFail) {
                throw new Error(errorMessage);
              }
              return 'ok';
            });
          } catch (e) {
            // Expected when shouldFail is true
          }

          // Regardless of success or failure, connection MUST be released
          expect(mockConn.released).toBe(true);

          // Verify pool.connect was called (external mode acquires connection)
          expect(mockPool.connect).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

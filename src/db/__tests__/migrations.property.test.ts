// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { MigrationRunner, Migration, MigrationRecord } from '../migrationRunner';

/**
 * Property-Based Tests for the Migration System
 *
 * Property 4: Migration Atomicity
 * Property 5: Migration Audit Trail
 * Property 6: Migration Rollback Round-Trip
 *
 * **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
 *
 * Strategy: We use an in-memory simulation of the IDBWrapper that faithfully
 * replicates transaction semantics (BEGIN/COMMIT/ROLLBACK). The MigrationRunner
 * under test is the IDBWrapper-based one at src/db/migrationRunner.ts.
 *
 * This approach allows us to verify the correctness properties without needing
 * a real database, while still testing that the MigrationRunner correctly uses
 * transactions to ensure atomicity, audit trails, and rollback round-trips.
 */

// ─── Mock logger ─────────────────────────────────────────────────────────────

vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── In-memory DB simulation with real transaction semantics ─────────────────

interface InMemoryRow {
  version: string;
  name: string;
  type: string;
  applied_at: string;
}

/**
 * Creates a mock IDBWrapper that simulates real transaction behavior:
 * - Tracks schema_migrations table rows in memory
 * - Supports BEGIN/COMMIT/ROLLBACK semantics within transaction()
 * - If any operation inside transaction() throws, all changes are rolled back
 */
function createInMemoryDb() {
  const rows: InMemoryRow[] = [];
  // Track DDL operations (table creations) performed by migrations
  const tables: Set<string> = new Set();

  // Pending changes within a transaction (for rollback support)
  let txPendingInserts: InMemoryRow[] = [];
  let txPendingDeletes: string[] = []; // versions to delete
  let txPendingTables: string[] = [];
  let inTransaction = false;

  const mockDb: any = {
    exec: vi.fn(async (sql: string) => {
      // CREATE TABLE IF NOT EXISTS schema_migrations - always succeeds
      if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        tables.add('schema_migrations');
      }
    }),

    prepare: vi.fn((sql: string) => {
      return {
        get: vi.fn(async (...params: any[]) => {
          return undefined;
        }),
        all: vi.fn(async (...params: any[]) => {
          if (sql.includes('SELECT') && sql.includes('schema_migrations')) {
            // Return current committed rows
            return [...rows];
          }
          return [];
        }),
        run: vi.fn(async (...params: any[]) => {
          if (sql.includes('INSERT INTO schema_migrations')) {
            const newRow: InMemoryRow = {
              version: params[0],
              name: params[1],
              type: params[2],
              applied_at: new Date().toISOString(),
            };
            if (inTransaction) {
              txPendingInserts.push(newRow);
            } else {
              rows.push(newRow);
            }
          } else if (sql.includes('DELETE FROM schema_migrations')) {
            const version = params[0];
            if (inTransaction) {
              txPendingDeletes.push(version);
            } else {
              const idx = rows.findIndex(r => r.version === version);
              if (idx !== -1) rows.splice(idx, 1);
            }
          }
          return { lastInsertRowid: 0, changes: 1 };
        }),
      };
    }),

    transaction: vi.fn(async (fn: () => Promise<any>) => {
      // Simulate real transaction semantics:
      // - Begin: mark we're in a transaction
      // - Execute fn: all inserts/deletes go to pending buffers
      // - Commit: apply pending changes to main store
      // - Rollback: discard pending changes on error
      inTransaction = true;
      txPendingInserts = [];
      txPendingDeletes = [];
      txPendingTables = [];

      try {
        const result = await fn();
        // COMMIT: apply pending changes
        for (const row of txPendingInserts) {
          rows.push(row);
        }
        for (const version of txPendingDeletes) {
          const idx = rows.findIndex(r => r.version === version);
          if (idx !== -1) rows.splice(idx, 1);
        }
        for (const table of txPendingTables) {
          tables.add(table);
        }
        return result;
      } catch (error) {
        // ROLLBACK: discard all pending changes (they're just not applied)
        // Nothing needs to be undone since we only apply on commit
        throw error;
      } finally {
        inTransaction = false;
        txPendingInserts = [];
        txPendingDeletes = [];
        txPendingTables = [];
      }
    }),

    // Expose internal state for assertions
    _getRows: () => [...rows],
    _getTables: () => new Set(tables),
    _addTable: (name: string) => { tables.add(name); },
    _reset: () => {
      rows.length = 0;
      tables.clear();
      inTransaction = false;
      txPendingInserts = [];
      txPendingDeletes = [];
      txPendingTables = [];
    },
  };

  return mockDb;
}

// ─── Arbitraries (generators) ────────────────────────────────────────────────

/** Generate a valid migration version string (e.g., '001', '042', '999') */
const arbVersion = fc.integer({ min: 1, max: 999 }).map(n => String(n).padStart(3, '0'));

/** Generate a valid migration name (alphanumeric with underscores) */
const arbMigrationName = fc.stringMatching(/^[a-z][a-z0-9_]{2,30}$/);

/** Generate a migration type */
const arbMigrationType = fc.constantFrom('schema', 'seed') as fc.Arbitrary<'schema' | 'seed'>;

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 4: Migration Atomicity', () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For ANY migration that fails (throws an exception during execution),
   * the DB state must be unchanged:
   * - The migration is NOT recorded in schema_migrations
   * - The transaction is rolled back
   */

  let mockDb: ReturnType<typeof createInMemoryDb>;
  let runner: MigrationRunner;

  beforeEach(() => {
    mockDb = createInMemoryDb();
    runner = new MigrationRunner(mockDb);
  });

  it('for ANY migration that throws, no record is added to schema_migrations', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVersion,
        arbMigrationName,
        arbMigrationType,
        // Generate an arbitrary error message
        fc.string({ minLength: 1, maxLength: 100 }),
        async (version, name, type, errorMessage) => {
          mockDb._reset();
          await runner.initialize();

          // Take snapshot of state before attempting the migration
          const rowsBefore = mockDb._getRows();
          expect(rowsBefore).toHaveLength(0);

          // Create a migration that WILL FAIL
          const failingMigration: Migration = {
            version,
            name,
            type,
            up: async () => {
              throw new Error(errorMessage);
            },
          };

          // Attempt to run the failing migration
          await expect(runner.run([failingMigration])).rejects.toThrow();

          // PROPERTY: schema_migrations must be unchanged (no record added)
          const rowsAfter = mockDb._getRows();
          expect(rowsAfter).toHaveLength(0);

          // The failed migration must NOT appear in the records
          const hasVersion = rowsAfter.some(r => r.version === version);
          expect(hasVersion).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);

  it('for ANY batch where migration N fails, migrations N+1..end are never executed and prior state is preserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2-5 migrations, one of which will fail
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 0, max: 4 }).map(n => Math.min(n, 3)), // fail index (clamped)
        arbMigrationName,
        async (totalCount, failIndexRaw, baseName) => {
          mockDb._reset();
          await runner.initialize();

          const failIndex = Math.min(failIndexRaw, totalCount - 1);
          const executedVersions: string[] = [];

          const migrations: Migration[] = Array.from({ length: totalCount }, (_, i) => ({
            version: String(i + 1).padStart(3, '0'),
            name: `${baseName}_${i}`,
            type: 'schema' as const,
            up: async () => {
              if (i === failIndex) {
                throw new Error(`Migration ${i} failed`);
              }
              executedVersions.push(String(i + 1).padStart(3, '0'));
            },
          }));

          await expect(runner.run(migrations)).rejects.toThrow();

          // PROPERTY: Only migrations before failIndex should be recorded
          const rowsAfter = mockDb._getRows();
          expect(rowsAfter).toHaveLength(failIndex);

          // The failing migration itself must NOT be recorded
          const failVersion = String(failIndex + 1).padStart(3, '0');
          expect(rowsAfter.some(r => r.version === failVersion)).toBe(false);

          // Migrations after the failing one must NOT have been executed
          for (let i = failIndex + 1; i < totalCount; i++) {
            const v = String(i + 1).padStart(3, '0');
            expect(executedVersions).not.toContain(v);
            expect(rowsAfter.some(r => r.version === v)).toBe(false);
          }
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000);
});

describe('Property 5: Migration Audit Trail', () => {
  /**
   * **Validates: Requirements 3.4, 3.5**
   *
   * For ANY migration that succeeds, it MUST appear in schema_migrations
   * with version, name, type, and a valid timestamp (applied_at).
   */

  let mockDb: ReturnType<typeof createInMemoryDb>;
  let runner: MigrationRunner;

  beforeEach(() => {
    mockDb = createInMemoryDb();
    runner = new MigrationRunner(mockDb);
  });

  it('for ANY successful migration, a record with version, name, type, and valid timestamp is stored', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVersion,
        arbMigrationName,
        arbMigrationType,
        async (version, name, type) => {
          mockDb._reset();
          await runner.initialize();

          const migration: Migration = {
            version,
            name,
            type,
            up: async () => {
              // Successful migration (no-op)
            },
          };

          await runner.run([migration]);

          // PROPERTY: The migration must be recorded in schema_migrations
          const rows = mockDb._getRows();
          expect(rows).toHaveLength(1);

          const record = rows[0];
          // Must have correct version
          expect(record.version).toBe(version);
          // Must have correct name
          expect(record.name).toBe(name);
          // Must have correct type
          expect(record.type).toBe(type);
          // Must have a valid ISO timestamp
          expect(record.applied_at).toBeDefined();
          const parsedDate = new Date(record.applied_at);
          expect(parsedDate.getTime()).not.toBeNaN();
          // Timestamp should be recent (within last 10 seconds)
          expect(Date.now() - parsedDate.getTime()).toBeLessThan(10_000);
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);

  it('for ANY batch of successful migrations, ALL are recorded with correct metadata', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1-5 unique migrations
        fc.integer({ min: 1, max: 5 }),
        arbMigrationName,
        arbMigrationType,
        async (count, baseName, type) => {
          mockDb._reset();
          await runner.initialize();

          const migrations: Migration[] = Array.from({ length: count }, (_, i) => ({
            version: String(i + 1).padStart(3, '0'),
            name: `${baseName}_${i}`,
            type,
            up: async () => {},
          }));

          await runner.run(migrations);

          // PROPERTY: All migrations must be recorded
          const rows = mockDb._getRows();
          expect(rows).toHaveLength(count);

          // Each migration must have correct audit trail fields
          for (let i = 0; i < count; i++) {
            const expectedVersion = String(i + 1).padStart(3, '0');
            const record = rows.find(r => r.version === expectedVersion);
            expect(record).toBeDefined();
            expect(record!.name).toBe(`${baseName}_${i}`);
            expect(record!.type).toBe(type);
            expect(record!.applied_at).toBeDefined();
            expect(new Date(record!.applied_at).getTime()).not.toBeNaN();
          }
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000);
});

describe('Property 6: Migration Rollback Round-Trip', () => {
  /**
   * **Validates: Requirements 3.5, 3.2**
   *
   * For ANY migration that has a down() function, applying the migration
   * and then rolling it back must leave no trace in schema_migrations.
   * The round-trip (apply → rollback) restores the original state.
   */

  let mockDb: ReturnType<typeof createInMemoryDb>;
  let runner: MigrationRunner;

  beforeEach(() => {
    mockDb = createInMemoryDb();
    runner = new MigrationRunner(mockDb);
  });

  it('for ANY migration with down(), apply then rollback leaves no trace in schema_migrations', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbVersion,
        arbMigrationName,
        arbMigrationType,
        async (version, name, type) => {
          mockDb._reset();
          await runner.initialize();

          // Take snapshot before
          const rowsBefore = mockDb._getRows();
          expect(rowsBefore).toHaveLength(0);

          // Create a migration with both up() and down()
          const migration: Migration = {
            version,
            name,
            type,
            up: async () => {
              // Simulate creating a table
            },
            down: async () => {
              // Simulate dropping the table
            },
          };

          // Apply the migration
          await runner.run([migration]);

          // Verify it was recorded
          const rowsAfterApply = mockDb._getRows();
          expect(rowsAfterApply).toHaveLength(1);
          expect(rowsAfterApply[0].version).toBe(version);

          // Rollback the migration
          await runner.rollback(version, [migration]);

          // PROPERTY: After rollback, schema_migrations must be empty (original state)
          const rowsAfterRollback = mockDb._getRows();
          expect(rowsAfterRollback).toHaveLength(0);

          // The version must no longer appear
          expect(rowsAfterRollback.some(r => r.version === version)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);

  it('for ANY sequence of migrations with down(), apply all then rollback last restores N-1 state', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 2-4 migrations all with down()
        fc.integer({ min: 2, max: 4 }),
        arbMigrationName,
        async (count, baseName) => {
          mockDb._reset();
          await runner.initialize();

          const migrations: Migration[] = Array.from({ length: count }, (_, i) => ({
            version: String(i + 1).padStart(3, '0'),
            name: `${baseName}_${i}`,
            type: 'schema' as const,
            up: async () => {},
            down: async () => {},
          }));

          // Apply all migrations
          await runner.run(migrations);

          // Verify all are recorded
          const rowsAfterApply = mockDb._getRows();
          expect(rowsAfterApply).toHaveLength(count);

          // Rollback the last migration
          const lastVersion = String(count).padStart(3, '0');
          await runner.rollback(lastVersion, migrations);

          // PROPERTY: After rollback, only N-1 migrations remain
          const rowsAfterRollback = mockDb._getRows();
          expect(rowsAfterRollback).toHaveLength(count - 1);

          // The rolled-back version must not be present
          expect(rowsAfterRollback.some(r => r.version === lastVersion)).toBe(false);

          // All other versions must still be present
          for (let i = 0; i < count - 1; i++) {
            const v = String(i + 1).padStart(3, '0');
            expect(rowsAfterRollback.some(r => r.version === v)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000);
});

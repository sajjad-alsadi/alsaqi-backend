// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { MigrationRunner, Migration } from '../migrationRunner';

/**
 * Creates a PGlite-based DB wrapper that adapts to the DBWrapper interface
 * expected by MigrationRunner.
 */
function createPgliteDBWrapper(pglite: any) {
  return {
    prepare(sql: string) {
      // Convert ? placeholders to $1, $2, etc. (PostgreSQL style)
      let counter = 1;
      const pgSql = sql.replace(/\?/g, () => `$${counter++}`);

      return {
        async get(...params: any[]): Promise<any> {
          const res = await pglite.query(pgSql, params);
          return res.rows ? res.rows[0] : undefined;
        },
        async all(...params: any[]): Promise<any[]> {
          const res = await pglite.query(pgSql, params);
          return res.rows || [];
        },
        async run(...params: any[]): Promise<{ lastInsertRowid: number; changes: number }> {
          let finalSql = pgSql;
          if (finalSql.trim().toUpperCase().startsWith('INSERT')) {
            if (!finalSql.toUpperCase().includes('RETURNING')) {
              finalSql += ' RETURNING *';
            }
            const res = await pglite.query(finalSql, params);
            return {
              lastInsertRowid: (res.rows && res.rows[0] as any)?.id || 0,
              changes: res.rowCount || 0,
            };
          } else {
            const res = await pglite.query(finalSql, params);
            return { lastInsertRowid: 0, changes: res.rowCount || 0 };
          }
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await pglite.query(sql);
    },
    async transaction(fn: Function) {
      await pglite.query('BEGIN');
      try {
        const result = await fn();
        await pglite.query('COMMIT');
        return result;
      } catch (e) {
        await pglite.query('ROLLBACK');
        throw e;
      }
    },
  };
}

/**
 * Property Test: Migration versioning idempotence (Property 6)
 *
 * **Validates: Requirements 5.2, 5.3**
 *
 * For any set of migrations that have been previously applied, running the
 * migration system again must execute zero migrations and leave the
 * schema_migrations table unchanged.
 */
describe('Property 6: Migration versioning idempotence', () => {
  let pglite: any;
  let dbWrapper: ReturnType<typeof createPgliteDBWrapper>;

  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    dbWrapper = createPgliteDBWrapper(pglite);
  });

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
    }
  });

  it('re-running previously applied migrations executes zero migrations and leaves schema_migrations unchanged', async () => {
    // Arbitrary for generating a set of unique migrations
    const migrationsArb = fc
      .uniqueArray(
        fc.record({
          version: fc.stringMatching(/^[0-9]{3}$/),
          name: fc.stringMatching(/^[a-z_]{3,20}$/),
          type: fc.constantFrom('schema' as const, 'seed' as const),
        }),
        { minLength: 1, maxLength: 10, selector: (m) => m.version }
      )
      .filter((arr) => arr.length >= 1);

    await fc.assert(
      fc.asyncProperty(migrationsArb, async (migrationDefs) => {
        // Reset the database for each iteration
        await pglite.query('DROP TABLE IF EXISTS schema_migrations');

        // Track execution counts
        const executionCounts: Record<string, number> = {};

        // Build Migration objects with tracked up() functions
        const migrations: Migration[] = migrationDefs.map((def) => {
          executionCounts[def.version] = 0;
          return {
            version: def.version,
            name: def.name,
            type: def.type,
            up: async () => {
              executionCounts[def.version]++;
            },
          };
        });

        // First run: apply all migrations
        const runner = new MigrationRunner(dbWrapper as any);
        await runner.initialize();
        await runner.run(migrations);

        // Snapshot schema_migrations table after first run
        const recordsAfterFirstRun = await pglite.query(
          'SELECT version, name, type, applied_at FROM schema_migrations ORDER BY version ASC'
        );
        const snapshotAfterFirstRun = recordsAfterFirstRun.rows;

        // Verify all migrations were applied in the first run
        expect(snapshotAfterFirstRun.length).toBe(migrations.length);

        // Reset execution counts for the second run
        for (const key of Object.keys(executionCounts)) {
          executionCounts[key] = 0;
        }

        // Second run: run the same migrations again
        await runner.run(migrations);

        // Verify zero migrations were executed on the second run
        for (const [version, count] of Object.entries(executionCounts)) {
          expect(count).toBe(0);
        }

        // Verify schema_migrations table is unchanged
        const recordsAfterSecondRun = await pglite.query(
          'SELECT version, name, type, applied_at FROM schema_migrations ORDER BY version ASC'
        );
        const snapshotAfterSecondRun = recordsAfterSecondRun.rows;

        expect(snapshotAfterSecondRun.length).toBe(snapshotAfterFirstRun.length);
        expect(snapshotAfterSecondRun).toEqual(snapshotAfterFirstRun);
      }),
      { numRuns: 100 }
    );
  }, 120000); // 2 minute timeout for 100 iterations with PGlite
});


/**
 * Property Test: Successful migration recording (Property 7)
 *
 * **Validates: Requirements 5.4**
 *
 * For any migration that completes without error, the schema_migrations table
 * must contain a record with that migration's version and a valid timestamp.
 */
describe('Property 7: Successful migration recording', () => {
  let pglite: any;
  let dbWrapper: ReturnType<typeof createPgliteDBWrapper>;

  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    dbWrapper = createPgliteDBWrapper(pglite);
  });

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
    }
  });

  it('every successfully completed migration has a record in schema_migrations with a valid timestamp', async () => {
    const migrationsArb = fc
      .uniqueArray(
        fc.record({
          version: fc.stringMatching(/^[0-9]{3}$/),
          name: fc.stringMatching(/^[a-z_]{3,20}$/),
          type: fc.constantFrom('schema' as const, 'seed' as const),
        }),
        { minLength: 1, maxLength: 10, selector: (m) => m.version }
      )
      .filter((arr) => arr.length >= 1);

    await fc.assert(
      fc.asyncProperty(migrationsArb, async (migrationDefs) => {
        // Reset the database for each iteration
        await pglite.query('DROP TABLE IF EXISTS schema_migrations');

        // Build Migration objects that all succeed (resolve without error)
        const migrations: Migration[] = migrationDefs.map((def) => ({
          version: def.version,
          name: def.name,
          type: def.type,
          up: async () => {
            // Successful migration - does nothing but resolves
          },
        }));

        // Run the migration system
        const runner = new MigrationRunner(dbWrapper as any);
        await runner.initialize();
        await runner.run(migrations);

        // Verify each migration has a corresponding record in schema_migrations
        const records = await pglite.query(
          'SELECT version, name, type, applied_at FROM schema_migrations ORDER BY version ASC'
        );
        const rows = records.rows as Array<{
          version: string;
          name: string;
          type: string;
          applied_at: string | Date | null;
        }>;

        // There should be exactly as many records as migrations
        expect(rows.length).toBe(migrations.length);

        // Build a map of recorded versions for easy lookup
        const recordMap = new Map(rows.map((r) => [r.version, r]));

        for (const migration of migrations) {
          // Each migration must have a corresponding record
          const record = recordMap.get(migration.version);
          expect(record).toBeDefined();

          // The record must have the correct name and type
          expect(record!.name).toBe(migration.name);
          expect(record!.type).toBe(migration.type);

          // applied_at must not be null and must be a valid date
          expect(record!.applied_at).not.toBeNull();
          const appliedAt = new Date(record!.applied_at as string | Date);
          expect(appliedAt.getTime()).not.toBeNaN();
          // Timestamp should be recent (within the last 60 seconds)
          const now = Date.now();
          const sixtySecondsAgo = now - 60_000;
          expect(appliedAt.getTime()).toBeGreaterThanOrEqual(sixtySecondsAgo);
          expect(appliedAt.getTime()).toBeLessThanOrEqual(now);
        }
      }),
      { numRuns: 100 }
    );
  }, 120000); // 2 minute timeout for 100 iterations with PGlite
});


/**
 * Property Test: Failed migration halts execution (Property 8)
 *
 * **Validates: Requirements 5.5**
 *
 * For any migration that throws an error during execution, the schema_migrations
 * table must not contain that version, and no subsequent migrations in the pending
 * list must be executed.
 */
describe('Property 8: Failed migration halts execution', () => {
  let pglite: any;
  let dbWrapper: ReturnType<typeof createPgliteDBWrapper>;

  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    dbWrapper = createPgliteDBWrapper(pglite);
  });

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
    }
  });

  it('a failing migration is not recorded, no subsequent migrations execute, and prior migrations are recorded', async () => {
    // Generate a list of 2-10 unique migrations and pick a random index for the failing one
    const testCaseArb = fc
      .uniqueArray(
        fc.record({
          version: fc.stringMatching(/^[0-9]{3}$/),
          name: fc.stringMatching(/^[a-z_]{3,20}$/),
          type: fc.constantFrom('schema' as const, 'seed' as const),
        }),
        { minLength: 2, maxLength: 10, selector: (m) => m.version }
      )
      .filter((arr) => arr.length >= 2)
      .chain((migrationDefs) =>
        fc.record({
          migrations: fc.constant(migrationDefs),
          failIndex: fc.integer({ min: 0, max: migrationDefs.length - 1 }),
        })
      );

    await fc.assert(
      fc.asyncProperty(testCaseArb, async ({ migrations: migrationDefs, failIndex }) => {
        // Reset the database for each iteration
        await pglite.query('DROP TABLE IF EXISTS schema_migrations');

        // Sort migration defs by version to know the execution order
        const sortedDefs = [...migrationDefs].sort((a, b) =>
          a.version.localeCompare(b.version)
        );

        // Track which migrations were executed
        const executed: string[] = [];

        // Build Migration objects; the one at failIndex (in sorted order) throws
        const failingVersion = sortedDefs[failIndex].version;
        const migrations: Migration[] = sortedDefs.map((def) => ({
          version: def.version,
          name: def.name,
          type: def.type,
          up: async () => {
            if (def.version === failingVersion) {
              throw new Error(`Migration ${def.version} intentionally failed`);
            }
            executed.push(def.version);
          },
        }));

        // Run the migration system - it should throw
        const runner = new MigrationRunner(dbWrapper as any);
        await runner.initialize();

        await expect(runner.run(migrations)).rejects.toThrow();

        // Query schema_migrations to see what was recorded
        const records = await pglite.query(
          'SELECT version FROM schema_migrations ORDER BY version ASC'
        );
        const recordedVersions = new Set(
          (records.rows as Array<{ version: string }>).map((r) => r.version)
        );

        // 1. The failing migration's version must NOT be in schema_migrations
        expect(recordedVersions.has(failingVersion)).toBe(false);

        // 2. No migrations AFTER the failing one (in sorted order) should have executed
        const afterFailingVersions = sortedDefs
          .slice(failIndex + 1)
          .map((d) => d.version);
        for (const version of afterFailingVersions) {
          expect(executed).not.toContain(version);
          expect(recordedVersions.has(version)).toBe(false);
        }

        // 3. All migrations BEFORE the failing one (in sorted order) should be recorded
        const beforeFailingVersions = sortedDefs
          .slice(0, failIndex)
          .map((d) => d.version);
        for (const version of beforeFailingVersions) {
          expect(executed).toContain(version);
          expect(recordedVersions.has(version)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  }, 120000); // 2 minute timeout for 100 iterations with PGlite
});


/**
 * Property Test: Migration sequential ordering (Property 9)
 *
 * **Validates: Requirements 5.6**
 *
 * For any set of pending migrations presented in arbitrary order, the migration
 * runner must execute them in strictly ascending version order.
 */
describe('Property 9: Migration sequential ordering', () => {
  let pglite: any;
  let dbWrapper: ReturnType<typeof createPgliteDBWrapper>;

  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    dbWrapper = createPgliteDBWrapper(pglite);
  });

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
    }
  });

  it('migrations presented in random order are executed in strictly ascending version order', async () => {
    // Generate 2-10 migrations with unique version strings, then shuffle them
    const migrationsArb = fc
      .uniqueArray(
        fc.record({
          version: fc.stringMatching(/^[0-9]{3}$/),
          name: fc.stringMatching(/^[a-z_]{3,20}$/),
          type: fc.constantFrom('schema' as const, 'seed' as const),
        }),
        { minLength: 2, maxLength: 10, selector: (m) => m.version }
      )
      .filter((arr) => arr.length >= 2)
      .chain((migrationDefs) =>
        // Shuffle the array to present migrations in random order
        fc.shuffledSubarray(migrationDefs, {
          minLength: migrationDefs.length,
          maxLength: migrationDefs.length,
        })
      );

    await fc.assert(
      fc.asyncProperty(migrationsArb, async (shuffledDefs) => {
        // Reset the database for each iteration
        await pglite.query('DROP TABLE IF EXISTS schema_migrations');

        // Track the execution order
        const executionOrder: string[] = [];

        // Build Migration objects in the SHUFFLED order (not sorted)
        const migrations: Migration[] = shuffledDefs.map((def) => ({
          version: def.version,
          name: def.name,
          type: def.type,
          up: async () => {
            executionOrder.push(def.version);
          },
        }));

        // Run the migration system with migrations in random order
        const runner = new MigrationRunner(dbWrapper as any);
        await runner.initialize();
        await runner.run(migrations);

        // All migrations should have been executed
        expect(executionOrder.length).toBe(shuffledDefs.length);

        // Verify execution order is strictly ascending by version string
        for (let i = 1; i < executionOrder.length; i++) {
          expect(
            executionOrder[i - 1].localeCompare(executionOrder[i])
          ).toBeLessThan(0);
        }

        // Additionally verify the execution order matches the sorted version order
        const expectedOrder = [...shuffledDefs.map((d) => d.version)].sort(
          (a, b) => a.localeCompare(b)
        );
        expect(executionOrder).toEqual(expectedOrder);
      }),
      { numRuns: 100 }
    );
  }, 120000); // 2 minute timeout for 100 iterations with PGlite
});

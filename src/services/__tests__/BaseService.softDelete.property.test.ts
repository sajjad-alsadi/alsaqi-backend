// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// Feature: backend-security-hardening, Property 33: Soft-delete invariant
//
// **Validates: Requirements 25.1, 25.2, 25.3**
//
// For any row in a table that has a `deleted_at` column, the default delete path
// sets `deleted_at` to a timestamp via UPDATE (never a hard DELETE), so the row
// remains physically present and retrievable through an explicit include-deleted
// query, while default `findAll`/`findById` queries exclude every row whose
// `deleted_at` is non-null.
//
// Strategy:
//  - Use the embedded PGlite engine the repo uses for DB-backed tests, injected
//    into the canonical `db` wrapper via `updateClient(pglite, false)`. Because
//    `BaseService.db` is the same singleton wrapper, the real BaseService code
//    paths (delete / findAll / findById) run against the in-memory engine.
//  - For each iteration, pick a table from the production SOFT_DELETE_TABLES set,
//    create it fresh with an `id` and a `deleted_at` column, insert rows, then
//    soft-delete a generated subset through the default `BaseService.delete`.
//  - Assert the soft-delete invariant: deleted rows stay physically present with
//    a non-null `deleted_at`, default reads exclude them, and includeDeleted
//    reads retrieve them.

import { db } from '../../db/index';
import { BaseService } from '../BaseService';
import { NotFoundError } from '../../utils/errors';
import { clearCountCache } from '../countCache';

let pglite: any;

const SOFT_DELETE_TABLES = Array.from(BaseService.SOFT_DELETE_TABLES);

async function createTable(tableName: string): Promise<void> {
  // A minimal soft-delete-capable table carrying exactly the columns the default
  // BaseService delete/read paths touch: an integer `id` primary key, an
  // arbitrary data column, the nullable `deleted_at` timestamp, and a
  // `created_at` column. The latter is required because keyset-paginated tables
  // order their default reads by `created_at`, so the column must exist for the
  // findAll path to run against every table in SOFT_DELETE_TABLES.
  await pglite.query(`DROP TABLE IF EXISTS ${tableName}`);
  await pglite.query(`
    CREATE TABLE ${tableName} (
      id SERIAL PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      deleted_at TIMESTAMPTZ
    )
  `);
}

async function insertRow(tableName: string, name: string): Promise<number> {
  const res = await pglite.query(
    `INSERT INTO ${tableName} (name) VALUES ($1) RETURNING id`,
    [name]
  );
  return (res.rows[0] as { id: number }).id;
}

describe('Property 33: Soft-delete invariant', () => {
  beforeEach(async () => {
    clearCountCache();
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    // Point the canonical db wrapper (and therefore BaseService.db) at this
    // in-memory engine in non-external mode.
    (db as unknown as { updateClient(client: unknown, isExternal: boolean): void }).updateClient(
      pglite,
      false
    );
  });

  afterEach(async () => {
    if (pglite) {
      await pglite.close();
      pglite = null;
    }
  });

  const rowArb = fc.record({
    name: fc.string({ minLength: 0, maxLength: 30 }),
    del: fc.boolean(),
  });

  it('default delete soft-deletes (row stays present); default reads exclude, includeDeleted retrieves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SOFT_DELETE_TABLES),
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        async (tableName, rows) => {
          await createTable(tableName);

          // The table is dropped and recreated fresh every iteration, but the
          // total-count cache (Req 6.5, 60s TTL) is keyed by table name and
          // persists across iterations of this single property. Without an
          // explicit reset, a `pagination.total` computed for an earlier
          // iteration's data would leak into a later iteration that reuses the
          // same table name, so clear it for each fresh table.
          clearCountCache();

          // Insert all rows and remember which we intend to soft-delete.
          const ids: number[] = [];
          for (const row of rows) {
            ids.push(await insertRow(tableName, row.name));
          }
          const deletedIds = ids.filter((_, i) => rows[i].del);
          const survivingIds = ids.filter((_, i) => !rows[i].del);

          // Exercise the default delete path for the chosen subset.
          for (const id of deletedIds) {
            await expect(BaseService.delete(tableName, id)).resolves.toBe(true);
          }

          // Req 25.1 / 25.2: no row was physically removed by the default path.
          const physical = (await pglite.query(
            `SELECT id, deleted_at FROM ${tableName}`
          )).rows as Array<{ id: number; deleted_at: string | null }>;
          expect(physical.length).toBe(ids.length);

          const byId = new Map(physical.map((r) => [r.id, r.deleted_at]));
          // Deleted rows have a non-null deleted_at; survivors remain null.
          for (const id of deletedIds) {
            expect(byId.get(id)).not.toBeNull();
          }
          for (const id of survivingIds) {
            expect(byId.get(id)).toBeNull();
          }

          // Req 25.3: default findAll excludes soft-deleted rows.
          const defaultList = await BaseService.findAll(tableName, { pageSize: 100 });
          const defaultIds = (defaultList.data as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b);
          expect(defaultIds).toEqual([...survivingIds].sort((a, b) => a - b));
          expect(defaultList.pagination.total).toBe(survivingIds.length);

          // Req 25.2: includeDeleted findAll retrieves every row.
          const allList = await BaseService.findAll(tableName, { pageSize: 100, includeDeleted: true });
          const allIds = (allList.data as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b);
          expect(allIds).toEqual([...ids].sort((a, b) => a - b));

          // Req 25.3: default findById excludes soft-deleted rows; survivors found.
          for (const id of deletedIds) {
            await expect(BaseService.findById(tableName, id)).rejects.toBeInstanceOf(NotFoundError);
            // Req 25.2: includeDeleted retrieves the soft-deleted row.
            const recovered = await BaseService.findById(tableName, id, { includeDeleted: true });
            expect((recovered as { id: number }).id).toBe(id);
          }
          for (const id of survivingIds) {
            const found = await BaseService.findById(tableName, id);
            expect((found as { id: number }).id).toBe(id);
          }
        }
      ),
      { numRuns: 100 }
    );
  }, 120000);
});

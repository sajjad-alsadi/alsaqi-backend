// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { db } from '../index';
import { runMigrations } from '../migrations';

/**
 * Regression test for the duplicate compliance_status CHECK constraint error.
 *
 * Bug: On every startup after the first, `runMigrations` re-ran
 *   `ALTER TABLE compliance_items ADD CONSTRAINT compliance_items_compliance_status_check ...`
 * Postgres/PGlite has no `ADD CONSTRAINT IF NOT EXISTS`, so the second run threw
 * `42710 (constraint already exists)`. The migration swallowed the exception, but
 * the DB wrapper's run() had already logged a noisy `[DB ERROR]` + stack trace.
 *
 * Fix: the migration now checks pg_constraint before adding, so re-runs are
 * genuinely idempotent and never trigger the error path.
 *
 * Strategy: point the canonical db wrapper at a fresh in-memory PGlite engine
 * (the same engine the repo uses for DB-backed tests) and run the real
 * `runMigrations` twice. The second run reproduces the "schema already exists"
 * condition that originally produced the error.
 */
describe('compliance_items compliance_status constraint idempotency', () => {
  let pglite: any;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    (db as unknown as { updateClient(client: unknown, isExternal: boolean): void }).updateClient(
      pglite,
      false
    );
  });

  afterAll(async () => {
    if (pglite) {
      await pglite.close?.();
      pglite = null;
    }
  });

  it('does not emit a duplicate-constraint [DB ERROR] on a second migration run', async () => {
    // First run establishes the schema and the constraint.
    await runMigrations();

    // Capture console.error during the second (idempotent) run.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runMigrations();
    } finally {
      errorSpy.mockRestore();
    }

    // PROPERTY: the second run must NOT log the duplicate-constraint error.
    const offendingCalls = errorSpy.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('compliance_items_compliance_status_check')
      )
    );
    expect(offendingCalls).toEqual([]);
  }, 120_000);

  it('results in exactly one compliance_status check constraint', async () => {
    const res = await pglite.query(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'compliance_items_compliance_status_check'"
    );
    expect((res.rows[0] as { n: number }).n).toBe(1);
  });
});

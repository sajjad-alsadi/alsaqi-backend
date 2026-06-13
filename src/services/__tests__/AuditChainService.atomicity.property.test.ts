// @vitest-environment node
// Feature: backend-security-hardening, Property 14: Append atomicity
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 14: Append atomicity
 *
 * **Validates: Requirements 7.5**
 *
 * For any audit entry whose insertion fails at any point after the previous-hash
 * is read and before durable insertion, the chain remains in its pre-append
 * state with no partial entry persisted and the caller receives a failure
 * indication.
 *
 * Strategy:
 * - Run AuditChainService.append against the repo's embedded DB (PGlite) so the
 *   transaction / rollback machinery is exercised for real (not mocked).
 * - Seed a baseline chain by appending an arbitrary prefix of entries.
 * - Snapshot the full audit_trail contents and the verifyChain() outcome.
 * - Inject a failure into the next append at one of two points:
 *     'before-insert'        -> throw before the INSERT statement executes
 *     'after-insert-precommit' -> let the INSERT execute inside the open
 *                                 transaction, then throw before COMMIT
 *   Both points are "after the previous-hash is read and before durable
 *   insertion" per the property.
 * - Assert the append rejects, and that the chain is byte-for-byte unchanged
 *   (same rows, same verification outcome) — i.e. no partial entry survived.
 *
 * The DB-backed `db` export is swapped via a hoisted holder so the single
 * canonical service-under-test runs unmodified against a live PGlite engine.
 */

const hoisted = vi.hoisted(() => {
  // Mutable backend the mocked `db` delegates to; set per test in beforeEach.
  const state: { backend: any } = { backend: null };
  const db = {
    get isExternal() {
      return state.backend?.isExternal ?? false;
    },
    prepare(sql: string) {
      return state.backend.prepare(sql);
    },
    exec(sql: string) {
      return state.backend.exec(sql);
    },
    transaction(fn: () => Promise<unknown>) {
      return state.backend.transaction(fn);
    },
  };
  return { state, db };
});

vi.mock('../../db/index', () => ({ db: hoisted.db }));

import { AuditChainService } from '../AuditChainService';

type FailMode = 'before-insert' | 'after-insert-precommit';

/**
 * A real PGlite-backed DB wrapper matching the slice of the DBWrapper contract
 * used by AuditChainService, with a controllable INSERT-failure injection.
 */
function createPgliteBackend(pglite: any) {
  const injection: { mode: FailMode | null } = { mode: null };

  const toPgPlaceholders = (sql: string): string => {
    let counter = 1;
    return sql.replace(/\?/g, () => `$${counter++}`);
  };

  const backend = {
    isExternal: false,
    injection,
    prepare(sql: string) {
      const pgSql = toPgPlaceholders(sql);
      const isAuditInsert =
        /^\s*INSERT\s+INTO\s+audit_trail\b/i.test(pgSql);

      return {
        async get(...params: unknown[]): Promise<unknown> {
          const res = await pglite.query(pgSql, params);
          return res.rows ? res.rows[0] : undefined;
        },
        async all(...params: unknown[]): Promise<unknown[]> {
          const res = await pglite.query(pgSql, params);
          return res.rows || [];
        },
        async run(
          ...params: unknown[]
        ): Promise<{ lastInsertRowid: number; changes: number }> {
          // Simulate a failure occurring before the INSERT is issued at all.
          if (isAuditInsert && injection.mode === 'before-insert') {
            throw new Error('injected failure: before INSERT execution');
          }

          let finalSql = pgSql;
          if (/^\s*INSERT/i.test(finalSql) && !/RETURNING/i.test(finalSql)) {
            finalSql += ' RETURNING *';
          }
          const res = await pglite.query(finalSql, params);

          // Simulate a failure after the row is written inside the open
          // transaction but before it is durably committed. A correct
          // implementation must roll the row back.
          if (isAuditInsert && injection.mode === 'after-insert-precommit') {
            throw new Error('injected failure: after INSERT, before COMMIT');
          }

          return {
            lastInsertRowid: (res.rows && (res.rows[0] as any))?.id || 0,
            changes: res.rowCount || 0,
          };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await pglite.query(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
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

  return backend;
}

async function snapshotChain(pglite: any): Promise<string> {
  const res = await pglite.query(
    'SELECT "user", action, module, details, hash, previous_hash, timestamp ' +
      'FROM audit_trail ORDER BY timestamp ASC, id ASC'
  );
  return JSON.stringify(res.rows || []);
}

describe('Property 14: Append atomicity', () => {
  let pglite: any;
  let backend: ReturnType<typeof createPgliteBackend>;

  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;

    // Recreate the audit_trail table (mirrors src/db/migrations.ts shape plus
    // the hash-chain columns added by later migrations).
    await pglite.query(`
      CREATE TABLE IF NOT EXISTS audit_trail (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user" TEXT NOT NULL,
        action TEXT NOT NULL,
        module TEXT NOT NULL,
        details TEXT,
        hash TEXT,
        previous_hash TEXT,
        seq BIGSERIAL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    backend = createPgliteBackend(pglite);
    hoisted.state.backend = backend;
  });

  afterEach(async () => {
    hoisted.state.backend = null;
    if (pglite) {
      await pglite.close?.();
      pglite = null;
    }
  });

  // Generators for audit entry content.
  const entryArb = fc.record({
    user: fc.string({ minLength: 1, maxLength: 40 }),
    action: fc.string({ minLength: 1, maxLength: 40 }),
    module: fc.string({ minLength: 1, maxLength: 40 }),
    details: fc.string({ maxLength: 120 }),
  });

  it('a failed append persists no partial entry and leaves the chain unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 0, maxLength: 4 }), // baseline chain
        entryArb, // the entry whose append will fail
        fc.constantFrom<FailMode>('before-insert', 'after-insert-precommit'),
        async (baseline, failing, failMode) => {
          // Fresh table for every run.
          backend.injection.mode = null;
          await pglite.query('DELETE FROM audit_trail');

          // Seed a valid baseline chain via the service itself. Distinct
          // timestamps keep the baseline ordering deterministic.
          for (const entry of baseline) {
            await AuditChainService.append(entry);
            await new Promise((r) => setTimeout(r, 2));
          }

          const rowsBefore = await snapshotChain(pglite);
          const verifyBefore = await AuditChainService.verifyChain();
          const countBefore = (
            (await pglite.query('SELECT COUNT(*)::int AS n FROM audit_trail'))
              .rows[0] as any
          ).n;

          // Arm the injected failure and attempt the append.
          backend.injection.mode = failMode;
          await expect(AuditChainService.append(failing)).rejects.toThrow();
          backend.injection.mode = null;

          // The chain must be byte-for-byte identical to its pre-append state.
          const rowsAfter = await snapshotChain(pglite);
          const countAfter = (
            (await pglite.query('SELECT COUNT(*)::int AS n FROM audit_trail'))
              .rows[0] as any
          ).n;
          const verifyAfter = await AuditChainService.verifyChain();

          expect(countAfter).toBe(countBefore);
          expect(rowsAfter).toBe(rowsBefore);
          expect(verifyAfter).toEqual(verifyBefore);
        }
      ),
      { numRuns: 100 }
    );
  });
});

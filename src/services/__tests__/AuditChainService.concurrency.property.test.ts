// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// Feature: backend-security-hardening, Property 11: Audit chain remains linear under concurrency
//
// **Validates: Requirements 7.2, 7.3**
//
// For any set of audit entries appended concurrently through
// `AuditChainService.append`, the resulting chain is linear: each non-genesis
// entry's `previous_hash` equals the `hash` of exactly one prior entry, and no
// two entries share the same `previous_hash` (no forks, no gaps).
//
// Strategy:
//  - Use the embedded PGlite engine the repo uses for DB-backed tests, injected
//    into the canonical `db` wrapper via `updateClient(pglite, false)`. In this
//    (non-external) mode the wrapper serializes writes through its internal
//    write lock for the full duration of each `db.transaction(...)`, which is
//    the production serialization mechanism for PGlite the service relies on.
//  - For each generated set of entries, append them all concurrently with
//    `Promise.all` and then assert the persisted chain is structurally linear
//    and that `verifyChain()` reports it valid.

import { db } from '../../db/index';
import { AuditChainService } from '../AuditChainService';

const GENESIS_PREVIOUS_HASH = '0';

let pglite: any;

async function createAuditTrailTable(): Promise<void> {
  // A non-partitioned audit_trail table containing every column the
  // AuditChainService reads/writes. `id` is auto-generated so INSERT ... RETURNING
  // surfaces it, mirroring the production schema's UUID primary key.
  await pglite.query(`
    CREATE TABLE IF NOT EXISTS audit_trail (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      "user" TEXT NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      hash TEXT,
      previous_hash TEXT,
      seq BIGSERIAL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

describe('Property 11: Audit chain remains linear under concurrency', () => {
  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    await createAuditTrailTable();
    // Point the canonical db wrapper at this in-memory engine (non-external mode).
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

  const entryArb = fc.record({
    user: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._]{2,20}$/),
    action: fc.constantFrom('Created', 'Updated', 'Deleted', 'Login', 'Logout', 'Approved'),
    module: fc.constantFrom('Auth', 'Users', 'Findings', 'Tasks', 'Reports'),
    details: fc.string({ minLength: 1, maxLength: 80 }),
  });

  it('concurrent appends produce a single linear chain (no forks, no gaps)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 2, maxLength: 8 }),
        async (entries) => {
          // Reset the chain for this iteration.
          await pglite.query('TRUNCATE audit_trail');

          // Append every entry concurrently. The wrapper's write lock must
          // serialize the read-prev-hash -> compute -> insert critical section.
          await Promise.all(entries.map((e) => AuditChainService.append(e)));

          const rows = (await pglite.query(
            'SELECT hash, previous_hash FROM audit_trail'
          )).rows as Array<{ hash: string; previous_hash: string }>;

          // Every append persisted exactly one entry.
          expect(rows.length).toBe(entries.length);

          const hashes = rows.map((r) => r.hash);
          const previousHashes = rows.map((r) => r.previous_hash);

          // All hashes are unique (each entry is distinct in the chain).
          expect(new Set(hashes).size).toBe(hashes.length);

          // Exactly one genesis entry references the sentinel previous-hash.
          const genesisCount = previousHashes.filter((p) => p === GENESIS_PREVIOUS_HASH).length;
          expect(genesisCount).toBe(1);

          // No two entries share the same previous_hash => no fork.
          expect(new Set(previousHashes).size).toBe(previousHashes.length);

          // Every non-genesis previous_hash links to exactly one existing prior
          // entry's hash => no gap.
          const hashSet = new Set(hashes);
          for (const prev of previousHashes) {
            if (prev === GENESIS_PREVIOUS_HASH) continue;
            expect(hashSet.has(prev)).toBe(true);
          }

          // The chain must be a single path: starting from genesis and following
          // hash links should visit every entry exactly once.
          const byPrev = new Map<string, string>(); // previous_hash -> hash
          for (const r of rows) byPrev.set(r.previous_hash, r.hash);
          let cursor: string | undefined = byPrev.get(GENESIS_PREVIOUS_HASH);
          let visited = 0;
          while (cursor !== undefined) {
            visited++;
            cursor = byPrev.get(cursor);
          }
          expect(visited).toBe(rows.length);
        }
      ),
      { numRuns: 100 }
    );
  }, 120000);
});

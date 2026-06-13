// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// Feature: backend-security-hardening, Property 12: Append-then-verify round trip
//
// **Validates: Requirements 7.4**
//
// For any sequence of audit entries appended in order, `verifyChain` recomputes
// each entry's hash from its recorded content and recorded previous-hash, finds
// every recomputed hash equal to the stored hash with single-predecessor
// linkage, and reports the chain valid.
//
// Strategy:
//  - Use the embedded PGlite engine the repo uses for DB-backed tests, injected
//    into the canonical `db` wrapper via `updateClient(pglite, false)`. In this
//    (non-external) mode the wrapper serializes writes through its internal
//    write lock for the full duration of each `db.transaction(...)`, mirroring
//    the production serialization mechanism for PGlite.
//  - For each generated sequence, append the entries in order (awaiting each),
//    then assert `verifyChain()` reports the chain valid and that exactly one
//    entry was persisted per append.

import { db } from '../../db/index';
import { AuditChainService } from '../AuditChainService';

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

describe('Property 12: Append-then-verify round trip', () => {
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
    details: fc.string({ minLength: 0, maxLength: 80 }),
  });

  it('verifyChain reports valid for any in-order sequence of appended entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 0, maxLength: 10 }),
        async (entries) => {
          // Reset the chain for this iteration.
          await pglite.query('TRUNCATE audit_trail');

          // Append every entry in order, awaiting each so the sequence is
          // committed one entry at a time (the "appended in order" precondition).
          for (const entry of entries) {
            await AuditChainService.append(entry);
          }

          // Each append persisted exactly one entry.
          const countRow = (await pglite.query('SELECT COUNT(*)::int AS n FROM audit_trail'))
            .rows[0] as { n: number };
          expect(countRow.n).toBe(entries.length);

          // End-to-end verification recomputes every hash and confirms
          // single-predecessor linkage, reporting the chain valid.
          const result = await AuditChainService.verifyChain();
          expect(result).toEqual({ valid: true });
        }
      ),
      { numRuns: 100 }
    );
  }, 120000);
});

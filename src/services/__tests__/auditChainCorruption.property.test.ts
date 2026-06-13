// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { PGlite } from '@electric-sql/pglite';

import { db } from '../../db/index';
import { AuditChainService } from '../AuditChainService';

/**
 * Feature: backend-security-hardening, Property 13: Corruption detection identifies the first offender
 *
 * **Validates: Requirements 7.6**
 *
 * For any valid, appended audit chain, if exactly one entry is corrupted (its
 * recorded content is altered after the fact), end-to-end verification SHALL
 * report a verification failure that identifies the first offending entry in
 * chain order, without altering any chain entry.
 *
 * Because a single content mutation changes only that entry's recomputed hash,
 * the corrupted entry is the unique (and therefore first) hash mismatch in
 * chain order. `verifyChain` orders entries by `(timestamp ASC, id ASC)`, the
 * same deterministic ordering used here to select the corruption target, so the
 * reported `firstOffendingId` must equal the id of the entry we corrupted.
 *
 * Test setup uses the repository's embedded PGlite database (the same engine the
 * `db` wrapper uses outside of production) so that the real `AuditChainService`
 * append/verify code paths — including the transactional hash-chain writer — are
 * exercised end to end rather than mocked.
 */

// Restricted, Postgres-TEXT-safe alphabet (no NUL/lone-surrogate hazards).
const SAFE_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_'.split('');
const safeChar = fc.constantFrom(...SAFE_CHARS);

/** Non-empty safe string (for NOT NULL columns: user/action/module). */
const nonEmptySafeString = fc
  .array(safeChar, { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''));

/** Possibly-empty safe string (details column is nullable/empty-allowed). */
const safeString = fc
  .array(safeChar, { minLength: 0, maxLength: 60 })
  .map((chars) => chars.join(''));

const auditEntryArb = fc.record({
  user: nonEmptySafeString,
  action: nonEmptySafeString,
  module: nonEmptySafeString,
  details: safeString,
});

describe('Property 13: Corruption detection identifies the first offender', () => {
  beforeAll(async () => {
    // Point the shared db wrapper at a fresh, in-memory PGlite instance for
    // this test. This uses the repository's embedded DB engine (the same engine
    // used outside production) while giving the test an isolated database that
    // omits the production immutability trigger on `audit_trail`, so a single
    // entry can be corrupted to exercise verifyChain's tamper detection.
    const mem = new PGlite();
    await mem.waitReady;
    db.updateClient(mem, false);

    // Minimal, non-partitioned audit_trail table carrying the columns the
    // AuditChainService writes (id, user, action, module, details, hash,
    // previous_hash, timestamp). Mirrors production column semantics.
    await db.exec(`
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
  });

  beforeEach(async () => {
    // Each property run builds its own fresh chain.
    await db.exec('DELETE FROM audit_trail');
  });

  it('reports the corrupted entry as the first offender with a hash mismatch', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(auditEntryArb, { minLength: 2, maxLength: 6 }),
        // 0..1 fraction used to pick which entry to corrupt.
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        async (entries, corruptFraction) => {
          // Fresh chain per run.
          await db.exec('DELETE FROM audit_trail');

          // Append a valid chain via the real append() critical section.
          for (const entry of entries) {
            await AuditChainService.append(entry);
          }

          // Read entries in the SAME canonical order verifyChain uses.
          const rows = (await db
            .prepare(
              'SELECT id, details FROM audit_trail ORDER BY timestamp ASC, id ASC'
            )
            .all()) as Array<{ id: string; details: string | null }>;

          expect(rows.length).toBe(entries.length);

          // Sanity: an untouched, freshly built chain verifies clean.
          const before = await AuditChainService.verifyChain();
          expect(before.valid).toBe(true);

          // Pick a deterministic corruption target within the chain.
          const corruptIndex = Math.min(
            rows.length - 1,
            Math.floor(corruptFraction * rows.length)
          );
          const target = rows[corruptIndex];
          const targetId = String(target.id);

          // Corrupt exactly one entry's recorded content. The appended suffix
          // guarantees the value differs from the original, so the entry's
          // recomputed hash will no longer match its stored hash.
          const corruptedDetails = `${target.details ?? ''}__CORRUPTED__`;
          await db
            .prepare('UPDATE audit_trail SET details = ? WHERE id = ?::uuid')
            .run(corruptedDetails, targetId);

          // Verify: the corrupted entry is the first (and only) offender.
          const result = await AuditChainService.verifyChain();

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe('hash-mismatch');
            expect(result.firstOffendingId).toBe(targetId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

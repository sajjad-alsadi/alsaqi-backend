// @vitest-environment node
/**
 * Feature: backend-api-contract-alignment — DB-backed isolation test for
 * NotificationService.markManyRead.
 *
 * **Validates: Requirements 9.2, 9.3, 9.4**
 *
 * The existing property test (NotificationService.markManyRead.property.test.ts)
 * asserts the isolation guarantee against a hand-built in-memory mock whose
 * `run()` re-implements the exact WHERE clause. That mock would keep passing even
 * if the production SQL silently dropped its `recipient_id` predicate — the
 * isolation guarantee would no longer be genuinely exercised.
 *
 * This test closes that gap. It runs the REAL `markManyRead` SQL against a real
 * in-memory PGlite engine swapped into the shared `db` singleton (the same
 * known-working harness pattern used by
 * src/routes/__tests__/compliance.consistency.bugCondition.test.ts), so the
 * `recipient_id = ?::uuid` cross-user isolation predicate is truly enforced by
 * the database rather than re-implemented by a mock.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { db } from '../../db/index';
import { NotificationService } from '../NotificationService';

// A fresh in-memory PGlite is built per test from a real schema before the live
// service code runs against it. Building the engine is inherently slow and, under
// parallel suite load, can exceed the default 5000ms per-test timeout — a harness
// limitation, not a product regression. Raise the timeout to match the
// known-working DB-backed suite.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

// ─── Minimal real schema (matches database/schema.sql) ─────────────────────────
// FK REFERENCES are dropped to keep the harness simple; parent rows are still
// inserted so every insert succeeds and the UPDATE targets real data.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Unread',
    date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notification_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    is_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

let activePglite: PGlite | null = null;

afterEach(async () => {
  (db as any).updateClient(null, false);
  if (activePglite) {
    try { await activePglite.close(); } catch { /* ignore */ }
    activePglite = null;
  }
});

/**
 * Inserts a notification + a recipient row for the given user/read-state and
 * returns the notification id (which is what callers pass to markManyRead).
 */
async function seedRecipient(
  pglite: PGlite,
  userId: string,
  isRead: boolean
): Promise<string> {
  const notificationId = crypto.randomUUID();
  await pglite.query(
    `INSERT INTO notifications (id, user_id, event_type, description, status)
     VALUES ($1, $2, 'TestEvent', 'desc', $3)`,
    [notificationId, userId, isRead ? 'Read' : 'Unread']
  );
  await pglite.query(
    `INSERT INTO notification_recipients (id, notification_id, recipient_id, is_read, read_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), notificationId, userId, isRead, isRead ? new Date().toISOString() : null]
  );
  return notificationId;
}

async function isReadForUser(
  pglite: PGlite,
  notificationId: string,
  userId: string
): Promise<boolean> {
  const row = (await pglite.query(
    `SELECT is_read FROM notification_recipients
     WHERE notification_id = $1 AND recipient_id = $2`,
    [notificationId, userId]
  )).rows[0] as { is_read: boolean } | undefined;
  return row!.is_read;
}

describe('Feature: backend-api-contract-alignment — NotificationService.markManyRead DB-backed isolation (Validates: Requirements 9.2, 9.3, 9.4)', () => {
  it('marks only the current user\'s previously-unread listed recipient rows, leaves another user\'s rows untouched, and returns the exact transitioned count', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    await pglite.exec(SCHEMA);
    (db as any).updateClient(pglite as any, false);
    activePglite = pglite;

    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    await pglite.query(`INSERT INTO users (id, name) VALUES ($1, 'User A')`, [userA]);
    await pglite.query(`INSERT INTO users (id, name) VALUES ($1, 'User B')`, [userB]);

    // userA: two unread (will be listed), one unread (NOT listed), one already-read (listed).
    const aUnreadListed1 = await seedRecipient(pglite, userA, false);
    const aUnreadListed2 = await seedRecipient(pglite, userA, false);
    const aUnreadUnlisted = await seedRecipient(pglite, userA, false);
    const aAlreadyReadListed = await seedRecipient(pglite, userA, true);

    // userB: unread rows whose ids WILL be included in userA's request (isolation bait).
    const bUnread1 = await seedRecipient(pglite, userB, false);
    const bUnread2 = await seedRecipient(pglite, userB, false);

    const nonExistent = crypto.randomUUID();

    // userA's request mixes: own unread (incl. a duplicate), own already-read,
    // userB's unread ids, and a random non-existent id.
    const requestedIds = [
      aUnreadListed1,
      aUnreadListed2,
      aUnreadListed1, // duplicate
      aAlreadyReadListed,
      bUnread1,
      bUnread2,
      nonExistent,
    ];

    const updated = await NotificationService.markManyRead(requestedIds, userA);

    // (R9.4) Exactly the two of userA's previously-unread *listed* (deduped) rows
    // transitioned to read. The already-read, the unlisted, the duplicate, the
    // other user's rows, and the non-existent id must NOT inflate the count.
    expect(updated).toBe(2);

    // (R9.2 / R9.3) KEY ISOLATION ASSERTION: userB's rows are unchanged even
    // though their ids were in the request. A real DB enforces the
    // `recipient_id = userA` predicate — a mock that drops it could not.
    expect(await isReadForUser(pglite, bUnread1, userB)).toBe(false);
    expect(await isReadForUser(pglite, bUnread2, userB)).toBe(false);

    // userA's listed-unread rows are now read.
    expect(await isReadForUser(pglite, aUnreadListed1, userA)).toBe(true);
    expect(await isReadForUser(pglite, aUnreadListed2, userA)).toBe(true);

    // userA's unlisted-unread row is untouched; already-read row stays read.
    expect(await isReadForUser(pglite, aUnreadUnlisted, userA)).toBe(false);
    expect(await isReadForUser(pglite, aAlreadyReadListed, userA)).toBe(true);

    // Defense in depth: no notification_recipients row anywhere belongs to userB
    // and is read.
    const leaked = (await pglite.query(
      `SELECT COUNT(*)::int AS n FROM notification_recipients
       WHERE recipient_id = $1 AND is_read = true`,
      [userB]
    )).rows[0] as { n: number };
    expect(leaked.n).toBe(0);
  });
});

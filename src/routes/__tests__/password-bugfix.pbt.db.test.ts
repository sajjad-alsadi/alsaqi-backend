// @vitest-environment node
/**
 * Spec: forgot-password-admin-approval — Task 5: Property-Based Tests (DB Layer)
 *
 * **Validates: Requirements 2.4, 2.6**
 *
 * PBT-3: Reset-requests list property
 *   For random sets of pending reset-request rows (with joined user data), every
 *   row returned by PasswordService.getResetRequests MUST include `email` and
 *   `requested_at` with values matching the seeded data.
 *
 * PBT-4: Active-admins notification property
 *   For random mixes of active and inactive admin users, PasswordService.requestReset
 *   MUST dispatch notifications only to admins where status = 'Active'.
 *
 * Strategy: PGlite real-DB approach (same pattern as preservation test).
 * Does NOT mock db/PasswordService/NotificationService — uses real implementations.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

import { db } from '../../db/index';
import { PasswordService } from '../../services/PasswordService';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

// ─── Schema DDL ───────────────────────────────────────────────────────────────

const DDL_USERS = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    name TEXT NOT NULL,
    department TEXT,
    role TEXT NOT NULL DEFAULT 'Viewer',
    status TEXT NOT NULL DEFAULT 'Active',
    session_version INTEGER NOT NULL DEFAULT 1,
    requires_password_change INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    password_last_changed TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`;

const DDL_PASSWORD_RESET_REQUESTS = `
  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    status TEXT DEFAULT 'Pending',
    request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_date TIMESTAMP,
    resolved_by UUID,
    temp_password TEXT
  );
`;

const DDL_NOTIFICATIONS = `
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    related_module TEXT,
    link TEXT,
    status TEXT DEFAULT 'Unread',
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_id UUID,
    entity_id UUID,
    entity_type TEXT,
    data JSONB,
    title TEXT
  );
  CREATE TABLE IF NOT EXISTS notification_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    is_dismissed BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ
  );
`;

const DDL_PASSWORD_HISTORY = `
  CREATE TABLE IF NOT EXISTS password_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

const DDL_USER_SESSIONS = `
  CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    status TEXT DEFAULT 'Active'
  );
`;

const DDL_REFRESH_TOKENS = `
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    token TEXT,
    is_revoked INTEGER DEFAULT 0,
    revoked_at TIMESTAMPTZ
  );
`;

const DDL_USER_MANAGEMENT_SETTINGS = `
  CREATE TABLE IF NOT EXISTS user_management_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    password_min_length INTEGER NOT NULL DEFAULT 8,
    password_require_uppercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_lowercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_numbers BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_symbols BOOLEAN NOT NULL DEFAULT TRUE,
    password_expiry_days INTEGER NOT NULL DEFAULT 90
  );
  INSERT INTO user_management_settings (id, password_min_length) VALUES (1, 8) ON CONFLICT DO NOTHING;
`;

const DDL_AUDIT_TRAIL = `
  CREATE TABLE IF NOT EXISTS audit_trail (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user" TEXT,
    action TEXT,
    module TEXT,
    details TEXT,
    hash TEXT,
    previous_hash TEXT,
    seq SERIAL,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`;

// ─── DB harness ───────────────────────────────────────────────────────────────

let activePglite: PGlite | null = null;

async function useDb(): Promise<PGlite> {
  const pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(DDL_USERS);
  await pglite.exec(DDL_PASSWORD_RESET_REQUESTS);
  await pglite.exec(DDL_PASSWORD_HISTORY);
  await pglite.exec(DDL_NOTIFICATIONS);
  await pglite.exec(DDL_USER_SESSIONS);
  await pglite.exec(DDL_REFRESH_TOKENS);
  await pglite.exec(DDL_USER_MANAGEMENT_SETTINGS);
  await pglite.exec(DDL_AUDIT_TRAIL);
  (db as any).updateClient(pglite as any, false);
  activePglite = pglite;
  return pglite;
}

async function resetTables(pglite: PGlite) {
  await pglite.exec(`
    DELETE FROM password_reset_requests;
    DELETE FROM password_history;
    DELETE FROM notification_recipients;
    DELETE FROM notifications;
    DELETE FROM user_sessions;
    DELETE FROM refresh_tokens;
    DELETE FROM audit_trail;
    DELETE FROM users;
  `);
}

afterEach(async () => {
  (db as any).updateClient(null, false);
  if (activePglite) {
    try { await activePglite.close(); } catch { /* ignore */ }
    activePglite = null;
  }
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedUser(
  pglite: PGlite,
  overrides: Record<string, any> = {},
): Promise<{ id: string; username: string; email: string }> {
  const id = overrides.id ?? crypto.randomUUID();
  const username = overrides.username ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const email = overrides.email ?? `${username}@example.com`;
  const hashed = await bcrypt.hash('Password123!', 4);
  await pglite.query(
    `INSERT INTO users (id, username, password, name, email, department, role, status, session_version, requires_password_change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      username,
      hashed,
      overrides.name ?? 'Test User',
      email,
      overrides.department ?? 'IT',
      overrides.role ?? 'Viewer',
      overrides.status ?? 'Active',
      1,
      0,
    ],
  );
  return { id, username, email };
}

async function seedPendingRequest(
  pglite: PGlite,
  userId: string,
  username: string,
  name = 'Test User',
  department = 'IT',
): Promise<string> {
  const result = await pglite.query(
    `INSERT INTO password_reset_requests (user_id, username, name, department, status)
     VALUES ($1,$2,$3,$4,'Pending') RETURNING id`,
    [userId, username, name, department],
  );
  return (result.rows[0] as any).id;
}

// ─────────────────────────────────────────────────────────────────────────────
// PBT-3: Reset-requests list property
//
// **Validates: Requirements 2.4**
//
// For random sets of pending reset-request rows (with joined user data) every
// row returned by PasswordService.getResetRequests MUST include `email` and
// `requested_at` with values matching the seeded data.
// ─────────────────────────────────────────────────────────────────────────────

describe('PBT-3: Reset-requests list property — Validates: Requirements 2.4', () => {
  /**
   * Generator: 1–5 users with varied attributes.
   */
  const userBatchArb = fc.array(
    fc.record({
      usernameBase: fc.string({ minLength: 3, maxLength: 12 })
        .filter(s => /^[a-z][a-z0-9]*$/.test(s)),
      name: fc.string({ minLength: 2, maxLength: 20 })
        .filter(s => s.trim().length > 0),
      department: fc.constantFrom('IT', 'Finance', 'HR', 'Legal', 'Audit'),
    }),
    { minLength: 1, maxLength: 5 },
  );

  it('every row in getResetRequests includes email and requested_at matching seeded data', async () => {
    const pglite = await useDb();

    await fc.assert(
      fc.asyncProperty(userBatchArb, async (users) => {
        await resetTables(pglite);

        // Deduplicate usernames within a batch to avoid unique constraint violations
        const seen = new Set<string>();
        const uniqueUsers = users.filter(u => {
          if (seen.has(u.usernameBase)) return false;
          seen.add(u.usernameBase);
          return true;
        });

        const expectedEmailByUsername: Record<string, string> = {};

        for (const u of uniqueUsers) {
          const { id, username, email } = await seedUser(pglite, {
            username: u.usernameBase,
            name: u.name,
            department: u.department,
          });
          await seedPendingRequest(pglite, id, username, u.name, u.department);
          expectedEmailByUsername[username] = email;
        }

        // Call the real service method — exercises the JOIN query
        const rows = await PasswordService.getResetRequests() as any[];

        expect(rows.length).toBe(uniqueUsers.length);

        for (const row of rows) {
          // Property: every row MUST have email and requested_at
          expect(row).toHaveProperty('email');
          expect(row).toHaveProperty('requested_at');

          // Property: email value MUST match what was seeded
          expect(typeof row.email).toBe('string');
          expect(row.email.length).toBeGreaterThan(0);
          expect(row.email).toBe(expectedEmailByUsername[row.username]);

          // Property: requested_at MUST be non-null (aliased from request_date)
          expect(row.requested_at).toBeTruthy();

          // Property: all other required fields present
          expect(row).toHaveProperty('id');
          expect(row).toHaveProperty('username');
          expect(row).toHaveProperty('status');
          expect(row.status).toBe('Pending');
        }
      }),
      { numRuns: 15 },
    );
  });

  it('rows from getResetRequests have matching email even for users with unusual email formats', async () => {
    const pglite = await useDb();

    // Generator for unusual but valid email strings
    const emailArb = fc.tuple(
      fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z0-9._%+-]+$/.test(s)),
      fc.string({ minLength: 2, maxLength: 10 }).filter(s => /^[a-zA-Z0-9]+$/.test(s)),
      fc.constantFrom('com', 'org', 'co.uk', 'io'),
    ).map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

    await fc.assert(
      fc.asyncProperty(emailArb, async (customEmail) => {
        await resetTables(pglite);

        const username = `emailtest_${crypto.randomUUID().slice(0, 6)}`;
        const { id } = await seedUser(pglite, { username, email: customEmail });
        await seedPendingRequest(pglite, id, username);

        const rows = await PasswordService.getResetRequests() as any[];

        expect(rows.length).toBe(1);
        expect(rows[0].email).toBe(customEmail);
        expect(rows[0]).toHaveProperty('requested_at');
        expect(rows[0].requested_at).toBeTruthy();
      }),
      { numRuns: 15 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PBT-4: Active-admins notification property
//
// **Validates: Requirements 2.6**
//
// For random mixes of active and inactive admin users, PasswordService.requestReset
// MUST return adminIds that are the strict subset where status = 'Active'.
// No inactive/suspended admin SHALL appear in the notification targets.
// ─────────────────────────────────────────────────────────────────────────────

describe('PBT-4: Active-admins notification property — Validates: Requirements 2.6', () => {
  /**
   * Generator: (activeCount, inactiveCount) — always at least 1 inactive to
   * exercise the filter.
   */
  const adminMixArb = fc.tuple(
    fc.integer({ min: 0, max: 3 }),  // active admins
    fc.integer({ min: 1, max: 3 }),  // inactive admins (at least 1)
  );

  it('requestReset adminIds contains only active admins — no inactive admin appears', async () => {
    const pglite = await useDb();

    await fc.assert(
      fc.asyncProperty(adminMixArb, async ([activeCount, inactiveCount]) => {
        await resetTables(pglite);

        const activeAdminIds: string[] = [];
        const inactiveAdminIds: string[] = [];

        for (let i = 0; i < activeCount; i++) {
          const { id } = await seedUser(pglite, {
            username: `active_admin_${i}_${crypto.randomUUID().slice(0, 5)}`,
            role: 'Admin',
            status: 'Active',
          });
          activeAdminIds.push(id);
        }

        for (let i = 0; i < inactiveCount; i++) {
          const { id } = await seedUser(pglite, {
            username: `inactive_admin_${i}_${crypto.randomUUID().slice(0, 5)}`,
            role: 'Admin',
            status: 'Inactive',
          });
          inactiveAdminIds.push(id);
        }

        const { username: requesterUsername } = await seedUser(pglite, {
          username: `requester_${crypto.randomUUID().slice(0, 7)}`,
          role: 'Viewer',
          status: 'Active',
        });

        const result = await PasswordService.requestReset(requesterUsername) as any;

        expect(result.success).toBe(true);

        if (result.adminIds !== undefined) {
          // Property: NO inactive admin ID appears in adminIds
          for (const inactiveId of inactiveAdminIds) {
            expect(result.adminIds).not.toContain(inactiveId);
          }

          // Property: ALL active admins appear in adminIds
          for (const activeId of activeAdminIds) {
            expect(result.adminIds).toContain(activeId);
          }

          // Property: adminIds length equals the number of active admins (no extras)
          expect(result.adminIds.length).toBe(activeAdminIds.length);
        }
      }),
      { numRuns: 12 },
    );
  });

  it('notification targets are a strict subset of active admins when both groups exist', async () => {
    const pglite = await useDb();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        async (activeCount, inactiveCount) => {
          await resetTables(pglite);

          const activeIds: string[] = [];
          const inactiveIds: string[] = [];

          for (let i = 0; i < activeCount; i++) {
            const { id } = await seedUser(pglite, {
              username: `aa_${i}_${crypto.randomUUID().slice(0, 5)}`,
              role: 'Admin',
              status: 'Active',
            });
            activeIds.push(id);
          }

          for (let i = 0; i < inactiveCount; i++) {
            const { id } = await seedUser(pglite, {
              username: `ia_${i}_${crypto.randomUUID().slice(0, 5)}`,
              role: 'Admin',
              status: 'Inactive',
            });
            inactiveIds.push(id);
          }

          const { username } = await seedUser(pglite, {
            username: `req_${crypto.randomUUID().slice(0, 7)}`,
            role: 'Viewer',
            status: 'Active',
          });

          const result = await PasswordService.requestReset(username) as any;

          expect(result.success).toBe(true);

          if (result.adminIds !== undefined) {
            const adminIdSet = new Set<string>(result.adminIds);

            // Every element in adminIds is an active admin (no strays)
            for (const id of result.adminIds) {
              expect(activeIds).toContain(id);
            }

            // All active admins are included (complete set)
            expect(adminIdSet.size).toBe(activeIds.length);

            // No inactive admin is included
            for (const id of inactiveIds) {
              expect(adminIdSet.has(id)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it('with zero active admins, adminIds is empty or undefined (no inactive admins notified)', async () => {
    const pglite = await useDb();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (inactiveCount) => {
          await resetTables(pglite);

          const inactiveIds: string[] = [];
          for (let i = 0; i < inactiveCount; i++) {
            const { id } = await seedUser(pglite, {
              username: `only_inactive_${i}_${crypto.randomUUID().slice(0, 5)}`,
              role: 'Admin',
              status: 'Inactive',
            });
            inactiveIds.push(id);
          }

          const { username } = await seedUser(pglite, {
            username: `req_noadmin_${crypto.randomUUID().slice(0, 6)}`,
            role: 'Viewer',
            status: 'Active',
          });

          const result = await PasswordService.requestReset(username) as any;

          expect(result.success).toBe(true);

          if (result.adminIds !== undefined) {
            // With no active admins, adminIds MUST be empty
            expect(result.adminIds.length).toBe(0);

            // Definitely no inactive admin in the list
            for (const id of inactiveIds) {
              expect(result.adminIds).not.toContain(id);
            }
          }
        },
      ),
      { numRuns: 8 },
    );
  });
});

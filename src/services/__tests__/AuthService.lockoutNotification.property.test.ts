// @vitest-environment node
// Feature: backend-security-hardening, Property 16: Lockout notification atomicity
// Validates: Requirements 8.5
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 16 — Lockout notification atomicity (Req 8.5).
 *
 * When an account lockout occurs, `AuthService.handleFailedLogin` first commits the lockout
 * state (the `locked_until` UPDATE) as a standalone, auto-committed statement, and only then
 * runs `notifyAdminsOfLockout`, which wraps ALL notification inserts for that lockout event in
 * a single `db.transaction`. The property under test:
 *
 *   If any notification insert fails, ALL notification rows for that lockout event roll back
 *   (no committed notification rows survive), the previously committed lockout state is
 *   preserved, and login does not crash — it still rejects with the generic
 *   `InvalidCredentialsError` rather than surfacing the internal notification failure.
 *
 * To make the transaction's rollback semantics OBSERVABLE, the mocked db wrapper models a real
 * commit/rollback boundary: statements executed inside `db.transaction` stage their writes into
 * a pending buffer that is committed atomically only if the callback resolves, and discarded if
 * the callback throws. Statements executed outside a transaction auto-commit immediately. This
 * lets the test distinguish "committed" notification rows from rows that were staged then rolled
 * back, exactly mirroring the real `DBWrapper.transaction` BEGIN/COMMIT/ROLLBACK behavior.
 */

const { dbState, txState, config, verifyPasswordMock } = vi.hoisted(() => {
  const dbState = {
    committedNotifications: [] as Array<{ userId: unknown }>,
    committedLockouts: [] as Array<{ id: unknown; lockedUntil: unknown }>,
    committedFailedAttempts: [] as Array<{ id: unknown }>,
    insertAttempts: 0,
  };
  const txState = { active: null as null | { staged: Array<{ kind: string; row: unknown }> } };
  const config = {
    admins: [] as Array<{ id: string }>,
    failAtInsert: 0, // 1-based index of the INSERT that throws; 0 = no failure
    threshold: 5,
    user: null as unknown,
  };
  const verifyPasswordMock = vi.fn();
  return { dbState, txState, config, verifyPasswordMock };
});

vi.mock('../../db/index', () => {
  type Write = { kind: 'notification' | 'lockout' | 'failedAttempt'; row: any };

  function commit(write: Write) {
    if (write.kind === 'notification') dbState.committedNotifications.push(write.row);
    else if (write.kind === 'lockout') dbState.committedLockouts.push(write.row);
    else if (write.kind === 'failedAttempt') dbState.committedFailedAttempts.push(write.row);
  }

  // Stage inside the active transaction (deferred commit) or auto-commit when none is active.
  function record(write: Write) {
    if (txState.active) txState.active.staged.push(write);
    else commit(write);
  }

  const db = {
    isExternal: false,
    prepare(sql: string) {
      return {
        get: async (...args: unknown[]) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) return config.user;
          if (sql.includes('user_management_settings'))
            return { failed_login_threshold: config.threshold };
          // Conditional unlocked->locked transition UPDATE (`SET locked_until ... RETURNING id`),
          // executed via `.get()` OUTSIDE any transaction, so it auto-commits the lockout state
          // and returns the row for the request that performed the transition (drives the single
          // notification pass).
          if (sql.includes('SET locked_until') && sql.includes('RETURNING id')) {
            record({ kind: 'lockout', row: { lockedUntil: args[0], id: (config.user as { id: unknown }).id } });
            return { id: (config.user as { id: unknown }).id };
          }
          return undefined;
        },
        all: async (..._args: unknown[]) => {
          // Active-admin lookup for lockout notifications (Req 8.2 bound param ignored here).
          if (sql.includes('SELECT id FROM users') && sql.includes("status = 'Active'")) {
            return config.admins;
          }
          return [];
        },
        run: async (...args: unknown[]) => {
          if (sql.includes('failed_attempts = failed_attempts + 1')) {
            record({ kind: 'failedAttempt', row: { id: args[0] } });
            return {};
          }
          if (sql.includes('SET locked_until = ?')) {
            // Lockout state UPDATE — runs outside any transaction => auto-commits.
            record({ kind: 'lockout', row: { lockedUntil: args[0], id: args[1] } });
            return {};
          }
          if (sql.includes('INSERT INTO notifications')) {
            // Production uses a SINGLE set-based `INSERT ... SELECT` that inserts one row per
            // active admin atomically. Model that single statement: it either inserts all rows
            // (one per admin) or, on simulated failure, throws so the wrapping transaction rolls
            // every staged row back.
            dbState.insertAttempts += 1;
            if (config.failAtInsert > 0) {
              throw new Error('simulated notification insert failure');
            }
            for (const admin of config.admins) {
              record({ kind: 'notification', row: { userId: admin.id } });
            }
            return {};
          }
          return {};
        },
      };
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const parent = txState.active;
      const tx = { staged: [] as Write[] };
      txState.active = tx;
      try {
        const result = await fn();
        // COMMIT: flush staged writes to the parent scope (or durably commit at top level).
        txState.active = parent;
        for (const w of tx.staged) {
          if (parent) parent.staged.push(w);
          else commit(w);
        }
        return result;
      } catch (e) {
        // ROLLBACK: discard every staged write for this transaction, then rethrow.
        txState.active = parent;
        throw e;
      }
    },
  };
  return { db };
});

vi.mock('../passwordVerifier', () => ({
  verifyPassword: verifyPasswordMock,
  DUMMY_HASH: 'DUMMY_HASH_VALUE',
  bcryptCostFactor: () => 12,
}));

import { AuthService } from '../AuthService';
import { InvalidCredentialsError } from '../../utils/errors';

function resetState() {
  dbState.committedNotifications.length = 0;
  dbState.committedLockouts.length = 0;
  dbState.committedFailedAttempts.length = 0;
  dbState.insertAttempts = 0;
  config.admins = [];
  config.failAtInsert = 0;
  config.threshold = 5;
  // Wrong-password active user whose failed_attempts already meets the threshold, so the next
  // failed attempt (this login) triggers a lockout.
  config.user = {
    id: '00000000-0000-0000-0000-0000000000aa',
    username: 'bob',
    email: 'bob@example.com',
    password: '$2b$12$realhashvalueplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    // Canonical schema status; login blocks every non-'Active' status (Req 2.2).
    status: 'Active',
    locked_until: null,
    failed_attempts: config.threshold, // threshold + 1 >= threshold => lockout
    role: 'auditor',
    name: 'Bob',
  };
  verifyPasswordMock.mockResolvedValue(false); // wrong password on every attempt
}

describe('Property 16: Lockout notification atomicity (Task 8.7, Req 8.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back ALL notification rows when the Nth insert fails, preserving lockout state and not crashing login', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 15 }), // number of active admins
        fc.integer({ min: 1, max: 15 }), // raw selector for which insert fails
        async (numAdmins, failSelector) => {
          resetState();
          const failAt = ((failSelector - 1) % numAdmins) + 1; // 1..numAdmins
          config.admins = Array.from({ length: numAdmins }, (_, i) => ({ id: `admin-${i}` }));
          config.failAtInsert = failAt;

          let thrown: unknown;
          try {
            await AuthService.login('bob', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '1.2.3.4');
          } catch (e) {
            thrown = e;
          }

          // Login did not crash: it surfaces the generic failure, never the notification error.
          expect(thrown).toBeInstanceOf(InvalidCredentialsError);

          // Lockout state was committed before notifications and is preserved (Req 8.5).
          expect(dbState.committedLockouts).toHaveLength(1);
          expect(dbState.committedLockouts[0].id).toBe(config.user.id);

          // The notification transaction rolled back: NO notification rows are committed,
          // even though earlier inserts in the same transaction had succeeded before the
          // failing Nth insert.
          expect(dbState.committedNotifications).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('commits exactly one notification row per active admin when no insert fails (atomic all-or-nothing, success half)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 15 }), // number of active admins (0 => zero rows, no error)
        async (numAdmins) => {
          resetState();
          config.admins = Array.from({ length: numAdmins }, (_, i) => ({ id: `admin-${i}` }));
          config.failAtInsert = 0; // no failure

          let thrown: unknown;
          try {
            await AuthService.login('bob', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '1.2.3.4');
          } catch (e) {
            thrown = e;
          }

          // Generic failure is still returned regardless of notification outcome.
          expect(thrown).toBeInstanceOf(InvalidCredentialsError);

          // Lockout persisted.
          expect(dbState.committedLockouts).toHaveLength(1);

          // On commit, exactly one notification row per active admin is durably committed
          // (zero rows when no active admin exists, without error — Req 8.4).
          expect(dbState.committedNotifications).toHaveLength(numAdmins);
          const committedUserIds = dbState.committedNotifications.map((n) => n.userId).sort();
          const expectedUserIds = config.admins.map((a) => a.id).sort();
          expect(committedUserIds).toEqual(expectedUserIds);
        },
      ),
      { numRuns: 100 },
    );
  });
});

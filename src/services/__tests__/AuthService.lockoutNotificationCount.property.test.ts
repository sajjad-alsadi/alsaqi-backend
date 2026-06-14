// @vitest-environment node
// Feature: backend-security-hardening, Property 15: Lockout notification count equals active-admin count
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 15: Lockout notification count equals active-admin count.
 * Validates: Requirements 8.1, 8.3, 8.4.
 *
 * When an account is locked out, `AuthService` must insert exactly one notification row per
 * ACTIVE administrator, and zero rows when there are none. The lockout notification path is
 * exercised through the public login flow: a wrong password on a user whose `failed_attempts`
 * is one below the configured threshold drives `handleFailedLogin` → `notifyAdminsOfLockout`.
 *
 * The `db` wrapper is mocked (mirroring `AuthService.login.test.ts`). The admin query
 * `SELECT id FROM users WHERE role = ?::text AND status = 'Active'` is simulated by applying
 * the same `status === 'Active'` filter the real SQL would apply, so that the count of
 * `INSERT INTO notifications` statements can be compared against the active-admin count for an
 * arbitrary mix of active and inactive admins (including the zero-active case).
 */

const { state, counter } = vi.hoisted(() => {
  const state: {
    userRow: unknown;
    threshold: number;
    admins: Array<{ id: string; status: string }>;
  } = { userRow: null, threshold: 5, admins: [] };
  const counter = { notifications: 0 };
  return { state, counter };
});

vi.mock('../../db/index', () => {
  const db = {
    isExternal: false,
    prepare(sql: string) {
      return {
        get: async (..._args: unknown[]) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) return state.userRow;
          if (sql.includes('user_management_settings')) {
            return { failed_login_threshold: state.threshold };
          }
          return undefined;
        },
        all: async (..._args: unknown[]) => {
          // Simulate the parameterized admin query's SQL-level `status = 'Active'` filter.
          if (sql.includes('SELECT id FROM users') && sql.includes('role')) {
            return state.admins.filter((a) => a.status === 'Active').map((a) => ({ id: a.id }));
          }
          return [];
        },
        run: async (..._args: unknown[]) => {
          if (sql.includes('INSERT INTO notifications')) counter.notifications++;
          return {};
        },
      };
    },
    async transaction(fn: () => Promise<unknown>) {
      // Mirror the real wrapper: run the callback, let a throw propagate (ROLLBACK + rethrow).
      return fn();
    },
  };
  return { db };
});

const { verifyPasswordMock } = vi.hoisted(() => ({ verifyPasswordMock: vi.fn() }));
vi.mock('../passwordVerifier', () => ({
  verifyPassword: verifyPasswordMock,
  DUMMY_HASH: 'DUMMY_HASH_VALUE',
  bcryptCostFactor: () => 12,
}));

import { AuthService } from '../AuthService';
import { InvalidCredentialsError } from '../../utils/errors';

const BASE_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'victim',
  email: 'victim@example.com',
  password: '$2b$12$realhashvalueplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // Canonical schema status; login blocks every non-'Active' status (Req 2.2).
  status: 'Active',
  locked_until: null,
  role: 'admin',
  name: 'Victim',
};

describe('AuthService lockout notifications — count equals active-admin count (Property 15)', () => {
  it('inserts exactly one notification per active admin (zero when none)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 8 }), // number of ACTIVE admins
        fc.nat({ max: 8 }), // number of inactive admins
        fc.integer({ min: 2, max: 10 }), // configured lockout threshold
        async (activeCount, inactiveCount, threshold) => {
          // Reset per-iteration state.
          counter.notifications = 0;
          verifyPasswordMock.mockReset();
          verifyPasswordMock.mockResolvedValue(false); // wrong password

          const admins: Array<{ id: string; status: string }> = [];
          for (let i = 0; i < activeCount; i++) {
            admins.push({ id: `active-${i}`, status: 'Active' });
          }
          for (let i = 0; i < inactiveCount; i++) {
            // Any non-'Active' status is excluded by the admin query's SQL filter.
            admins.push({ id: `inactive-${i}`, status: i % 2 === 0 ? 'Suspended' : 'Inactive' });
          }
          state.admins = admins;
          state.threshold = threshold;
          // failed_attempts one below threshold so this wrong password triggers the lockout.
          state.userRow = { ...BASE_USER, failed_attempts: threshold - 1 };

          await expect(
            AuthService.login('victim', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '203.0.113.7'),
          ).rejects.toBeInstanceOf(InvalidCredentialsError);

          // Exactly one notification row per ACTIVE admin; zero when none exist.
          expect(counter.notifications).toBe(activeCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

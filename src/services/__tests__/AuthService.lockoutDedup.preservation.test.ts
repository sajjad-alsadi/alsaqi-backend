// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 2: Preservation property tests (auth lockout dedup)
 *
 * Property 2: Preservation — for every input where NO bug condition holds (¬C(X)), the fixed code
 * must behave identically to the current code. This RECORDS the current correct baseline on the
 * UNFIXED code and is EXPECTED TO PASS as written.
 *
 * Validates: Requirements 3.8
 *
 * 3.8 — once-per-transition lockout notification (dedup preserved). The dedup mechanism is the
 * conditional lock UPDATE (`SET locked_until ... WHERE ... (locked_until IS NULL OR locked_until <
 * CURRENT_TIMESTAMP) RETURNING id`): admins are notified ONLY by the request that actually performs
 * the unlocked→locked transition. The recommended sliding-window fix (1.6 → 2.6) must keep this
 * single-notification behavior, so these baselines apply to both the current and the fixed code.
 *
 * Mirrors the `db` + `passwordVerifier` mocking of AuthService.lockoutNotificationCount.property.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// ─── Recording mock DB ──────────────────────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    log: [] as Array<{ sql: string; method: 'get' | 'all' | 'run'; args: any[] }>,
    responder: null as null | ((sql: string, method: string, args: any[]) => any),
  },
}));

vi.mock('../../db/index', () => {
  const db = {
    isExternal: false,
    validateIdentifier: (id: string) => id,
    prepare(sql: string) {
      const exec = (method: 'get' | 'all' | 'run') => async (...args: any[]) => {
        dbState.log.push({ sql, method, args });
        const r = dbState.responder ? dbState.responder(sql, method, args) : undefined;
        if (r !== undefined) return r;
        return method === 'all' ? [] : method === 'get' ? null : { changes: 1, lastInsertRowid: 0 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) {
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

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const PW_HASH = '$2b$12$realhashvalueplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function reset(responder: ((sql: string, method: string, args: any[]) => any) | null = null) {
  dbState.log = [];
  dbState.responder = responder;
}
function notificationInserts() {
  return dbState.log.filter((e) => e.method === 'run' && /INSERT INTO notifications/.test(e.sql));
}
function lockTransitionAttempts() {
  return dbState.log.filter((e) => /SET locked_until/.test(e.sql) && /RETURNING id/.test(e.sql));
}

/**
 * Builds a responder for one failed-login attempt.
 *  - `postIncrementCount` is the authoritative count returned by `failed_attempts = failed_attempts + 1`.
 *  - `transitionWins` controls whether the conditional lock UPDATE returns a row (this request
 *    performed the unlocked→locked transition) or null (already locked / lost the race).
 */
function buildResponder(threshold: number, postIncrementCount: number, transitionWins: boolean) {
  return (sql: string, method: string) => {
    if (sql.includes('LOWER(username)')) {
      return {
        id: USER_ID,
        username: 'victim',
        email: 'victim@example.com',
        password: PW_HASH,
        status: 'Active',
        locked_until: null,
        failed_attempts: Math.max(0, postIncrementCount - 1),
        role: 'auditor',
        name: 'Victim',
      };
    }
    if (sql.includes('failed_login_threshold')) return { failed_login_threshold: threshold };
    if (method === 'run' && /failed_attempts\s*=\s*failed_attempts\s*\+\s*1/.test(sql)) {
      return { changes: 1, failed_attempts: postIncrementCount, rows: [{ failed_attempts: postIncrementCount }] };
    }
    if (method === 'get' && sql.includes('SET locked_until') && sql.includes('RETURNING id')) {
      return transitionWins ? { id: USER_ID } : null;
    }
    return undefined; // notifications INSERT → default { changes: 1 }
  };
}

async function attemptLogin() {
  await expect(
    AuthService.login('victim', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '203.0.113.7'),
  ).rejects.toBeInstanceOf(InvalidCredentialsError);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reset(null);
  verifyPasswordMock.mockResolvedValue(false); // every attempt here is a wrong password
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Property 2: Preservation — AuthService lockout notification dedup (correspondence-api-hardening-fixes)', () => {
  // ── 3.8a The unlocked→locked transition notifies admins exactly once ─────────
  it('3.8a notifies admins exactly once when this request performs the lock transition', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (threshold) => {
        // Crossing the threshold AND winning the conditional lock UPDATE → notify once.
        reset(buildResponder(threshold, threshold, true));
        await attemptLogin();
        expect(notificationInserts().length).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  // ── 3.8b A request that crosses the threshold but does NOT win the transition does not notify ─
  it('3.8b does NOT notify when another request already performed the transition (dedup)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 0, max: 5 }), async (threshold, extra) => {
        // Threshold crossed (count >= threshold) but the conditional UPDATE returns null
        // (account already locked by a concurrent attempt) → zero notifications.
        reset(buildResponder(threshold, threshold + extra, false));
        await attemptLogin();
        expect(lockTransitionAttempts().length).toBeGreaterThan(0); // it DID attempt the transition
        expect(notificationInserts().length).toBe(0); // but did not re-notify
      }),
      { numRuns: 30 },
    );
  });

  // ── 3.8c Below the threshold, neither a lock transition nor a notification occurs ─
  it('3.8c does not attempt a lock transition or notify before the threshold is reached', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 10 }), async (threshold) => {
        // Authoritative post-increment count strictly below threshold.
        reset(buildResponder(threshold, threshold - 1, true));
        await attemptLogin();
        expect(lockTransitionAttempts().length).toBe(0);
        expect(notificationInserts().length).toBe(0);
      }),
      { numRuns: 30 },
    );
  });
});

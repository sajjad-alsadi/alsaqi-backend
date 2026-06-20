// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 1: Bug-condition exploration tests (auth lockout)
 *
 * Property 1: Bug Condition — finding 1.6 reproduces as a counterexample.
 * Validates: Requirements 1.6
 *
 * 1.6 is [DECISION: sliding window] (bugfix.md 2.6). These encode the recommended EXPECTED behavior
 * and are intended to FAIL on the UNFIXED code:
 *   (a) a failed attempt arriving DURING an active lock extends `locked_until` (sliding window);
 *   (b) the admin-lockout notification reports the authoritative POST-increment attempt count,
 *       not the pre-increment in-memory snapshot (`failed_attempts + 1`).
 * The single-notification dedup (preservation clause 3.8) is intentionally NOT changed here.
 *
 * Mirrors the `db` + `passwordVerifier` mocking of
 * services/__tests__/AuthService.lockoutNotificationCount.property.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('Property 1: Bug Condition exploration — AuthService lockout window (correspondence-api-hardening-fixes)', () => {
  // ── 1.6a Sliding window: a failed attempt during a lock must extend locked_until ──
  it('1.6a a failed attempt during an active lock extends locked_until (sliding window)', async () => {
    const existingLock = new Date(Date.now() + 5 * 60 * 1000); // already locked for 5 more minutes
    reset((sql) => {
      if (sql.includes('LOWER(username)')) {
        return {
          id: USER_ID,
          username: 'victim',
          email: 'victim@example.com',
          password: PW_HASH,
          status: 'Active',
          locked_until: existingLock.toISOString(),
          failed_attempts: 5,
          role: 'auditor',
          name: 'Victim',
        };
      }
      if (sql.includes('failed_login_threshold')) return { failed_login_threshold: 5 };
      return undefined;
    });

    await expect(
      AuthService.login('victim', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '203.0.113.7'),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    // Expected (2.6, sliding): this attempt advances the lock expiry.
    // Counterexample on unfixed code: login short-circuits at the "already locked" check before
    // recording the attempt, so NO statement updates locked_until and the lock never slides.
    const lockWrites = dbState.log.filter(
      (e) => (e.method === 'run' || e.method === 'get') && /locked_until\s*=\s*\?/.test(e.sql),
    );
    expect(lockWrites.length, 'a failed attempt during a lock should extend locked_until').toBeGreaterThan(0);
    const newExpiry = new Date(lockWrites[0]?.args?.[0] as string);
    expect(newExpiry.getTime()).toBeGreaterThan(existingLock.getTime());
  });

  // ── 1.6b Notification message must use the authoritative post-increment count ──
  it('1.6b the lockout notification reports the authoritative post-increment attempt count', async () => {
    let notificationDescription: string | undefined;
    reset((sql, method, args) => {
      if (sql.includes('LOWER(username)')) {
        return {
          id: USER_ID,
          username: 'victim',
          email: 'victim@example.com',
          password: PW_HASH,
          status: 'Active',
          locked_until: null,
          failed_attempts: 0, // stale in-memory snapshot (e.g. a concurrent attempt)
          role: 'auditor',
          name: 'Victim',
        };
      }
      if (sql.includes('failed_login_threshold')) return { failed_login_threshold: 5 };
      // Authoritative post-increment count: concurrent attempts have reached the threshold (5).
      if (method === 'run' && /failed_attempts\s*=\s*failed_attempts\s*\+\s*1/.test(sql)) {
        return { changes: 1, failed_attempts: 5, rows: [{ failed_attempts: 5 }] };
      }
      // Conditional lock UPDATE: report that THIS request performed the unlocked -> locked transition.
      if (method === 'get' && sql.includes('SET locked_until') && sql.includes('RETURNING id')) {
        return { id: USER_ID };
      }
      if (method === 'run' && sql.includes('INSERT INTO notifications')) {
        notificationDescription = String(args[0]);
        return { changes: 1 };
      }
      return undefined;
    });

    await expect(
      AuthService.login('victim', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY', '203.0.113.7'),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(notificationDescription, 'a lockout notification should be composed').toBeTruthy();
    // Expected (2.6): the message reflects the authoritative count (5), not the pre-increment value (1).
    // Counterexample on unfixed code: notifyAdminsOfLockout builds the text from `failed_attempts + 1`
    // (0 + 1 = 1), so it reads "...after 1 failed login attempts".
    expect(notificationDescription!).toMatch(/after 5 failed login attempts/);
  });
});

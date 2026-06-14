// @vitest-environment node
// Feature: backend-security-hardening, Task 8.3
// Non-blocking, anti-enumeration login flow.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Unit tests for the reworked `AuthService.login` flow (Task 8.3).
 *
 * Asserts:
 * - The four failure conditions (unknown account, suspended, locked, wrong password)
 *   surface a byte-for-byte identical generic failure response (Req 15.2, 15.3).
 * - Unknown accounts still run an asynchronous bcrypt comparison against DUMMY_HASH so the
 *   timing matches a real verification (anti-enumeration, Req 15.1).
 * - A verification rejection is mapped to the same generic failure and rolls the transaction
 *   back without crashing (Req 14.5, 15.5).
 * - The synchronous bcrypt comparison (`compareSync`) is never used in the login path (Req 14.4).
 *
 * The `db` module is mocked with a pass-through transaction (which rethrows on error, mirroring
 * the real wrapper's ROLLBACK-then-rethrow semantics) and a `prepare` whose `get` returns the
 * configured user/settings rows. `passwordVerifier` is mocked so the comparison result and the
 * exact hash argument can be asserted directly.
 */

const { state, runMock, transactionSpy } = vi.hoisted(() => {
  const state: { userRow: unknown; settings: unknown } = {
    userRow: null,
    settings: { failed_login_threshold: 5 },
  };
  const runMock = vi.fn(async () => ({}));
  const transactionSpy = vi.fn();
  return { state, runMock, transactionSpy };
});

vi.mock('../../db/index', () => {
  const db = {
    isExternal: false,
    prepare(sql: string) {
      return {
        get: async (..._args: unknown[]) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) return state.userRow;
          if (sql.includes('user_management_settings')) return state.settings;
          return undefined;
        },
        run: runMock,
        all: async (..._args: unknown[]) => [],
      };
    },
    async transaction(fn: () => Promise<unknown>) {
      transactionSpy();
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

const ACTIVE_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'alice',
  email: 'alice@example.com',
  password: '$2b$12$realhashvalueplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // Canonical schema status is 'Active' (users.status CHECK). Login now blocks every
  // non-'Active' status via the shared isLoginBlockedStatus rule (Req 2.2).
  status: 'Active',
  locked_until: null,
  failed_attempts: 0,
  role: 'admin',
  name: 'Alice',
};

async function captureLoginError(): Promise<unknown> {
  try {
    await AuthService.login('alice', 'wrong-password', 'jwtSecret', 'PRIVATE_KEY');
    throw new Error('expected login to reject');
  } catch (e) {
    return e;
  }
}

describe('AuthService.login — anti-enumeration & non-blocking (Task 8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userRow = null;
    state.settings = { failed_login_threshold: 5 };
    verifyPasswordMock.mockResolvedValue(false);
  });

  it('runs an async bcrypt comparison against DUMMY_HASH for an unknown account (Req 15.1)', async () => {
    state.userRow = undefined;
    await expect(
      AuthService.login('ghost', 'pw', 's', 'k'),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(verifyPasswordMock).toHaveBeenCalledWith('pw', 'DUMMY_HASH_VALUE');
  });

  it('returns a byte-identical generic failure for unknown/suspended/locked/wrong-password (Req 15.2, 15.3)', async () => {
    // Unknown account
    state.userRow = undefined;
    verifyPasswordMock.mockResolvedValue(false);
    const unknownErr = await captureLoginError();

    // Suspended account (verification still runs first)
    state.userRow = { ...ACTIVE_USER, status: 'Suspended' };
    verifyPasswordMock.mockResolvedValue(true);
    const suspendedErr = await captureLoginError();

    // Locked account
    state.userRow = { ...ACTIVE_USER, locked_until: new Date(Date.now() + 60_000).toISOString() };
    verifyPasswordMock.mockResolvedValue(true);
    const lockedErr = await captureLoginError();

    // Wrong password on an active account
    state.userRow = { ...ACTIVE_USER };
    verifyPasswordMock.mockResolvedValue(false);
    const wrongErr = await captureLoginError();

    const errors = [unknownErr, suspendedErr, lockedErr, wrongErr];
    for (const e of errors) {
      expect(e).toBeInstanceOf(InvalidCredentialsError);
    }
    // Byte-identical client-visible response: same status, code, message, and name.
    const shapes = errors.map((e: any) => ({
      statusCode: e.statusCode,
      errorCode: e.errorCode,
      message: e.message,
      name: e.constructor.name,
    }));
    const first = JSON.stringify(shapes[0]);
    for (const s of shapes) {
      expect(JSON.stringify(s)).toBe(first);
    }
    expect(shapes[0]).toEqual({
      statusCode: 401,
      errorCode: 'UNAUTHORIZED',
      message: 'Invalid credentials',
      name: 'InvalidCredentialsError',
    });
  });

  it('preserves the failed-attempt side effect on wrong password (Req 15.2 internal effects)', async () => {
    state.userRow = { ...ACTIVE_USER };
    verifyPasswordMock.mockResolvedValue(false);
    await expect(captureLoginError()).resolves.toBeInstanceOf(InvalidCredentialsError);
    // failed_attempts increment UPDATE was issued.
    expect(runMock).toHaveBeenCalled();
  });

  it('maps a verification rejection to the generic failure and rolls back without crashing (Req 14.5, 15.5)', async () => {
    state.userRow = { ...ACTIVE_USER };
    verifyPasswordMock.mockRejectedValue(new Error('bcrypt engine failure'));
    const err = await captureLoginError();
    // The internal bcrypt error is never surfaced; the generic failure is returned instead.
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as Error).message).toBe('Invalid credentials');
    // The login ran inside a transaction (which rolls back on throw).
    expect(transactionSpy).toHaveBeenCalled();
  });

  it('never uses the synchronous bcrypt comparison in the login path (Req 14.4)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, '../AuthService.ts'), 'utf8');
    expect(source).not.toMatch(/compareSync/);
  });
});

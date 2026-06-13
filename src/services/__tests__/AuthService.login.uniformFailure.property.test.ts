// @vitest-environment node
// Feature: backend-security-hardening, Property 23: Uniform login failure response
// Task 8.4 — Property test for uniform login failure response (Validates: Requirements 15.2, 15.3)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 23: Uniform login failure response (Validates: Requirements 15.2, 15.3)
 *
 * For ANY failure condition — unknown account, wrong password, suspended account, or locked
 * account — `AuthService.login` must produce a byte-for-byte identical client-visible failure:
 * the same status code, error code, message, and error type (an `InvalidCredentialsError`).
 *
 * The `db` wrapper and `passwordVerifier` are mocked (mirroring the pattern in
 * AuthService.login.test.ts) so each iteration can deterministically drive one of the four
 * failure conditions selected at random by fast-check.
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

const BASE_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'alice',
  email: 'alice@example.com',
  password: '$2b$12$realhashvalueplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  status: 'active',
  locked_until: null,
  failed_attempts: 0,
  role: 'admin',
  name: 'Alice',
};

type FailureCondition = 'unknown' | 'wrong-password' | 'suspended' | 'locked';

/**
 * Configures the mocked db/verifier to drive a specific failure condition, then captures the
 * client-visible failure shape produced by `AuthService.login`.
 */
async function loginFailureShape(
  condition: FailureCondition,
  username: string,
  password: string,
): Promise<{ instance: unknown; statusCode: unknown; errorCode: unknown; message: unknown; name: string }> {
  switch (condition) {
    case 'unknown':
      state.userRow = undefined;
      verifyPasswordMock.mockResolvedValue(false);
      break;
    case 'suspended':
      state.userRow = { ...BASE_USER, status: 'Suspended' };
      // Even a correct password must not leak that the account is suspended.
      verifyPasswordMock.mockResolvedValue(true);
      break;
    case 'locked':
      state.userRow = { ...BASE_USER, locked_until: new Date(Date.now() + 60_000).toISOString() };
      verifyPasswordMock.mockResolvedValue(true);
      break;
    case 'wrong-password':
      state.userRow = { ...BASE_USER };
      verifyPasswordMock.mockResolvedValue(false);
      break;
  }

  try {
    await AuthService.login(username, password, 'jwtSecret', 'PRIVATE_KEY');
    throw new Error('expected login to reject');
  } catch (e: any) {
    return {
      instance: e,
      statusCode: e?.statusCode,
      errorCode: e?.errorCode,
      message: e?.message,
      name: e?.constructor?.name,
    };
  }
}

// The single canonical client-visible failure shape every condition must produce.
const EXPECTED_SHAPE = {
  statusCode: 401,
  errorCode: 'UNAUTHORIZED',
  message: 'Invalid credentials',
  name: 'InvalidCredentialsError',
};

describe('AuthService.login — Property 23: uniform login failure response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userRow = null;
    state.settings = { failed_login_threshold: 5 };
    verifyPasswordMock.mockResolvedValue(false);
  });

  it('produces a byte-identical generic failure for every failure condition (Req 15.2, 15.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.constantFrom<FailureCondition>('unknown', 'wrong-password', 'suspended', 'locked'),
        async (username, password, condition) => {
          vi.clearAllMocks();
          state.settings = { failed_login_threshold: 5 };

          const shape = await loginFailureShape(condition, username, password);

          // Same error type across all conditions.
          expect(shape.instance).toBeInstanceOf(InvalidCredentialsError);
          // Byte-for-byte identical client-visible response (status, code, message, type).
          expect({
            statusCode: shape.statusCode,
            errorCode: shape.errorCode,
            message: shape.message,
            name: shape.name,
          }).toEqual(EXPECTED_SHAPE);
        },
      ),
      { numRuns: 100 },
    );
  });
});

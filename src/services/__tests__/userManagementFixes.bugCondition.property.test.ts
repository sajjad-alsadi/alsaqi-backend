// @vitest-environment node
/**
 * Spec: user-management-fixes — Task 1: Bug Condition Exploration Tests
 *
 * Property 1: Bug Condition — Operations Conform to Schema and Policy.
 * Validates: Requirements 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.14,
 *            2.16, 2.17, 2.18, 2.20, 2.21, 2.22, 2.24, 2.25
 *
 * These tests encode the EXPECTED (correct) behavior for each defect class and are
 * intended to FAIL on the UNFIXED code — each failure surfaces a counterexample that
 * confirms the defect documented in design.md `isBugCondition(input)`.
 *
 * Scoped PBT approach: each defect is pinned to its concrete buggy condition while
 * benign companion inputs (ids, statuses, payload values) are generated with fast-check.
 *
 * The `db` wrapper is mocked with a recording mock that logs every statement's SQL,
 * method, and bound arguments so the tests can assert on the operations performed —
 * mirroring the existing `AuthService.lockoutNotificationCount.property.test.ts` style.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// ─── Recording mock DB ─────────────────────────────────────────────────────────

const { dbState } = vi.hoisted(() => ({
  dbState: {
    log: [] as Array<{ sql: string; method: 'get' | 'all' | 'run'; args: any[] }>,
    responder: null as null | ((sql: string, method: string, args: any[]) => any),
  },
}));

vi.mock('../../db/index', () => {
  const db = {
    isExternal: false,
    prepare(sql: string) {
      const exec = (method: 'get' | 'all' | 'run') => async (...args: any[]) => {
        dbState.log.push({ sql, method, args });
        const r = dbState.responder ? dbState.responder(sql, method, args) : undefined;
        if (r !== undefined) return r;
        return method === 'all' ? [] : method === 'get' ? null : { changes: 1, lastInsertRowid: 'new-id' };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) {
      return fn();
    },
  };
  return { db };
});

vi.mock('bcryptjs', () => ({
  default: {
    hashSync: vi.fn(() => 'hashed_pw'),
    compareSync: vi.fn(() => false),
    hash: vi.fn(async () => 'hashed_pw'),
    compare: vi.fn(async () => false),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(() => 'signed.jwt.token'),
    decode: vi.fn(() => ({ rememberMe: false })),
    verify: vi.fn(() => ({})),
  },
}));

vi.mock('../../utils/n8nService', () => ({
  N8nService: { sendEvent: vi.fn(async () => undefined) },
}));

// PasswordService imports invalidateUserCache from middleware/auth (heavy module).
vi.mock('../../middleware/auth', () => ({
  invalidateUserCache: vi.fn(async () => undefined),
}));

const { verifyPasswordMock } = vi.hoisted(() => ({ verifyPasswordMock: vi.fn(async () => false) }));
vi.mock('../passwordVerifier', () => ({
  verifyPassword: verifyPasswordMock,
  DUMMY_HASH: 'DUMMY_HASH_VALUE',
  bcryptCostFactor: () => 12,
}));

const { invalidateMock } = vi.hoisted(() => ({ invalidateMock: vi.fn(async () => undefined) }));
vi.mock('../AuthCacheInvalidator', () => ({
  AuthCacheInvalidator: {
    invalidate: invalidateMock,
    shouldForceRead: () => false,
    clearForceRead: () => undefined,
    _reset: () => undefined,
  },
}));

// Force Magika to be unavailable so SecurityService.validateFileSafety hits its fail path.
vi.mock('magika/node', () => ({
  MagikaNode: { create: vi.fn(async () => { throw new Error('magika unavailable'); }) },
}));

import { UserService } from '../UserService';
import { AuthService } from '../AuthService';
import { SessionService } from '../SessionService';
import { RoleService } from '../RoleService';
import { SettingsService } from '../SettingsService';
import { PasswordService } from '../PasswordService';
import { SecurityService } from '../SecurityService';
import { InvalidCredentialsError, AuthError, ValidationError } from '../../utils/errors';

const USER_STATUS_ALLOWED = ['Active', 'Inactive', 'Suspended'];
const SESSION_STATUS_ALLOWED = ['Active', 'Terminated', 'Expired'];

function resetDb(responder: ((sql: string, method: string, args: any[]) => any) | null = null) {
  dbState.log = [];
  dbState.responder = responder;
}

function runSqls() {
  return dbState.log.filter((e) => e.method === 'run').map((e) => e.sql);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDb(null);
  verifyPasswordMock.mockResolvedValue(false);
});

describe('Property 1: Bug Condition exploration (user-management-fixes)', () => {
  // ── 1.1 Archive constraint (Req 2.1) ──────────────────────────────────────
  it('1.1 setStatus persists a schema-permitted users.status (not Archived)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        resetDb((sql) => {
          if (sql.includes('SELECT username FROM users')) return { username: 'archtarget' };
          return undefined;
        });
        await UserService.setStatus(userId, 'Archived');
        const update = dbState.log.find((e) => e.method === 'run' && /UPDATE users SET status/.test(e.sql));
        expect(update, 'a status UPDATE should have run').toBeTruthy();
        // Expected (correct): the persisted status must satisfy the users.status CHECK constraint.
        expect(USER_STATUS_ALLOWED).toContain(update!.args[0]);
      }),
      { numRuns: 15 },
    );
  });

  // ── 1.2 Inactive login (Req 2.2) ──────────────────────────────────────────
  it('1.2 login rejects an Inactive user (consistent with auth middleware)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (username) => {
        resetDb((sql) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
            return {
              id: 'u-inactive',
              username,
              email: `${username}@x.com`,
              password: '$2b$12$hash',
              status: 'Inactive',
              locked_until: null,
              session_version: 1,
              role: 'Viewer',
              name: 'Inactive User',
            };
          }
          return undefined;
        });
        verifyPasswordMock.mockResolvedValue(true); // correct password
        // Expected (correct): an Inactive account must NOT authenticate.
        await expect(
          AuthService.login(username, 'correct-pw', 'secret', 'PRIVATE_KEY', '203.0.113.1'),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }),
      { numRuns: 15 },
    );
  });

  // ── 1.4 Session termination must revoke access tokens (Req 2.4) ───────────
  it('1.4 terminateSession increments users.session_version so access tokens stop authenticating', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (sessionId) => {
        resetDb((sql) => {
          if (sql.includes('user_id') && sql.includes('user_sessions')) return { user_id: 'u-1' };
          return undefined;
        });
        await SessionService.terminateSession(sessionId);
        const bumped = runSqls().some((s) => /session_version\s*=\s*session_version\s*\+\s*1/.test(s));
        // Expected (correct): terminating a session revokes its access token via a version bump.
        expect(bumped, 'terminateSession should bump session_version').toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  it('1.4 logoutAll increments users.session_version', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        resetDb(null);
        await SessionService.logoutAll(userId);
        const bumped = runSqls().some((s) => /session_version\s*=\s*session_version\s*\+\s*1/.test(s));
        expect(bumped, 'logoutAll should bump session_version').toBe(true);
      }),
      { numRuns: 10 },
    );
  });

  // ── 1.5 Refresh after suspend / stale version (Req 2.5) ───────────────────
  it('1.5 refresh rejects a suspended user and issues no new tokens', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 10, maxLength: 40 }), async (rawToken) => {
        resetDb((sql) => {
          if (sql.includes('FROM user_sessions') && sql.includes('refresh_token')) {
            return { id: 's-1', user_id: 'u-1', status: 'Active' };
          }
          if (sql.includes('FROM users WHERE id')) {
            return { id: 'u-1', username: 'sus', role: 'Viewer', status: 'Suspended', session_version: 1 };
          }
          return undefined;
        });
        await expect(
          SessionService.refresh(rawToken, 'secret', 'PRIVATE_KEY'),
        ).rejects.toBeInstanceOf(AuthError);
      }),
      { numRuns: 15 },
    );
  });

  it('1.5 refresh rejects when token session_version is stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 40 }),
        fc.integer({ min: 1, max: 5 }),
        async (rawToken, userVersion) => {
          const jwt = (await import('jsonwebtoken')).default as any;
          jwt.decode.mockReturnValue({ rememberMe: false, session_version: userVersion + 1 });
          resetDb((sql) => {
            if (sql.includes('FROM user_sessions') && sql.includes('refresh_token')) {
              return { id: 's-1', user_id: 'u-1', status: 'Active' };
            }
            if (sql.includes('FROM users WHERE id')) {
              return { id: 'u-1', username: 'a', role: 'Viewer', status: 'Active', session_version: userVersion };
            }
            return undefined;
          });
          await expect(
            SessionService.refresh(rawToken, 'secret', 'PRIVATE_KEY'),
          ).rejects.toBeInstanceOf(AuthError);
        },
      ),
      { numRuns: 15 },
    );
  });

  // ── 1.6 Admin reset must revoke refresh tokens (Req 2.6) ──────────────────
  it('1.6 admin resetPassword revokes refresh_tokens / user_sessions', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.string({ minLength: 8, maxLength: 16 }), async (userId, pw) => {
        resetDb((sql) => {
          if (sql.includes('SELECT username FROM users')) return { username: 'resettarget' };
          return undefined;
        });
        await UserService.resetPassword(userId, pw + 'Aa1!');
        const sqls = runSqls();
        const revokesRefresh = sqls.some((s) => /refresh_tokens/.test(s));
        const revokesSessions = sqls.some((s) => /user_sessions/.test(s));
        // Expected (correct): an admin reset invalidates outstanding refresh credentials/sessions.
        expect(revokesRefresh || revokesSessions, 'reset should revoke refresh_tokens or user_sessions').toBe(true);
      }),
      { numRuns: 15 },
    );
  });

  // ── 1.7 Admin password change must bump session_version (Req 2.7) ─────────
  it('1.7 updateUser with a password increments session_version', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        resetDb((sql) => {
          if (sql.includes('SELECT * FROM users WHERE id')) {
            return { id: userId, username: 'u', role: 'Viewer', status: 'Active' };
          }
          if (sql.includes('FROM roles WHERE name')) return { id: 'role-1' };
          return undefined;
        });
        await UserService.updateUser(userId, {
          name: 'N', email: 'n@x.com', role: 'Viewer', password: 'NewPass1!', status: 'Active',
        });
        const pwUpdate = dbState.log.find(
          (e) => e.method === 'run' && /UPDATE users/.test(e.sql) && /password/.test(e.sql),
        );
        expect(pwUpdate, 'a password UPDATE should have run').toBeTruthy();
        expect(/session_version\s*=\s*session_version\s*\+\s*1/.test(pwUpdate!.sql)).toBe(true);
      }),
      { numRuns: 15 },
    );
  });

  // ── 1.8 Role-permission update must invalidate cache (Req 2.8) ────────────
  it('1.8 RoleService.updateRolePermissions invalidates affected users via AuthCacheInvalidator', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.array(fc.uuid(), { maxLength: 4 }), async (roleId, permIds) => {
        invalidateMock.mockClear();
        resetDb((sql) => {
          if (sql.includes('SELECT id FROM users') && sql.includes('role_id')) {
            return [{ id: 'u-a' }, { id: 'u-b' }];
          }
          return undefined;
        });
        await RoleService.updateRolePermissions(roleId, permIds);
        // Expected (correct): changing a role's permissions invalidates affected users' auth cache.
        expect(invalidateMock).toHaveBeenCalled();
      }),
      { numRuns: 10 },
    );
  });

  // ── 1.10 Deny overrides ignored (Req 2.10) ────────────────────────────────
  it('1.10 getUserById permission query accounts for is_allowed = 0 deny overrides', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users u') && sql.includes('WHERE u.id')) {
        return { id: 'u-1', role: 'Viewer', role_id: 'role-1', status: 'Active' };
      }
      return undefined;
    });
    await UserService.getUserById('u-1');
    const permQuery = dbState.log.find((e) => e.method === 'all' && /role_permissions/.test(e.sql) && /user_permissions/.test(e.sql));
    expect(permQuery, 'a permissions query should have run').toBeTruthy();
    // Expected (correct): effective permissions subtract deny overrides (is_allowed = 0),
    // matching PermissionService.getUserPermissions. The buggy query only unions is_allowed = 1.
    const handlesDeny = /is_allowed\s*=\s*0/.test(permQuery!.sql) || /EXCEPT/i.test(permQuery!.sql);
    expect(handlesDeny, 'permission resolution must consider deny overrides').toBe(true);
  });

  // ── 1.11 Admin password policy bypass (Req 2.11) ──────────────────────────
  it('1.11 admin resetPassword enforces the configured password policy', async () => {
    resetDb((sql) => {
      if (sql.includes('SELECT username FROM users')) return { username: 'weakpwuser' };
      if (sql.includes('user_management_settings')) {
        return {
          password_min_length: 8,
          password_require_uppercase: 1,
          password_require_lowercase: 1,
          password_require_numbers: 1,
          password_require_symbols: 1,
        };
      }
      return undefined;
    });
    // A clearly policy-violating password (too short, no upper/number/symbol).
    await expect(UserService.resetPassword('u-1', 'abc')).rejects.toBeInstanceOf(ValidationError);
  });

  // ── 1.14 enforce_single_session not enforced at login (Req 2.14) ──────────
  it('1.14 login terminates other active sessions when enforce_single_session is enabled', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
        return {
          id: 'u-1', username: 'solo', email: 'solo@x.com', password: '$2b$12$hash',
          status: 'Active', locked_until: null, session_version: 1, role: 'Viewer', name: 'Solo',
        };
      }
      if (sql.includes('enforce_single_session') || sql.includes('user_management_settings')) {
        return { enforce_single_session: 1, password_expiry_days: 0 };
      }
      return undefined;
    });
    verifyPasswordMock.mockResolvedValue(true);
    await AuthService.login('solo', 'correct-pw', 'secret', 'PRIVATE_KEY', '203.0.113.2');
    // Expected (correct): with single-session enforcement, other active sessions are terminated.
    const terminatesOthers = dbState.log.some(
      (e) => e.method === 'run' && /UPDATE user_sessions/.test(e.sql) && /Terminated/.test(e.sql),
    );
    expect(terminatesOthers, 'login should terminate other active sessions').toBe(true);
  });

  // ── 1.16 Settings not fully persisted (Req 2.16) ──────────────────────────
  it('1.16 updateUserManagementSettings persists bulk_import_enabled and admin_approval_required', async () => {
    resetDb((sql) => {
      if (sql.includes('SELECT 1 FROM user_management_settings')) return { '1': 1 };
      return undefined;
    });
    await SettingsService.updateUserManagementSettings({
      failed_login_threshold: 3,
      inactive_account_threshold_days: 90,
      password_min_length: 8,
      session_timeout_minutes: 30,
      bulk_import_enabled: 0,
      admin_approval_required: 1,
    });
    const write = dbState.log.find(
      (e) => e.method === 'run' && /user_management_settings/.test(e.sql) && /(UPDATE|INSERT)/.test(e.sql),
    );
    expect(write, 'a settings write should have run').toBeTruthy();
    expect(/bulk_import_enabled/.test(write!.sql), 'must persist bulk_import_enabled').toBe(true);
    expect(/admin_approval_required/.test(write!.sql), 'must persist admin_approval_required').toBe(true);
  });

  // ── 1.17 Lockout uses stale count (Req 2.17) ──────────────────────────────
  it('1.17 lockout decision uses the authoritative post-increment failed-attempt count', async () => {
    const THRESHOLD = 5;
    resetDb((sql, method) => {
      if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
        // In-memory snapshot reads a stale low count (0) — e.g. a concurrent attempt.
        return {
          id: 'u-1', username: 'race', email: 'race@x.com', password: '$2b$12$hash',
          status: 'Active', locked_until: null, session_version: 1, role: 'Viewer', name: 'Race', failed_attempts: 0,
        };
      }
      if (sql.includes('failed_login_threshold')) return { failed_login_threshold: THRESHOLD };
      // The authoritative increment reflects concurrent attempts having reached the threshold.
      if (method === 'run' && /failed_attempts\s*=\s*failed_attempts\s*\+\s*1/.test(sql)) {
        return { changes: 1, failed_attempts: THRESHOLD, rows: [{ failed_attempts: THRESHOLD }] };
      }
      return undefined;
    });
    verifyPasswordMock.mockResolvedValue(false); // wrong password drives handleFailedLogin
    await expect(
      AuthService.login('race', 'wrong-pw', 'secret', 'PRIVATE_KEY', '203.0.113.9'),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    // Expected (correct): the account is locked based on the authoritative post-increment count.
    const locked = runSqls().some((s) => /locked_until\s*=\s*\?/.test(s));
    expect(locked, 'account should be locked using authoritative count').toBe(true);
  });

  // ── 1.18 Duplicate employee_id under concurrency (Req 2.18) ───────────────
  it('1.18 createUser generates unique employee_id even when two reads see the same latest', async () => {
    const responder = (sql: string) => {
      if (sql.includes('SELECT id FROM users WHERE username')) return null; // no existing
      if (sql.includes('FROM roles WHERE name')) return { id: 'role-1' };
      if (sql.includes('org_entities')) return null;
      if (sql.includes('SELECT employee_id FROM users')) return [{ employee_id: 'EMP-1001' }]; // stale latest, same for both (.all() returns an array)
      return undefined;
    };
    const base = {
      username: 'u', password: 'Pass1!aa', name: 'N', email: 'n@x.com',
      department: null, job_title_id: null, role: 'Viewer', unit: null,
      reporting_manager_id: null, access_scope: null, phone_number: null, notes: null,
    };

    resetDb(responder);
    await UserService.createUser({ ...base, username: 'usera' });
    // The user INSERT now executes via .get() (RETURNING id, task 7.1), not .run().
    const firstInsert = dbState.log.find((e) => /INSERT INTO users/.test(e.sql));
    const firstEmpId = firstInsert!.args[13];

    resetDb(responder);
    await UserService.createUser({ ...base, username: 'userb' });
    const secondInsert = dbState.log.find((e) => /INSERT INTO users/.test(e.sql));
    const secondEmpId = secondInsert!.args[13];

    // Expected (correct): concurrent creations from the same stale read must not collide.
    expect(firstEmpId).not.toBe(secondEmpId);
  });

  // ── 1.20 getResetStatus boolean comparison (Req 2.20) ─────────────────────
  it('1.20 getResetStatus treats a boolean requires_password_change=false as no-change', async () => {
    resetDb((sql) => {
      if (sql.includes('requires_password_change FROM users')) {
        return { id: 'u-1', requires_password_change: false };
      }
      if (sql.includes('password_reset_requests')) return { status: 'Pending' };
      return undefined;
    });
    const status = await PasswordService.getResetStatus('someone');
    // Expected (correct): a falsy requires_password_change resolves to 'None'.
    expect(status).toBe('None');
  });

  // ── 1.21 File-safety fail-open (Req 2.21) ─────────────────────────────────
  it('1.21 validateFileSafety fails closed when the content identifier is unavailable', async () => {
    const buffer = Buffer.from('%PDF-1.4 fake');
    const result = await SecurityService.validateFileSafety(buffer, '.pdf', ['application/pdf']);
    // Expected (correct): when identification is unavailable, the file is NOT silently accepted.
    expect(result).toBe(false);
  });

  // ── 1.22 Role constant interpolated into SQL (Req 2.22) ───────────────────
  it('1.22 getUserSummary binds the admin role as a parameter (no interpolated literal)', async () => {
    resetDb((sql) => {
      if (/COUNT/.test(sql)) return { count: 0 };
      return undefined;
    });
    await UserService.getUserSummary();
    const adminQuery = dbState.log.find((e) => /FROM users WHERE role/.test(e.sql) && /Admin/.test(e.sql + JSON.stringify(e.args)));
    // The buggy code interpolates: WHERE role = 'Admin'. The fixed code binds: WHERE role = ?
    const interpolated = dbState.log.find((e) => /WHERE role\s*=\s*'Admin'/.test(e.sql));
    expect(interpolated, 'admin role must be a bound parameter, not interpolated').toBeUndefined();
  });

  it('1.22 PasswordService.requestReset binds the admin role as a parameter', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users WHERE LOWER(username)')) return { id: 'u-1', username: 'a', name: 'A', department: 'IT' };
      if (sql.includes('password_reset_requests') && sql.includes('SELECT id')) return null;
      return undefined;
    });
    await PasswordService.requestReset('a');
    const interpolated = dbState.log.find((e) => /WHERE role\s*=\s*'Admin'/.test(e.sql));
    expect(interpolated, 'admin role must be a bound parameter, not interpolated').toBeUndefined();
  });

  // ── 1.24 Logout writes a non-schema status (Req 2.24) ─────────────────────
  it('1.24 logout terminates the session with a schema-permitted user_sessions.status', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 10, maxLength: 40 }), async (rawToken) => {
        resetDb((sql) => {
          if (sql.includes('SELECT user_id FROM user_sessions')) return { user_id: 'u-1' };
          if (sql.includes('SELECT username FROM users')) return { username: 'logouttarget' };
          return undefined;
        });
        await SessionService.logout(rawToken);
        const statusWrite = dbState.log.find(
          (e) => e.method === 'run' && /UPDATE user_sessions SET status/.test(e.sql),
        );
        expect(statusWrite, 'a session status UPDATE should have run').toBeTruthy();
        // The buggy code writes 'LoggedOut', violating the user_sessions.status CHECK.
        const m = statusWrite!.sql.match(/SET status\s*=\s*'([^']+)'/);
        const literal = m ? m[1] : statusWrite!.args[0];
        expect(SESSION_STATUS_ALLOWED).toContain(literal);
      }),
      { numRuns: 15 },
    );
  });

  // ── 1.25 Session listing leaks refresh_token (Req 2.25) ───────────────────
  it('1.25 getActiveSessions does not select s.* (excludes refresh_token)', async () => {
    resetDb(null);
    await SessionService.getActiveSessions();
    const listQuery = dbState.log.find((e) => e.method === 'all' && /FROM user_sessions/.test(e.sql));
    expect(listQuery, 'an active-sessions query should have run').toBeTruthy();
    // Expected (correct): explicit non-sensitive projection, never `SELECT s.*` (which includes refresh_token).
    expect(/SELECT\s+s\.\*/i.test(listQuery!.sql), 'must not SELECT s.* in session listing').toBe(false);
    expect(/refresh_token/.test(listQuery!.sql), 'must not project refresh_token').toBe(false);
  });
});

// @vitest-environment node
/**
 * Spec: user-management-fixes — Task 2: Preservation Property Tests (service layer)
 *
 * Property 11: Preservation — Non-Buggy Inputs Unchanged.
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.9, 3.10, 3.11, 3.12, 3.13
 *
 * Observation-first methodology: every assertion in this file captures behavior that was
 * OBSERVED on the UNFIXED code for inputs where `isBugCondition(input)` is false. These tests
 * MUST PASS on the unfixed code — they lock in the baseline behavior that the fix must preserve
 * (`F(X) = F'(X)` for all non-buggy `X`). They are intentionally written to assert only the
 * non-buggy, must-not-change aspects and to avoid asserting any of the documented defects.
 *
 * The `db` wrapper is mocked with a recording mock that logs every statement's SQL, method, and
 * bound arguments — mirroring the task 1 exploration tests and the existing
 * `AuthService.lockoutNotificationCount.property.test.ts` style. The refresh-token hashing
 * primitive is left REAL so the "hashed, never plaintext" preservation can be checked exactly.
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
        // The real db wrapper returns `undefined` (not null) for a missing row; match that so
        // callers using `result !== undefined` guards (e.g. PermissionService.resolvePermission)
        // behave as they do in production.
        return method === 'all' ? [] : method === 'get' ? undefined : { changes: 1, lastInsertRowid: 'new-id' };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) {
      return fn();
    },
  };
  return { db };
});

// bcryptjs is used directly by PasswordService (compareSync/hashSync).
const { bcryptMock } = vi.hoisted(() => ({
  bcryptMock: {
    hashSync: vi.fn(() => 'hashed_pw'),
    compareSync: vi.fn(() => false),
    compare: vi.fn(async () => false),
  },
}));
vi.mock('bcryptjs', () => ({ default: bcryptMock }));

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

// PasswordService imports invalidateUserCache from middleware/auth (heavy module) — mock it
// so the self-service cache-invalidation preservation can be asserted directly.
const { invalidateUserCacheMock } = vi.hoisted(() => ({ invalidateUserCacheMock: vi.fn(async () => undefined) }));
vi.mock('../../middleware/auth', () => ({
  invalidateUserCache: invalidateUserCacheMock,
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

// Register the permission modules so PermissionService.hasPermission resolves real modules.
import '../../permissions/modules';

import { AuthService } from '../AuthService';
import { SessionService } from '../SessionService';
import { SettingsService } from '../SettingsService';
import { PasswordService } from '../PasswordService';
import { PermissionService } from '../PermissionService';
import { hashRefreshToken } from '../refreshTokenHash';
import { InvalidCredentialsError, ValidationError } from '../../utils/errors';

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
  bcryptMock.compareSync.mockReturnValue(false);
  // Clear the real permission cache between cases so deterministic resolution is observed.
  PermissionService.invalidateCache();
});

describe('Property 11: Preservation — non-buggy inputs unchanged (user-management-fixes)', () => {
  // ── 3.1 Valid Active login issues access + refresh tokens ──────────────────
  it('3.1 a valid Active-user login (no 2FA / no required setup) issues access and refresh tokens', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (username) => {
        resetDb((sql) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
            return {
              id: 'u-active',
              username,
              email: `${username}@x.com`,
              password: '$2b$12$hash',
              status: 'Active',
              locked_until: null,
              session_version: 1,
              role: 'Viewer',
              name: 'Active User',
              requires_password_change: 0,
              password_last_changed: null,
            };
          }
          return undefined;
        });
        verifyPasswordMock.mockResolvedValue(true); // correct password, non-buggy input

        const result = await AuthService.login(username, 'correct-pw', 'secret', 'PRIVATE_KEY', '203.0.113.1');

        expect(result.token, 'access token issued').toBeTruthy();
        expect(result.refreshToken, 'refresh token issued').toBeTruthy();
        expect(result.user.id).toBe('u-active');
        // The refresh credential is persisted (preserved baseline behavior).
        const inserted = runSqls().some((s) => /INSERT INTO refresh_tokens/.test(s));
        expect(inserted, 'a refresh token row is persisted on login').toBe(true);
      }),
      { numRuns: 15 },
    );
  });

  // ── 3.2 Admin bypasses the DB permission check ─────────────────────────────
  it('3.2 an Admin user is allowed without any DB permission lookup', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('UserManagement', 'Settings', 'Reports'),
        fc.constantFrom('View', 'Edit'),
        async (module, action) => {
          PermissionService.invalidateCache();
          resetDb((sql) => {
            if (sql.includes('SELECT id, role, role_id FROM users')) {
              return { id: 'admin-1', role: 'Admin', role_id: 'role-admin' };
            }
            return undefined;
          });
          const allowed = await PermissionService.hasPermission('admin-1', module, action);
          expect(allowed, 'Admin is allowed').toBe(true);
          // Admin bypass performs no role/user permission lookup (preserved baseline).
          const didPermLookup = dbState.log.some(
            (e) => /role_permissions/.test(e.sql) || /user_permissions/.test(e.sql),
          );
          expect(didPermLookup, 'Admin bypass does not query permissions').toBe(false);
        },
      ),
      { numRuns: 12 },
    );
  });

  // ── 3.3 Non-admin with a granting role permission (no deny override) allowed ─
  it('3.3 a non-admin with a granting role permission and no deny override is allowed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (userId) => {
        PermissionService.invalidateCache();
        resetDb((sql) => {
          if (sql.includes('SELECT id, role, role_id FROM users')) {
            return { id: userId, role: 'Viewer', role_id: 'role-viewer' };
          }
          // No user-level override exists (non-buggy: no conflicting deny).
          if (sql.includes('user_permissions') && sql.includes('is_allowed')) return undefined;
          // A matching role permission grant exists.
          if (sql.includes('role_permissions')) return { 1: 1 };
          return undefined;
        });
        const allowed = await PermissionService.hasPermission(userId, 'Dashboard', 'View');
        expect(allowed, 'granting role permission allows the action').toBe(true);
      }),
      { numRuns: 12 },
    );
  });

  // ── 3.4 Self-service password change: policy, reuse, version bump, cache ─────
  it('3.4 self-service changePassword with a compliant password bumps session_version and invalidates cache', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users WHERE id') && sql.includes('session_version')) {
        return { id: 'u-1', password: 'old_hash', session_version: 3, username: 'self', role: 'Viewer' };
      }
      if (sql.includes('user_management_settings')) {
        return {
          password_min_length: 8,
          password_require_uppercase: 1,
          password_require_lowercase: 1,
          password_require_numbers: 1,
          password_require_symbols: 1,
        };
      }
      if (sql.includes('password_history')) return []; // no prior passwords
      return undefined;
    });
    bcryptMock.compareSync.mockReturnValue(false); // not same as current, not reused

    await PasswordService.changePassword('u-1', 'CompliantPass1!');

    const bumped = runSqls().some((s) => /session_version\s*=\s*session_version\s*\+\s*1/.test(s));
    expect(bumped, 'changePassword bumps session_version').toBe(true);
    expect(invalidateUserCacheMock, 'changePassword invalidates cached auth state').toHaveBeenCalledWith('u-1');
  });

  it('3.4 self-service changePassword rejects reuse of a recent password', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users WHERE id') && sql.includes('session_version')) {
        return { id: 'u-1', password: 'old_hash', session_version: 3, username: 'self', role: 'Viewer' };
      }
      if (sql.includes('user_management_settings')) {
        return {
          password_min_length: 8,
          password_require_uppercase: 1,
          password_require_lowercase: 1,
          password_require_numbers: 1,
          password_require_symbols: 1,
        };
      }
      if (sql.includes('password_history')) return [{ password_hash: 'reused_hash' }];
      return undefined;
    });
    // First compareSync (vs current) false; subsequent (vs history) true → reuse rejected.
    bcryptMock.compareSync.mockReturnValueOnce(false).mockReturnValue(true);

    await expect(PasswordService.changePassword('u-1', 'CompliantPass1!')).rejects.toBeInstanceOf(ValidationError);
  });

  it('3.4 self-service changePassword enforces the configured policy (rejects a non-compliant password)', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users WHERE id') && sql.includes('session_version')) {
        return { id: 'u-1', password: 'old_hash', session_version: 3, username: 'self', role: 'Viewer' };
      }
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
    // Too short and missing character classes — must be rejected by policy.
    await expect(PasswordService.changePassword('u-1', 'ab')).rejects.toBeInstanceOf(ValidationError);
  });

  // ── 3.7 PermissionService changes invalidate caches ────────────────────────
  it('3.7 setUserPermissionOverride invalidates the user cache via the canonical invalidator', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.boolean(), async (userId, allowed) => {
        invalidateMock.mockClear();
        resetDb((sql) => {
          if (sql.includes('SELECT id FROM permissions')) return { id: 'perm-1' };
          if (sql.includes('SELECT 1 FROM user_permissions')) return undefined; // no existing → insert
          return undefined;
        });
        await PermissionService.setUserPermissionOverride(userId, 'UserManagement', 'View', allowed);
        expect(invalidateMock).toHaveBeenCalledWith(userId);
      }),
      { numRuns: 10 },
    );
  });

  it('3.7 updateRolePermissions invalidates affected users via the canonical invalidator', async () => {
    invalidateMock.mockClear();
    resetDb((sql) => {
      if (sql.includes('SELECT id FROM permissions WHERE module')) return { id: 'perm-1' };
      if (sql.includes('SELECT id FROM users WHERE role_id')) return [{ id: 'u-a' }, { id: 'u-b' }];
      return undefined;
    });
    await PermissionService.updateRolePermissions('role-1', [
      { module: 'UserManagement', action: 'View', granted: true } as any,
    ]);
    expect(invalidateMock).toHaveBeenCalledWith('u-a');
    expect(invalidateMock).toHaveBeenCalledWith('u-b');
  });

  // ── 3.9 Single-account non-concurrent lockout locks + notifies admins ──────
  it('3.9 reaching the failed-login threshold locks the account and notifies each active admin', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 2, max: 8 }), async (activeAdmins, threshold) => {
        const admins = Array.from({ length: activeAdmins }, (_, i) => ({ id: `admin-${i}` }));
        let notifications = 0;
        resetDb((sql, method) => {
          if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
            return {
              id: 'u-lock', username: 'victim', email: 'v@x.com', password: '$2b$12$hash',
              status: 'Active', locked_until: null, session_version: 1, role: 'Viewer', name: 'Victim',
              failed_attempts: threshold - 1, // one below threshold → this attempt locks
            };
          }
          if (sql.includes('failed_login_threshold')) return { failed_login_threshold: threshold };
          if (sql.includes('SELECT id FROM users') && sql.includes('role')) return admins;
          if (method === 'run' && /INSERT INTO notifications/.test(sql)) notifications++;
          return undefined;
        });
        verifyPasswordMock.mockResolvedValue(false); // wrong password

        await expect(
          AuthService.login('victim', 'wrong', 'secret', 'PRIVATE_KEY', '203.0.113.9'),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);

        const locked = runSqls().some((s) => /locked_until\s*=\s*\?/.test(s));
        expect(locked, 'account is locked at the threshold').toBe(true);
        expect(notifications, 'one notification per active admin').toBe(activeAdmins);
      }),
      { numRuns: 20 },
    );
  });

  // ── 3.10 Refresh tokens persisted only as hashes, never plaintext ──────────
  it('3.10 login persists the refresh token only as its hash, never the plaintext', async () => {
    resetDb((sql) => {
      if (sql.includes('FROM users') && sql.includes('LOWER(username)')) {
        return {
          id: 'u-1', username: 'hashuser', email: 'h@x.com', password: '$2b$12$hash',
          status: 'Active', locked_until: null, session_version: 1, role: 'Viewer', name: 'Hash',
          requires_password_change: 0, password_last_changed: null,
        };
      }
      return undefined;
    });
    verifyPasswordMock.mockResolvedValue(true);

    await AuthService.login('hashuser', 'correct-pw', 'secret', 'PRIVATE_KEY', '203.0.113.10');

    const plaintext = 'signed.jwt.token'; // mocked jwt.sign output
    const expectedHash = hashRefreshToken(plaintext);
    const refreshInsert = dbState.log.find((e) => e.method === 'run' && /INSERT INTO refresh_tokens/.test(e.sql));
    expect(refreshInsert, 'a refresh_tokens insert ran').toBeTruthy();
    expect(refreshInsert!.args[0], 'stored value is the hash, not plaintext').toBe(expectedHash);
    expect(refreshInsert!.args[0]).not.toBe(plaintext);

    const sessionInsert = dbState.log.find((e) => e.method === 'run' && /INSERT INTO user_sessions/.test(e.sql));
    if (sessionInsert) {
      expect(sessionInsert.args.includes(plaintext), 'session row never stores plaintext token').toBe(false);
    }
  });

  // ── 3.11 Full all-fields settings update persists the provided values ──────
  it('3.11 a full user-management settings update persists the provided values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          failed_login_threshold: fc.integer({ min: 1, max: 10 }),
          inactive_account_threshold_days: fc.integer({ min: 1, max: 365 }),
          password_min_length: fc.integer({ min: 6, max: 32 }),
          session_timeout_minutes: fc.integer({ min: 1, max: 240 }),
          password_require_uppercase: fc.constantFrom(0, 1),
          password_require_lowercase: fc.constantFrom(0, 1),
          password_require_numbers: fc.constantFrom(0, 1),
          password_require_symbols: fc.constantFrom(0, 1),
          password_expiry_days: fc.integer({ min: 0, max: 365 }),
          enforce_single_session: fc.constantFrom(0, 1),
          two_factor_auth: fc.constantFrom(0, 1),
        }),
        async (settings) => {
          resetDb((sql) => {
            if (sql.includes('SELECT 1 FROM user_management_settings')) return { 1: 1 }; // exists → UPDATE
            return undefined;
          });
          await SettingsService.updateUserManagementSettings(settings);
          const write = dbState.log.find(
            (e) => e.method === 'run' && /user_management_settings/.test(e.sql) && /UPDATE/.test(e.sql),
          );
          expect(write, 'a settings UPDATE ran').toBeTruthy();
          // The currently-persisted NOT NULL columns carry the provided values (preserved baseline).
          expect(write!.args[0]).toBe(settings.failed_login_threshold);
          expect(write!.args[1]).toBe(settings.inactive_account_threshold_days);
          expect(write!.args[2]).toBe(settings.password_min_length);
          expect(write!.args[3]).toBe(settings.session_timeout_minutes);
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── 3.12 Logout revokes the matching refresh_tokens row and returns username ─
  it('3.12 logout with a valid refresh token revokes the matching refresh_tokens row and returns the username', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 10, maxLength: 40 }), async (rawToken) => {
        resetDb((sql) => {
          if (sql.includes('SELECT user_id FROM user_sessions')) return { user_id: 'u-1' };
          if (sql.includes('SELECT username FROM users')) return { username: 'logoutuser' };
          return undefined;
        });
        const username = await SessionService.logout(rawToken);
        expect(username, 'logout returns the affected username').toBe('logoutuser');

        const expectedHash = hashRefreshToken(rawToken);
        const revoke = dbState.log.find(
          (e) => e.method === 'run' && /UPDATE refresh_tokens/.test(e.sql) && /is_revoked/.test(e.sql),
        );
        expect(revoke, 'the matching refresh_tokens row is revoked').toBeTruthy();
        // Lookup/match is by hash only, never plaintext (preserved baseline).
        expect(revoke!.args[0]).toBe(expectedHash);
        expect(revoke!.args[0]).not.toBe(rawToken);
      }),
      { numRuns: 15 },
    );
  });

  // ── 3.13 Active-sessions listing keeps display fields, ordered by activity ──
  it('3.13 getActiveSessions returns the existing non-sensitive display fields ordered by most recent activity', async () => {
    resetDb(null);
    await SessionService.getActiveSessions();
    const listQuery = dbState.log.find((e) => e.method === 'all' && /FROM user_sessions/.test(e.sql));
    expect(listQuery, 'an active-sessions query ran').toBeTruthy();
    expect(/user_name/.test(listQuery!.sql), 'includes user_name display field').toBe(true);
    expect(/u\.username/.test(listQuery!.sql), 'includes username display field').toBe(true);
    expect(/WHERE s\.status\s*=\s*'Active'/.test(listQuery!.sql), 'lists Active sessions').toBe(true);
    expect(/ORDER BY s\.last_activity DESC/.test(listQuery!.sql), 'ordered by most recent activity').toBe(true);
  });
});

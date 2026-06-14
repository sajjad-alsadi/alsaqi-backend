// @vitest-environment node
/**
 * Spec: user-management-fixes — Task 2: Preservation Property Tests (route layer)
 *
 * Property 11: Preservation — Non-Buggy Inputs Unchanged.
 * Validates: Requirements 3.5, 3.6, 3.8
 *
 * Observation-first methodology: each assertion locks in behavior OBSERVED on the UNFIXED code
 * for non-buggy inputs and MUST PASS on the unfixed code. The user/auth routers are mounted with
 * supertest; services, cache invalidation, and TOTP are mocked so each route's own logic
 * (action + audit, the password-change gate, and 2FA token issuance) is exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import fc from 'fast-check';

// ─── Mocks for the user-routes dependency graph (3.5) ──────────────────────────

const { userServiceMock, authServiceMock, invalidateMock } = vi.hoisted(() => ({
  userServiceMock: {
    setStatus: vi.fn(async () => 'targetuser'),
    deleteUser: vi.fn(async () => 'targetuser'),
    getStatus: vi.fn(async () => 'Active'),
  },
  authServiceMock: { logAudit: vi.fn(async () => undefined) },
  invalidateMock: vi.fn(async () => undefined),
}));

vi.mock('../../services/UserService', () => ({ UserService: userServiceMock }));
vi.mock('../../services/AuthService', () => ({ AuthService: authServiceMock }));
// Preserve the real middleware exports (notably createAuthMiddlewares, used by the 3.6 gate
// tests) while overriding invalidateUserCache with a mock for the user-route tests.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, invalidateUserCache: invalidateMock };
});

import { createUserRoutes } from '../users';

const authenticate = (req: any, _res: any, next: any) => {
  req.user = { id: 'admin-id', role: 'Admin', username: 'admin', name: 'Admin' };
  next();
};
const checkPermission = () => (_req: any, _res: any, next: any) => next();
const authorize = () => (_req: any, _res: any, next: any) => next();

// A non-admin target user so the last-admin guard does not apply (non-buggy input).
function mockUserDb() {
  return {
    prepare(sql: string) {
      const exec = (method: string) => async (..._args: any[]) => {
        if (sql.includes('SELECT role FROM users')) return method === 'get' ? { role: 'Viewer' } : null;
        return method === 'all' ? [] : method === 'get' ? null : { changes: 1 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) { return fn(); },
  };
}

function buildUserApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/users', createUserRoutes(db, authenticate, authorize, checkPermission, vi.fn()));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMock.mockResolvedValue(undefined);
  authServiceMock.logAudit.mockResolvedValue(undefined);
});

describe('Property 11: Preservation — user routes (user-management-fixes)', () => {
  // ── 3.5 Suspend a non-admin performs the action and writes the audit entry ─
  it('3.5 suspending a non-admin performs the status change and writes an audit entry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (targetId) => {
        userServiceMock.setStatus.mockClear();
        authServiceMock.logAudit.mockClear();
        userServiceMock.getStatus.mockResolvedValue('Active'); // currently Active → suspend
        userServiceMock.setStatus.mockResolvedValue('victim');

        const app = buildUserApp(mockUserDb());
        const res = await request(app).post(`/users/${targetId}/suspend`).send({});

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('Suspended');
        expect(userServiceMock.setStatus).toHaveBeenCalledWith(targetId, 'Suspended');
        expect(authServiceMock.logAudit).toHaveBeenCalled();
      }),
      { numRuns: 12 },
    );
  });

  // ── 3.5 Delete a non-admin performs the action and writes the audit entry ──
  it('3.5 deleting a non-admin performs the deletion and writes an audit entry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (targetId) => {
        userServiceMock.deleteUser.mockClear();
        authServiceMock.logAudit.mockClear();
        userServiceMock.deleteUser.mockResolvedValue('victim');

        const app = buildUserApp(mockUserDb());
        const res = await request(app).delete(`/users/${targetId}`).send({});

        expect(res.status).toBe(200);
        expect(userServiceMock.deleteUser).toHaveBeenCalledWith(targetId);
        expect(authServiceMock.logAudit).toHaveBeenCalled();
      }),
      { numRuns: 12 },
    );
  });
});

// ─── 3.6 requires_password_change middleware gate ──────────────────────────────

// Keep Redis disabled and the cache invalidator inert so the gate logic is exercised directly.
vi.mock('../../cache/redisManager', () => ({
  redisManager: { isAvailable: false, getClient: () => null, get: async () => null, set: async () => undefined },
}));
vi.mock('../../services/AuthCacheInvalidator', () => ({
  AuthCacheInvalidator: {
    invalidate: vi.fn(async () => undefined),
    shouldForceRead: () => false,
    clearForceRead: () => undefined,
  },
}));

const { gateDbState } = vi.hoisted(() => ({ gateDbState: { requiresChange: 1 } }));

import jwt from 'jsonwebtoken';
import { createAuthMiddlewares } from '../../middleware/auth';

function buildGateApp() {
  // db returns a user whose requires_password_change reflects the gate state.
  const db: any = {
    prepare(_sql: string) {
      return {
        get: async (..._args: any[]) => ({
          id: 'u-1', role: 'Viewer', status: 'Active', username: 'u', name: 'U', email: 'u@x.com',
          session_version: 1, requires_password_change: gateDbState.requiresChange, department_id: null,
        }),
        all: async () => [],
        run: async () => ({ changes: 1 }),
      };
    },
  };
  const { authenticate: realAuth } = createAuthMiddlewares(db, 'SECRET', 'PUBLIC');
  const app = express();
  app.use(cookieParser());
  app.use(realAuth as any);
  // Mount a few representative routes; the gate runs inside authenticate.
  app.get('/session', (_req, res) => res.json({ ok: true }));
  app.get('/change-password', (_req, res) => res.json({ ok: true }));
  app.get('/users', (_req, res) => res.json({ ok: true }));
  app.get('/reports', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Property 11: Preservation — requires_password_change gate (3.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateDbState.requiresChange = 1;
    vi.spyOn(jwt, 'verify').mockReturnValue({ id: 'u-1', session_version: 1 } as any);
  });

  it('3.6 a gated user reaching a password-resolution path is allowed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('/session', '/change-password'), async (path) => {
        gateDbState.requiresChange = 1;
        const app = buildGateApp();
        const res = await request(app).get(path).set('Cookie', ['token=valid']);
        expect(res.status, `${path} should be allowed while a change is required`).toBe(200);
      }),
      { numRuns: 8 },
    );
  });

  it('3.6 a gated user reaching a non-allowed path is blocked with PASSWORD_CHANGE_REQUIRED', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('/users', '/reports'), async (path) => {
        gateDbState.requiresChange = 1;
        const app = buildGateApp();
        const res = await request(app).get(path).set('Cookie', ['token=valid']);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      }),
      { numRuns: 8 },
    );
  });

  it('3.6 a user that does not require a change reaches any path normally', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('/users', '/reports', '/session'), async (path) => {
        gateDbState.requiresChange = 0;
        const app = buildGateApp();
        const res = await request(app).get(path).set('Cookie', ['token=valid']);
        expect(res.status).toBe(200);
      }),
      { numRuns: 8 },
    );
  });
});

// ─── 3.8 Valid TOTP / backup code on the 2FA path issues full tokens ───────────

const { totpMock, twoFaDbCalls } = vi.hoisted(() => ({
  totpMock: { isEnabled: vi.fn(async () => true), verify: vi.fn(async () => true), useBackupCode: vi.fn(async () => true) },
  twoFaDbCalls: { log: [] as Array<{ sql: string; method: string; args: any[] }> },
}));

vi.mock('../../services/TOTPService', () => ({ totpService: totpMock }));
vi.mock('../../middleware/csrf', () => ({ generateCsrfToken: () => 'csrf', attachCsrfToken: () => undefined }));
vi.mock('../../services/refreshCookiePath', () => ({ getRefreshCookiePath: () => '/api/v1/auth/refresh' }));
vi.mock('../../db/index', () => ({
  db: {
    prepare(sql: string) {
      const exec = (method: string) => async (...args: any[]) => {
        twoFaDbCalls.log.push({ sql, method, args });
        return method === 'all' ? [] : method === 'get'
          ? { id: 'u-1', username: 'u', role: 'Viewer', name: 'U', email: 'u@x.com', session_version: 1 }
          : { changes: 1 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) { return fn(); },
  },
}));

import { createTwoFactorRoutes } from '../auth/twoFactor';

function buildTwoFaApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createTwoFactorRoutes('PUB', 'PUB', 'PRIV', (_q: any, _r: any, n: any) => n(), vi.fn()));
  return app;
}

describe('Property 11: Preservation — 2FA path issues full tokens (3.8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    twoFaDbCalls.log = [];
    vi.spyOn(jwt, 'verify').mockReturnValue({ id: 'u-1', username: 'u', type: '2fa_pending' } as any);
    vi.spyOn(jwt, 'sign').mockReturnValue('signed.jwt.token' as any);
  });

  it('3.8 a valid TOTP code completes login and issues full tokens', async () => {
    totpMock.verify.mockResolvedValue(true);
    const app = buildTwoFaApp();
    const res = await request(app).post('/auth/2fa/validate').send({ tempToken: 'temp', token: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.token, 'a full access token is issued').toBeTruthy();
    expect(res.body.user?.id).toBe('u-1');
    const persisted = twoFaDbCalls.log.some((e) => e.method === 'run' && /INSERT INTO refresh_tokens/.test(e.sql));
    expect(persisted, 'a refresh token row is persisted').toBe(true);
  });

  it('3.8 a valid backup code completes login and issues full tokens', async () => {
    totpMock.useBackupCode.mockResolvedValue(true);
    const app = buildTwoFaApp();
    const res = await request(app).post('/auth/2fa/backup').send({ tempToken: 'temp', code: 'backup-code' });
    expect(res.status).toBe(200);
    expect(res.body.token, 'a full access token is issued').toBeTruthy();
    expect(res.body.user?.id).toBe('u-1');
  });
});

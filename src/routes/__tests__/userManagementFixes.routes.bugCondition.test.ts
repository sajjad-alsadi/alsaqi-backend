// @vitest-environment node
/**
 * Spec: user-management-fixes — Task 1: Bug Condition Exploration Tests (route layer)
 *
 * Property 1: Bug Condition — Operations Conform to Schema and Policy.
 * Validates: Requirements 2.3, 2.9, 2.12, 2.13, 2.15, 2.19
 *
 * These tests encode the EXPECTED (correct) behavior for route-layer defect classes and
 * are intended to FAIL on the UNFIXED code, surfacing counterexamples that confirm the
 * defects documented in design.md.
 *
 * The user/auth routers are mounted with supertest. Services and cache invalidation are
 * mocked so each route's own logic (validation, ordering, enforcement) is what is exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// ─── Mocks for the user-routes dependency graph ────────────────────────────────

const { userServiceMock, authServiceMock, invalidateMock } = vi.hoisted(() => ({
  userServiceMock: {
    updateUser: vi.fn(async () => ({ oldUser: { role: 'Viewer', status: 'Active', access_scope: 'Global' }, role_id: 'r1' })),
    getStatus: vi.fn(async () => 'Suspended'),
    setStatus: vi.fn(async () => 'targetuser'),
    resetPassword: vi.fn(async () => 'targetuser'),
    logPermissionChange: vi.fn(async () => undefined),
  },
  authServiceMock: { logAudit: vi.fn(async () => undefined), login: vi.fn() },
  invalidateMock: vi.fn(async () => undefined),
}));

vi.mock('../../services/UserService', () => ({ UserService: userServiceMock }));
vi.mock('../../services/AuthService', () => ({ AuthService: authServiceMock }));
vi.mock('../../middleware/auth', () => ({ invalidateUserCache: invalidateMock }));

import { createUserRoutes } from '../users';

// Minimal stub middleware (auth + permission always pass as Admin).
const authenticate = (req: any, _res: any, next: any) => {
  req.user = { id: 'admin-id', role: 'Admin', username: 'admin', name: 'Admin' };
  next();
};
const checkPermission = () => (_req: any, _res: any, next: any) => next();
const authorize = () => (_req: any, _res: any, next: any) => next();

function buildUserApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/users', createUserRoutes(db, authenticate, authorize, checkPermission, vi.fn()));
  return app;
}

function mockDb(overrides: (sql: string, method: string, args: any[]) => any = () => undefined) {
  return {
    prepare(sql: string) {
      const exec = (method: string) => async (...args: any[]) => {
        const r = overrides(sql, method, args);
        if (r !== undefined) return r;
        return method === 'all' ? [] : method === 'get' ? null : { changes: 1 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) { return fn(); },
  };
}

const validUserBody = {
  name: 'Valid Name',
  email: 'valid@example.com',
  role: 'Viewer',
  access_scope: 'Global',
  status: 'Active',
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMock.mockResolvedValue(undefined);
});

describe('Property 1: Bug Condition exploration — routes (user-management-fixes)', () => {
  // ── 1.3 Invalid access_scope/role reaches the DB (Req 2.3) ────────────────
  it('1.3 PUT /users/:id rejects an out-of-enum access_scope with HTTP 400', async () => {
    const app = buildUserApp(mockDb());
    const res = await request(app)
      .put('/users/u-1')
      .send({ ...validUserBody, access_scope: 'EVERYTHING' });
    // Expected (correct): invalid access_scope is rejected before the DB layer.
    expect(res.status).toBe(400);
  });

  it('1.3 PUT /users/:id rejects an out-of-enum role with HTTP 400', async () => {
    const app = buildUserApp(mockDb());
    const res = await request(app)
      .put('/users/u-1')
      .send({ ...validUserBody, role: 'SuperGod' });
    expect(res.status).toBe(400);
  });

  // ── 1.9 invalidateUserCache not awaited (Req 2.9) ─────────────────────────
  it('1.9 PUT /users/:id propagates a cache-invalidation failure instead of responding success', async () => {
    invalidateMock.mockRejectedValueOnce(new Error('cache invalidation failed'));
    const app = buildUserApp(mockDb());
    const res = await request(app).put('/users/u-1').send({ ...validUserBody });
    // Expected (correct): the invalidation is awaited and its failure is surfaced (not a 200 success).
    expect(res.status).not.toBe(200);
  });

  // ── 1.12 Inconsistent minimum password length (Req 2.12) ──────────────────
  it('1.12 POST /users/:id/reset-password rejects a password shorter than the policy minimum (8)', async () => {
    const app = buildUserApp(mockDb());
    const res = await request(app)
      .post('/users/u-1/reset-password')
      .send({ newPassword: 'Aa1!xyz' }); // 7 chars: passes the buggy min(6), violates policy min(8)
    // Expected (correct): a single policy-derived minimum length is enforced consistently.
    expect(res.status).toBe(400);
  });

  // ── 1.19 Sole suspended admin reactivation blocked (Req 2.19) ─────────────
  it('1.19 POST /users/:id/suspend allows reactivating the only (suspended) admin', async () => {
    // Target is an Admin, currently Suspended, and is the sole admin (no other active admins).
    userServiceMock.getStatus.mockResolvedValue('Suspended');
    const db = mockDb((sql) => {
      if (sql.includes('SELECT role FROM users')) return { role: 'Admin' };
      if (sql.includes('COUNT(*)') && sql.includes('Active')) return { count: 0 }; // no other active admins
      return undefined;
    });
    const app = buildUserApp(db);
    const res = await request(app).post('/users/sole-admin/suspend').send({});
    // Expected (correct): reactivating the sole suspended admin (Suspended -> Active) is allowed.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Active');
  });
});

// ─── Auth-route defects (2FA enforcement / session recording) ──────────────────

const { totpMock, dbCalls } = vi.hoisted(() => ({
  totpMock: { isEnabled: vi.fn(async () => false), verify: vi.fn(async () => true), useBackupCode: vi.fn(async () => true) },
  dbCalls: { log: [] as Array<{ sql: string; method: string; args: any[] }> },
}));

vi.mock('../../services/TOTPService', () => ({ totpService: totpMock }));
vi.mock('../../middleware/csrf', () => ({
  generateCsrfToken: () => 'csrf',
  attachCsrfToken: () => undefined,
}));
vi.mock('../../services/refreshCookiePath', () => ({ getRefreshCookiePath: () => '/api/v1/auth/refresh' }));
vi.mock('../../db/index', () => ({
  db: {
    prepare(sql: string) {
      const exec = (method: string) => async (...args: any[]) => {
        dbCalls.log.push({ sql, method, args });
        return method === 'all' ? [] : method === 'get'
          ? { id: 'u-1', username: 'u', role: 'Viewer', name: 'U', email: 'u@x.com', session_version: 1 }
          : { changes: 1 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) { return fn(); },
  },
}));

import { createLoginRoutes } from '../auth/login';
import { createTwoFactorRoutes } from '../auth/twoFactor';
import jwt from 'jsonwebtoken';

// A real RS256 keypair is heavyweight; the temp-token path verifies with jwt.verify.
// We stub jwt.verify for the 2FA route so verifyTempToken succeeds deterministically.

describe('Property 1: Bug Condition exploration — auth routes (user-management-fixes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCalls.log = [];
  });

  // ── 1.13 Required 2FA enrollment not forced (Req 2.13) ────────────────────
  it('1.13 login does not grant full access when the user must set up 2FA', async () => {
    authServiceMock.login.mockResolvedValue({
      user: { id: 'u-1', username: 'mfauser', role: 'Admin', name: 'MFA', requires_2fa_setup: true },
      token: 'access-token',
      refreshToken: 'refresh-token',
    });
    totpMock.isEnabled.mockResolvedValue(false); // not yet enrolled

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', createLoginRoutes({}, 'PUB', 'PRIV', (_q: any, _r: any, n: any) => n(), vi.fn()));

    const res = await request(app)
      .post('/auth/login')
      .send({ usernameOrEmail: 'mfauser', password: 'pw' });

    // Expected (correct): a user required to enroll in 2FA must not receive full access tokens.
    const grantedFullAccess = res.status === 200 && !!res.body.token && !res.body.requires2FA && !res.body.requires2FASetup;
    expect(grantedFullAccess, 'login must force 2FA enrollment, not grant full access').toBe(false);
  });

  // ── 1.15 2FA login records no user_sessions row (Req 2.15) ────────────────
  it('1.15 completing 2FA login records a listable/terminable user_sessions row', async () => {
    vi.spyOn(jwt, 'verify').mockReturnValue({ id: 'u-1', username: 'u', type: '2fa_pending' } as any);
    vi.spyOn(jwt, 'sign').mockReturnValue('signed.jwt.token' as any);
    totpMock.verify.mockResolvedValue(true);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', createTwoFactorRoutes('PUB', 'PUB', 'PRIV', (_q: any, _r: any, n: any) => n(), (_q: any, _r: any, n: any) => n(), vi.fn()));

    const res = await request(app)
      .post('/auth/2fa/validate')
      .send({ tempToken: 'temp', token: '123456' });

    expect(res.status).toBe(200);
    // Expected (correct): the 2FA path inserts a user_sessions row, mirroring normal login.
    const insertedSession = dbCalls.log.some(
      (e) => e.method === 'run' && /INSERT INTO user_sessions/.test(e.sql),
    );
    expect(insertedSession, '2FA login should create a user_sessions row').toBe(true);
  });
});

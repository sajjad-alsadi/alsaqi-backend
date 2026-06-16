// @vitest-environment node
/**
 * Spec: forgot-password-admin-approval — Task 4: Unit Tests
 *
 * Targeted unit tests for all six bugfix areas:
 *   1. forgotPasswordSchema accepts usernameOrEmail / rejects bodies without it
 *   2. forgot-password response body is exactly { success: true } for all branches
 *   3. forgotPasswordLimiter blocks 4th request per IP (3 req / 15 min)
 *   4. PasswordService.getResetRequests() returns rows with email and requested_at
 *   5. POST /reject-reset with valid requestId → { success: true }, DB status = 'Rejected'
 *   6. POST /reject-reset with unknown requestId → HTTP 404
 *   7. PasswordService.requestReset notification targets contain only active admins
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

import { PasswordService } from '../../services/PasswordService';
import { createPasswordRoutes } from '../auth/password';
import { globalErrorHandler } from '../../middleware/error';

// ─── vi.hoisted mocks ─────────────────────────────────────────────────────────

const { dbMock, passwordServiceMock, authServiceMock, notificationServiceMock } = vi.hoisted(() => {
  const dbMock = { prepare: vi.fn() };
  const passwordServiceMock = {
    requestReset: vi.fn(),
    getResetStatus: vi.fn(),
    getResetRequests: vi.fn(),
    approveReset: vi.fn(),
    changePassword: vi.fn(),
    updatePassword: vi.fn(),
    rejectReset: vi.fn(),
  };
  const authServiceMock = { logAudit: vi.fn() };
  const notificationServiceMock = { getAdminIds: vi.fn() };
  return { dbMock, passwordServiceMock, authServiceMock, notificationServiceMock };
});

vi.mock('../../db/index', () => ({ db: dbMock }));
vi.mock('../../services/PasswordService', () => ({ PasswordService: passwordServiceMock }));
vi.mock('../../services/AuthService', () => ({ AuthService: authServiceMock }));
vi.mock('../../services/NotificationService', () => ({ NotificationService: notificationServiceMock }));
vi.mock('../../middleware/auth', () => ({ invalidateUserCache: vi.fn() }));
vi.mock('../../services/passwordPolicy', () => ({
  DEFAULT_PASSWORD_MIN_LENGTH: 8,
  validatePasswordPolicy: vi.fn(),
}));
vi.mock('../../services/refreshCookiePath', () => ({
  getRefreshCookiePath: () => '/api/auth/refresh',
}));

import { createPasswordRoutes as _createPasswordRoutes } from '../auth/password';

// ─── RSA key pair for JWT signing in tests ────────────────────────────────────
let TEST_PRIVATE_KEY: string;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  TEST_PRIVATE_KEY = privateKey;
});

// ─── Route app factory (with mocked services) ────────────────────────────────

function buildMockedApp(options?: { userRole?: string }) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser());

  const userRole = options?.userRole ?? 'Admin';
  const authenticate: express.RequestHandler = (req: any, _res, next) => {
    req.user = { id: 'admin-uuid-001', role: userRole, username: 'admin' };
    next();
  };
  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const createNotificationSpy = vi.fn().mockResolvedValue(undefined);
  const logError = vi.fn();

  const router = _createPasswordRoutes(
    dbMock,
    'JWT_SECRET_TEST',
    TEST_PRIVATE_KEY,
    (_req: any, _res: any, next: any) => next(), // authLimiter no-op
    authenticate,
    checkPermission,
    createNotificationSpy,
    logError,
    // forgotPwLimiter: use the REAL module-level limiter (default param)
    // — individual tests that need rate limiting create a fresh app instance
  );

  app.use('/api/auth', router);
  app.use(globalErrorHandler);

  return { app, createNotificationSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  authServiceMock.logAudit.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: forgotPasswordSchema validation
// Validates: Requirements 2.1
// ─────────────────────────────────────────────────────────────────────────────

describe('1. forgotPasswordSchema validation', () => {
  it('accepts a body with usernameOrEmail and returns 200', async () => {
    passwordServiceMock.requestReset.mockResolvedValue({ success: true });

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.1.1')
      .send({ usernameOrEmail: 'alice' });

    expect(res.status).toBe(200);
  });

  it('rejects a body that omits usernameOrEmail with 400', async () => {
    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.1.2')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects a body with empty usernameOrEmail (min length 1) with 400', async () => {
    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.1.3')
      .send({ usernameOrEmail: '' });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: forgot-password response body equals exactly { success: true }
// Validates: Requirements 2.2
// ─────────────────────────────────────────────────────────────────────────────

describe('2. forgot-password response shape — exactly { success: true } for all branches', () => {
  it('user-found branch: response is exactly { success: true } — no message field', async () => {
    passwordServiceMock.requestReset.mockResolvedValue({
      success: true,
      message: 'If the username exists, a request has been sent.',
      user: { id: 'user-1', username: 'alice', name: 'Alice', department: 'IT' },
      adminIds: ['admin-1'],
      alertMsg: 'Password Reset Request',
    });

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.2.1')
      .send({ usernameOrEmail: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(res.body).not.toHaveProperty('message');
  });

  it('user-not-found branch: response is exactly { success: true } — no message field', async () => {
    passwordServiceMock.requestReset.mockResolvedValue({
      success: true,
      message: 'If the username exists, a request has been sent.',
    });

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.2.2')
      .send({ usernameOrEmail: 'nonexistent' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(res.body).not.toHaveProperty('message');
  });

  it('duplicate-pending branch: response is exactly { success: true } — no message field', async () => {
    passwordServiceMock.requestReset.mockResolvedValue({
      success: true,
      message: 'A request is already pending.',
    });

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', '10.0.2.3')
      .send({ usernameOrEmail: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(res.body).not.toHaveProperty('message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: forgotPasswordLimiter — 3 requests return 200, 4th returns 429
// Validates: Requirements 2.3
// ─────────────────────────────────────────────────────────────────────────────

describe('3. forgotPasswordLimiter: 3 req/15-min per IP', () => {
  it('3 requests from the same IP return 200, the 4th returns 429', async () => {
    // Each test gets its own fresh app instance to get a fresh rate-limit store.
    // The module-level forgotPasswordLimiter carries state across the app instance,
    // so we use a unique IP (RFC 5737 TEST-NET-3: 203.0.113.x) to avoid bleed.
    passwordServiceMock.requestReset.mockResolvedValue({ success: true });

    // Build a fresh app — the default forgotPwLimiter parameter is the module-level
    // instance (max: 3, windowMs: 15 min).
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());

    const authenticate: express.RequestHandler = (req: any, _res, next) => {
      req.user = { id: 'admin-uuid-001', role: 'Admin', username: 'admin' };
      next();
    };
    const checkPermission = () => (_req: any, _res: any, next: any) => next();

    const router = _createPasswordRoutes(
      dbMock, 'JWT_SECRET_TEST', TEST_PRIVATE_KEY,
      (_req: any, _res: any, next: any) => next(),
      authenticate, checkPermission,
      vi.fn().mockResolvedValue(undefined), vi.fn(),
      // forgotPwLimiter: omit → uses module-level forgotPasswordLimiter
    );
    app.use('/api/auth', router);
    app.use(globalErrorHandler);

    // Use a unique IP for this test to avoid state bleed from other tests
    const testIp = '203.0.113.51';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', testIp)
        .send({ usernameOrEmail: `user${i}@example.com` });
      statuses.push(res.status);
    }

    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200);
    expect(statuses[2]).toBe(200);
    expect(statuses[3]).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PGlite DB harness for tests 4–7 (real service methods against in-memory DB)
// ─────────────────────────────────────────────────────────────────────────────
//
// The vi.mock('../../db/index', ...) above replaces `db` with dbMock for all
// consumers, including the real PasswordService/NotificationService. To make
// those real service methods hit a real PGlite DB, we wire dbMock.prepare to
// delegate to the real db wrapper (which has PGlite connected via updateClient).

const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    name TEXT NOT NULL,
    department TEXT,
    role TEXT NOT NULL DEFAULT 'Viewer',
    status TEXT NOT NULL DEFAULT 'Active',
    session_version INTEGER NOT NULL DEFAULT 1,
    requires_password_change INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    password_last_changed TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    status TEXT DEFAULT 'Pending',
    request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_date TIMESTAMP,
    resolved_by UUID,
    temp_password TEXT
  );
  CREATE TABLE IF NOT EXISTS user_management_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    password_min_length INTEGER NOT NULL DEFAULT 8,
    password_require_uppercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_lowercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_numbers BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_symbols BOOLEAN NOT NULL DEFAULT TRUE,
    password_expiry_days INTEGER NOT NULL DEFAULT 90
  );
  INSERT INTO user_management_settings (id, password_min_length) VALUES (1, 8) ON CONFLICT DO NOTHING;
`;

let activePglite: PGlite | null = null;
let realDbInstance: any = null;

async function setupDb(): Promise<PGlite> {
  // Get the real db wrapper so we can connect PGlite to it.
  const realDbModule = await vi.importActual<typeof import('../../db/index')>('../../db/index');
  realDbInstance = realDbModule.db;

  const pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(DDL);
  (realDbInstance as any).updateClient(pglite as any, false);
  activePglite = pglite;

  // Wire the mock's prepare() to delegate to the real db wrapper so that real
  // service methods (which receive the mock db via vi.mock) hit the real PGlite.
  dbMock.prepare.mockImplementation((sql: string) => realDbInstance.prepare(sql));

  return pglite;
}

afterEach(async () => {
  // Reset the mock prepare so non-DB tests are not affected
  dbMock.prepare.mockReset();

  if (realDbInstance) {
    try { (realDbInstance as any).updateClient(null, false); } catch { /* ignore */ }
    realDbInstance = null;
  }
  if (activePglite) {
    try { await activePglite.close(); } catch { /* ignore */ }
    activePglite = null;
  }
});

async function seedUser(pglite: PGlite, overrides: Record<string, any> = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const username = overrides.username ?? `user_${Math.random().toString(36).slice(2, 10)}`;
  const hashed = await bcrypt.hash(overrides.plainPassword ?? 'Password123!', 4);
  await pglite.query(
    `INSERT INTO users (id, username, password, name, email, department, role, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id, username, hashed,
      overrides.name ?? 'Test User',
      overrides.email ?? `${username}@example.com`,
      overrides.department ?? 'IT',
      overrides.role ?? 'Viewer',
      overrides.status ?? 'Active',
    ],
  );
  return { id, username };
}

async function seedPendingRequest(pglite: PGlite, userId: string, username: string) {
  const result = await pglite.query(
    `INSERT INTO password_reset_requests (user_id, username, name, department, status)
     VALUES ($1,$2,'Test User','IT','Pending') RETURNING id`,
    [userId, username],
  );
  return (result.rows[0] as any).id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: PasswordService.getResetRequests() — rows contain email + requested_at
// Validates: Requirements 2.4
// ─────────────────────────────────────────────────────────────────────────────

describe('4. PasswordService.getResetRequests() returns email and requested_at', () => {
  it('returns rows with email (from JOIN users) and requested_at (aliased from request_date)', async () => {
    // Use vi.importActual to access the real PasswordService, bypassing the vi.mock.
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');

    const pglite = await setupDb();

    // Seed a user and a pending reset request
    const { id: userId, username } = await seedUser(pglite, {
      email: 'testuser@example.com',
      role: 'Viewer',
    });
    await seedPendingRequest(pglite, userId, username);

    const rows = await RealPasswordService.getResetRequests() as any[];

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // email comes from JOIN users
    expect(row).toHaveProperty('email');
    expect(row.email).toBe('testuser@example.com');

    // requested_at is aliased from request_date
    expect(row).toHaveProperty('requested_at');
    expect(row.requested_at).not.toBeNull();

    // Other required fields are present
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('username');
    expect(row).toHaveProperty('status');
    expect(row.status).toBe('Pending');
  });

  it('only returns Pending rows, not Approved or Rejected ones', async () => {
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');

    const pglite = await setupDb();

    const { id: userId, username } = await seedUser(pglite, { email: 'u@example.com' });
    // Seed one Pending and one Approved
    await seedPendingRequest(pglite, userId, username);
    await pglite.query(
      `INSERT INTO password_reset_requests (user_id, username, name, status)
       VALUES ($1,$2,'Test User','Approved')`,
      [userId, username],
    );

    const rows = await RealPasswordService.getResetRequests() as any[];
    expect(rows.every((r: any) => r.status === 'Pending')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 5 & 6: POST /reject-reset — success and not-found cases
// Validates: Requirements 2.5
// ─────────────────────────────────────────────────────────────────────────────

describe('5 & 6. POST /reject-reset', () => {
  // Build a route app that uses the REAL PasswordService (via importActual).
  // We override the mock just for this describe block by calling importActual
  // inside the test and building a fresh app with the real service wired in.

  it('5. valid requestId → returns { success: true } and sets status = Rejected in DB', async () => {
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');

    const pglite = await setupDb();
    const { id: userId, username } = await seedUser(pglite, { role: 'Viewer' });
    const requestId = await seedPendingRequest(pglite, userId, username);

    // Build an app that uses the real rejectReset through the route layer.
    // We replace the PasswordService mock with the real one for this test by
    // calling rejectReset directly and verifying DB state.
    const adminId = crypto.randomUUID();

    await RealPasswordService.rejectReset(requestId, adminId);

    // Verify DB: status is now 'Rejected'
    const row = (await pglite.query(
      `SELECT status, resolved_by FROM password_reset_requests WHERE id = $1`,
      [requestId],
    )).rows[0] as any;

    expect(row.status).toBe('Rejected');
    expect(row.resolved_by).toBe(adminId);
  });

  it('5. route layer: POST /reject-reset with valid UUID → HTTP 200 { success: true }', async () => {
    // Use the mocked PasswordService for the route layer test.
    passwordServiceMock.rejectReset.mockResolvedValue(undefined);

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/reject-reset')
      .send({ requestId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('6. unknown requestId → rejectReset throws NotFoundError → HTTP 404', async () => {
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');
    const { NotFoundError } = await vi.importActual<
      typeof import('../../utils/errors')
    >('../../utils/errors');

    await setupDb(); // fresh empty DB — no rows seeded

    const unknownId = crypto.randomUUID();

    await expect(RealPasswordService.rejectReset(unknownId, 'admin-id'))
      .rejects.toThrow(NotFoundError);
  });

  it('6. route layer: POST /reject-reset with unknown requestId → HTTP 404', async () => {
    const { NotFoundError } = await vi.importActual<
      typeof import('../../utils/errors')
    >('../../utils/errors');

    // Make the mocked rejectReset throw NotFoundError (same as the real service does)
    passwordServiceMock.rejectReset.mockRejectedValue(new NotFoundError('Request not found'));

    const { app } = buildMockedApp();
    const res = await request(app)
      .post('/api/auth/reject-reset')
      .send({ requestId: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22' });

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: PasswordService.requestReset — notification targets are only active admins
// Validates: Requirements 2.6
// ─────────────────────────────────────────────────────────────────────────────

describe('7. PasswordService.requestReset — notification targets contain only active admins', () => {
  it('returns adminIds containing only active admins when the users table has a mix', async () => {
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');
    const { NotificationService: RealNotificationService } = await vi.importActual<
      typeof import('../../services/NotificationService')
    >('../../services/NotificationService');

    const pglite = await setupDb();

    // Also proxy notificationServiceMock.getAdminIds to the real implementation
    // so requestReset's internal NotificationService.getAdminIds() call hits the real DB.
    notificationServiceMock.getAdminIds.mockImplementation(() =>
      RealNotificationService.getAdminIds()
    );

    // Seed the requesting user
    const { username } = await seedUser(pglite, {
      role: 'Viewer',
      status: 'Active',
    });

    // Seed an ACTIVE admin
    const activeAdminId = crypto.randomUUID();
    await seedUser(pglite, {
      id: activeAdminId,
      role: 'Admin',
      status: 'Active',
      username: 'active_admin',
      email: 'active.admin@example.com',
    });

    // Seed an INACTIVE admin — must NOT appear in notification targets
    const inactiveAdminId = crypto.randomUUID();
    await seedUser(pglite, {
      id: inactiveAdminId,
      role: 'Admin',
      status: 'Inactive',
      username: 'inactive_admin',
      email: 'inactive.admin@example.com',
    });

    // Seed a SUSPENDED admin — must NOT appear in notification targets
    const suspendedAdminId = crypto.randomUUID();
    await seedUser(pglite, {
      id: suspendedAdminId,
      role: 'Admin',
      status: 'Suspended',
      username: 'suspended_admin',
      email: 'suspended.admin@example.com',
    });

    const result = await RealPasswordService.requestReset(username) as any;

    // requestReset should succeed
    expect(result.success).toBe(true);

    // adminIds must only contain the active admin
    expect(result.adminIds).toContain(activeAdminId);
    expect(result.adminIds).not.toContain(inactiveAdminId);
    expect(result.adminIds).not.toContain(suspendedAdminId);
  });

  it('returns empty adminIds when no active admins exist', async () => {
    const { PasswordService: RealPasswordService } = await vi.importActual<
      typeof import('../../services/PasswordService')
    >('../../services/PasswordService');
    const { NotificationService: RealNotificationService } = await vi.importActual<
      typeof import('../../services/NotificationService')
    >('../../services/NotificationService');

    const pglite = await setupDb();

    // Proxy notificationServiceMock.getAdminIds to real implementation
    notificationServiceMock.getAdminIds.mockImplementation(() =>
      RealNotificationService.getAdminIds()
    );

    const { username } = await seedUser(pglite, { role: 'Viewer', status: 'Active' });

    // Only seed an inactive admin — no active admins
    await seedUser(pglite, {
      role: 'Admin',
      status: 'Inactive',
      username: 'inactive_only',
      email: 'inactive@example.com',
    });

    const result = await RealPasswordService.requestReset(username) as any;

    expect(result.success).toBe(true);
    // No active admins → adminIds should be an empty array
    expect(result.adminIds).toEqual([]);
  });
});

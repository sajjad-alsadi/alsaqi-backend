// @vitest-environment node
/**
 * Spec: forgot-password-admin-approval — Task 6: Integration tests
 *
 * Full end-to-end flows using PGlite (in-memory database with real service layer).
 *
 * Flow 1 — Full approve flow (Requirements 2.1, 2.2, 2.4, 3.2)
 *   POST forgot-password → assert success
 *   GET  reset-requests  → assert email and requested_at present
 *   POST approve-reset   → assert DB status = 'Approved' and tempPassword in response
 *
 * Flow 2 — Full reject flow (Requirements 2.1, 2.5)
 *   POST forgot-password → assert success
 *   GET  reset-requests  → get the requestId
 *   POST reject-reset    → assert DB status = 'Rejected', resolved_date set, resolved_by = admin id
 *
 * Flow 3 — Rate-limit isolation flow (Requirements 2.3, 3.1, 3.2)
 *   3 successful forgot-password requests from one IP
 *   4th request returns 429
 *   POST approve-reset from authenticated admin still returns 200 (limiter is isolated)
 *
 * Flow 4 — Notification isolation flow (Requirements 2.6)
 *   Seed active + inactive admins
 *   Trigger requestReset (via POST /forgot-password)
 *   Assert createNotification is called only for active admin IDs
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

import { db } from '../../db/index';
import { createPasswordRoutes } from '../auth/password';
import { globalErrorHandler } from '../../middleware/error';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// ─── RSA key pair for JWT signing ─────────────────────────────────────────────

let TEST_PRIVATE_KEY: string;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  TEST_PRIVATE_KEY = privateKey;
});

// ─── DDL ─────────────────────────────────────────────────────────────────────

const DDL_USERS = `
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
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`;

const DDL_PASSWORD_RESET_REQUESTS = `
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
`;

const DDL_PASSWORD_HISTORY = `
  CREATE TABLE IF NOT EXISTS password_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

const DDL_NOTIFICATIONS = `
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    related_module TEXT,
    link TEXT,
    status TEXT DEFAULT 'Unread',
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actor_id UUID,
    entity_id UUID,
    entity_type TEXT,
    data JSONB,
    title TEXT
  );
  CREATE TABLE IF NOT EXISTS notification_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    is_dismissed BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ
  );
`;

const DDL_USER_SESSIONS = `
  CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    status TEXT DEFAULT 'Active'
  );
`;

const DDL_REFRESH_TOKENS = `
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    token TEXT,
    is_revoked INTEGER DEFAULT 0,
    revoked_at TIMESTAMPTZ
  );
`;

const DDL_USER_MANAGEMENT_SETTINGS = `
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

const DDL_AUDIT_TRAIL = `
  CREATE TABLE IF NOT EXISTS audit_trail (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user" TEXT,
    action TEXT,
    module TEXT,
    details TEXT,
    hash TEXT,
    previous_hash TEXT,
    seq SERIAL,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`;

// ─── DB harness ───────────────────────────────────────────────────────────────

let activePglite: PGlite | null = null;

async function useDb(): Promise<PGlite> {
  const pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(DDL_USERS);
  await pglite.exec(DDL_PASSWORD_RESET_REQUESTS);
  await pglite.exec(DDL_PASSWORD_HISTORY);
  await pglite.exec(DDL_NOTIFICATIONS);
  await pglite.exec(DDL_USER_SESSIONS);
  await pglite.exec(DDL_REFRESH_TOKENS);
  await pglite.exec(DDL_USER_MANAGEMENT_SETTINGS);
  await pglite.exec(DDL_AUDIT_TRAIL);
  (db as any).updateClient(pglite as any, false);
  activePglite = pglite;
  return pglite;
}

afterEach(async () => {
  (db as any).updateClient(null, false);
  if (activePglite) {
    try { await activePglite.close(); } catch { /* ignore */ }
    activePglite = null;
  }
});

// ─── Stub middleware ──────────────────────────────────────────────────────────

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_USER = { id: ADMIN_ID, role: 'Admin', username: 'admin', name: 'Admin' };

const authenticate = (req: any, _res: any, next: any) => {
  req.user = { ...ADMIN_USER };
  next();
};
const checkPermission = () => (_req: any, _res: any, next: any) => next();
const noopLimiter = (_req: any, _res: any, next: any) => next();
const noop = () => {};

const TEST_JWT_SECRET = 'test-secret';

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedUser(pglite: PGlite, overrides: Record<string, any> = {}): Promise<{ id: string; username: string; email: string }> {
  const id = overrides.id ?? crypto.randomUUID();
  const username = overrides.username ?? `user_${Math.random().toString(36).slice(2, 10)}`;
  const email = overrides.email ?? `${username}@example.com`;
  const plainPw = overrides.plainPassword ?? 'Password123!';
  const hashed = await bcrypt.hash(plainPw, 4);

  await pglite.query(
    `INSERT INTO users (id, username, password, name, email, department, role, status, session_version, requires_password_change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      username,
      hashed,
      overrides.name ?? 'Test User',
      email,
      overrides.department ?? 'IT',
      overrides.role ?? 'Viewer',
      overrides.status ?? 'Active',
      overrides.session_version ?? 1,
      0,
    ],
  );
  return { id, username, email };
}

async function seedPendingRequest(pglite: PGlite, userId: string, username: string, name = 'Test User'): Promise<string> {
  const result = await pglite.query(
    `INSERT INTO password_reset_requests (user_id, username, name, department, status)
     VALUES ($1,$2,$3,$4,'Pending') RETURNING id`,
    [userId, username, name, 'IT'],
  );
  return (result.rows[0] as any).id;
}

// ─── App factory helpers ──────────────────────────────────────────────────────

/**
 * Build an app with a no-op forgotPasswordLimiter (for flows 1, 2, 4).
 * Uses the real createNotification mock passed in.
 */
function buildApp(createNotification: any = vi.fn(async () => true)): express.Application {
  const app = express();
  app.use(express.json());
  const router = createPasswordRoutes(
    null,
    TEST_JWT_SECRET,
    TEST_PRIVATE_KEY,
    noopLimiter,
    authenticate,
    checkPermission,
    createNotification,
    noop,
    noopLimiter, // no-op forgotPwLimiter
  );
  app.use('/api/auth', router);
  app.use(globalErrorHandler);
  return app;
}

/**
 * Build an app with a REAL forgotPasswordLimiter for rate-limit testing.
 * Each call creates a fresh limiter instance with its own MemoryStore to
 * guarantee full isolation between test runs.
 */
function buildAppWithRealLimiter(createNotification: any = vi.fn(async () => true)): express.Application {
  const freshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    // Use a store per-instance (default MemoryStore is per-instance in express-rate-limit v7+)
    keyGenerator: (req: any) => ipKeyGenerator(req.ip || req.headers['x-forwarded-for'] || 'no-ip'),
    handler: (_req: any, res: any) => {
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    },
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  const router = createPasswordRoutes(
    null,
    TEST_JWT_SECRET,
    TEST_PRIVATE_KEY,
    noopLimiter,
    authenticate,
    checkPermission,
    createNotification,
    noop,
    freshLimiter,
  );
  app.use('/api/auth', router);
  app.use(globalErrorHandler);
  return app;
}

// ─── Flow 1: Full approve flow ────────────────────────────────────────────────

describe('Integration Flow 1 — Full approve flow', () => {
  /**
   * Validates: Requirements 2.1, 2.2, 2.4, 3.2
   *
   * POST forgot-password  → { success: true } (no message field)
   * GET  reset-requests   → row contains email and requested_at
   * POST approve-reset    → DB status = 'Approved', tempPassword in response
   */
  it('POST forgot-password → GET reset-requests → POST approve-reset completes full cycle', async () => {
    const pglite = await useDb();
    const mockNotify = vi.fn(async () => true);
    const app = buildApp(mockNotify);

    // Seed the target user
    const { id: userId, username, email } = await seedUser(pglite);

    // Step 1: POST /forgot-password
    const fpRes = await request(app)
      .post('/api/auth/forgot-password')
      .send({ usernameOrEmail: username });

    expect(fpRes.status).toBe(200);
    expect(fpRes.body).toEqual({ success: true });
    // Req 2.2: no message field
    expect(fpRes.body).not.toHaveProperty('message');

    // Step 2: GET /reset-requests — assert email and requested_at present
    const listRes = await request(app).get('/api/auth/reset-requests');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);

    const row = listRes.body.find((r: any) => r.username === username);
    expect(row).toBeDefined();

    // Req 2.4: must include id, username, email, requested_at, status
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('username', username);
    expect(row).toHaveProperty('email', email);
    expect(row).toHaveProperty('requested_at');
    expect(row.requested_at).not.toBeNull();
    expect(row).toHaveProperty('status', 'Pending');

    const requestId = row.id;

    // Step 3: POST /approve-reset
    const approveRes = await request(app)
      .post('/api/auth/approve-reset')
      .send({ requestId });

    // Req 3.2: approve-reset returns success + tempPassword
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(typeof approveRes.body.tempPassword).toBe('string');
    expect(approveRes.body.tempPassword.length).toBeGreaterThan(0);

    // DB: status must now be 'Approved'
    const dbRow = (await pglite.query(
      `SELECT status FROM password_reset_requests WHERE id = $1`,
      [requestId],
    )).rows[0] as any;
    expect(dbRow.status).toBe('Approved');

    // Unused userId assertion — just ensure we can query the seeded user
    const userRow = (await pglite.query(
      `SELECT id FROM users WHERE id = $1`, [userId],
    )).rows[0] as any;
    expect(userRow.id).toBe(userId);
  });
});

// ─── Flow 2: Full reject flow ─────────────────────────────────────────────────

describe('Integration Flow 2 — Full reject flow', () => {
  /**
   * Validates: Requirements 2.1, 2.5
   *
   * POST forgot-password → GET reset-requests (get requestId) → POST reject-reset
   * Assert DB status = 'Rejected', resolved_date set, resolved_by = admin id
   */
  it('POST forgot-password → GET reset-requests → POST reject-reset completes full cycle', async () => {
    const pglite = await useDb();
    const app = buildApp();

    // Seed target user
    const { username } = await seedUser(pglite);

    // Step 1: POST /forgot-password
    const fpRes = await request(app)
      .post('/api/auth/forgot-password')
      .send({ usernameOrEmail: username });

    expect(fpRes.status).toBe(200);
    expect(fpRes.body.success).toBe(true);
    expect(fpRes.body).not.toHaveProperty('message');

    // Step 2: GET /reset-requests — obtain requestId
    const listRes = await request(app).get('/api/auth/reset-requests');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);

    const row = listRes.body.find((r: any) => r.username === username);
    expect(row).toBeDefined();
    const requestId = row.id;
    expect(requestId).toBeTruthy();

    // Step 3: POST /reject-reset
    const rejectRes = await request(app)
      .post('/api/auth/reject-reset')
      .send({ requestId });

    // Req 2.5: returns { success: true }
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body).toEqual({ success: true });

    // DB assertions: status = 'Rejected', resolved_date set, resolved_by = ADMIN_ID
    const dbRow = (await pglite.query(
      `SELECT status, resolved_date, resolved_by FROM password_reset_requests WHERE id = $1`,
      [requestId],
    )).rows[0] as any;

    expect(dbRow.status).toBe('Rejected');
    expect(dbRow.resolved_date).not.toBeNull();
    expect(dbRow.resolved_by).toBe(ADMIN_ID);
  });
});

// ─── Flow 3: Rate-limit isolation flow ───────────────────────────────────────

describe('Integration Flow 3 — Rate-limit isolation flow', () => {
  /**
   * Validates: Requirements 2.3, 3.1, 3.2
   *
   * 3 successful forgot-password requests from one IP → 4th returns 429
   * POST approve-reset from the same app instance still returns 200
   * (the forgotPasswordLimiter is isolated to /forgot-password)
   */
  it('3 requests from same IP succeed; 4th returns 429; approve-reset still returns 200', async () => {
    const pglite = await useDb();
    // Unique IP per test run to avoid cross-test state
    const testIp = `10.1.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    const app = buildAppWithRealLimiter();

    // Seed user to get a real reset request
    const { username } = await seedUser(pglite);

    // Send 3 forgot-password requests — all should succeed (Req 3.1)
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', testIp)
        .send({ usernameOrEmail: username });

      // First request will actually create the row; subsequent ones hit the
      // "already pending" deduplication branch — both return success.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    // 4th request from the SAME IP must be rate-limited (Req 2.3)
    const blockedRes = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', testIp)
      .send({ usernameOrEmail: username });

    expect(blockedRes.status).toBe(429);

    // Approve-reset is NOT behind forgotPasswordLimiter — must still return 200 (Req 3.2)
    // Seed a pending request manually (the one from step 1 may already exist)
    const pendingRows = (await pglite.query(
      `SELECT id FROM password_reset_requests WHERE username = $1 AND status = 'Pending' LIMIT 1`,
      [username],
    )).rows;

    expect(pendingRows.length).toBeGreaterThan(0);
    const requestId = (pendingRows[0] as any).id;

    const approveRes = await request(app)
      .post('/api/auth/approve-reset')
      .send({ requestId });

    // approve-reset is unaffected by the forgot-password rate limiter
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(typeof approveRes.body.tempPassword).toBe('string');
  });

  it('different IPs are counted independently — each gets their own 3-request budget', async () => {
    const pglite = await useDb();
    const ip1 = `10.2.1.1`;
    const ip2 = `10.2.1.2`;

    const app = buildAppWithRealLimiter();

    const { username } = await seedUser(pglite);

    // ip1 exhausts its budget
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', ip1)
        .send({ usernameOrEmail: username });
      expect(res.status).toBe(200);
    }

    // ip1 is now blocked
    const ip1Blocked = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', ip1)
      .send({ usernameOrEmail: username });
    expect(ip1Blocked.status).toBe(429);

    // ip2 still has its own budget and must succeed
    const ip2Res = await request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', ip2)
      .send({ usernameOrEmail: username });
    expect(ip2Res.status).toBe(200);
  });
});

// ─── Flow 4: Notification isolation flow ─────────────────────────────────────

describe('Integration Flow 4 — Notification isolation flow', () => {
  /**
   * Validates: Requirements 2.6
   *
   * Seed active + inactive admins.
   * Trigger requestReset via POST /forgot-password.
   * Assert createNotification is called only for active admin IDs.
   */
  it('createNotification is called only for active admin IDs when inactive admins exist', async () => {
    const pglite = await useDb();

    const mockNotify = vi.fn(async () => true);
    const app = buildApp(mockNotify);

    // Seed 2 active admins and 1 inactive admin
    const activeAdmin1 = await seedUser(pglite, {
      username: 'active_admin_1',
      role: 'Admin',
      status: 'Active',
    });
    const activeAdmin2 = await seedUser(pglite, {
      username: 'active_admin_2',
      role: 'Admin',
      status: 'Active',
    });
    const inactiveAdmin = await seedUser(pglite, {
      username: 'inactive_admin',
      role: 'Admin',
      status: 'Inactive',
    });

    // Seed the regular user who requests reset
    const { username } = await seedUser(pglite, { username: 'reset_requester', role: 'Viewer' });

    // Trigger reset request — this calls PasswordService.requestReset
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ usernameOrEmail: username });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // createNotification must have been called at least once (for active admins)
    expect(mockNotify).toHaveBeenCalled();

    // Collect all recipient IDs passed to createNotification as first argument
    const notifiedIds = mockNotify.mock.calls.map((call: any[]) => call[0]);

    // Active admins must be notified
    expect(notifiedIds).toContain(activeAdmin1.id);
    expect(notifiedIds).toContain(activeAdmin2.id);

    // Inactive admin must NOT be notified (Req 2.6)
    expect(notifiedIds).not.toContain(inactiveAdmin.id);
  });

  it('no notification is sent when there are no active admins', async () => {
    const pglite = await useDb();

    const mockNotify = vi.fn(async () => true);
    const app = buildApp(mockNotify);

    // Only seed an inactive admin — no active admins
    await seedUser(pglite, {
      username: 'inactive_only',
      role: 'Admin',
      status: 'Inactive',
    });

    const { username } = await seedUser(pglite, { username: 'the_user', role: 'Viewer' });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ usernameOrEmail: username });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // No active admins → createNotification should not be called
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

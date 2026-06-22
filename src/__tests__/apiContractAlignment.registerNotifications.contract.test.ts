// @vitest-environment node
/**
 * Contract Tests — Backend API Contract Alignment (Task 7.2)
 *
 * Feature: backend-api-contract-alignment
 *
 * Locks the admin-guarded register endpoint and the notification mark-read
 * contract against the REAL application built by `createApiServer`
 * (src/index.ts), started with the optional infrastructure subsystems disabled
 * (ENABLE_REDIS/QUEUES/WEBSOCKET/CRON/METRICS = false) and `nodeEnv = 'test'`,
 * backed by the embedded PGlite engine. Tokens are minted with the app's RS256
 * key so the real `authenticate` / `checkPermission` chain runs unmodified.
 *
 * Because Task 3.4 removed the `register` CSRF exemption, register is now a
 * CSRF-protected state-changing route: every state-changing request below sends
 * a matching CSRF double-submit token (cookie + header) so it reaches the
 * auth/permission layer, EXCEPT the dedicated assertion that the exemption was
 * removed (a tokenless POST must be rejected by CSRF).
 *
 * Assertions (Requirements 7.6, 7.7, 7.8 → R8.*, R9.*):
 *  - POST /api/auth/register: 401 unauthenticated, 403 unauthorized, 201 with a
 *    Success_Envelope `data.user` for an authorized valid request, conflict for a
 *    duplicate username/email, and CSRF `register` exemption removed (R7.6, R8).
 *  - PUT /api/notifications/mark-read: `data.updated` is a number; 400 for
 *    missing/non-array `notification_ids` (R7.7, R9.1/R9.3/R9.7).
 *  - PUT /api/notifications/mark-all-read: `data.updated` is a number (R7.8, R9.4).
 *  - PUT /api/notifications/:id/read still resolves (not 404) (R9.5).
 *
 * Validates: Requirements 7.6, 7.7, 7.8
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { createApiServer } from '../index.js';
import type { ApiServer } from '../index.js';

describe('Task 7.2: register guard + notification contract', () => {
  let server: ApiServer;
  let app: import('express').Express;
  let request: typeof import('supertest').default;
  let adminToken: string;
  let auditorToken: string;

  // A fixed CSRF double-submit token: identical value in the cookie and header
  // satisfies the timing-safe comparison in csrfMiddleware, so a state-changing
  // request passes CSRF and reaches the route's auth/permission chain.
  const CSRF = 'contract-test-csrf-token-0123456789abcdef';

  /**
   * Build a state-changing (POST/PUT/DELETE) request carrying a matching CSRF
   * double-submit token, optionally with a Bearer token.
   */
  function csrfReq(
    method: 'post' | 'put' | 'delete',
    path: string,
    token?: string
  ) {
    let req = request(app)
      [method](path)
      .set('Cookie', [`csrf-token=${CSRF}`])
      .set('x-csrf-token', CSRF);
    if (token) {
      req = req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  }

  /** Build a fresh, valid RegisterInput body with unique username/email. */
  function validRegisterBody() {
    const suffix = crypto.randomBytes(5).toString('hex');
    return {
      username: `reguser_${suffix}`,
      password: 'password123',
      name: 'Registered User',
      email: `reg_${suffix}@example.com`,
      role: 'Internal Auditor',
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_REDIS = 'false';
    process.env.ENABLE_QUEUES = 'false';
    process.env.ENABLE_WEBSOCKET = 'false';
    process.env.ENABLE_CRON = 'false';
    process.env.ENABLE_METRICS = 'false';
    if (!process.env.FILE_ACCESS_SECRET || process.env.FILE_ACCESS_SECRET.length < 32) {
      process.env.FILE_ACCESS_SECRET = 'contract-test-file-access-secret-0123456789';
    }
    delete process.env.DATABASE_URL;
    // Point the embedded engine at a unique, per-suite on-disk data dir so this
    // full-server suite does not contend with the other contract/integration
    // suites for the shared default PGlite directory (which reproducibly aborts
    // the engine when suites run together). Set BEFORE createApiServer/start so
    // it is read when PGlite is lazily created during start().
    process.env.PGLITE_DATA_DIR = path.join(
      os.tmpdir(),
      `pglite_register_notifications_${process.pid}`
    );

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    server = createApiServer({
      port: 0,
      corsOrigins: ['http://localhost:5173'],
      jwtSecret: 'contract-test-jwt-secret-key-1234567890-abcdef',
      jwtPrivateKey: privateKey,
      jwtPublicKey: publicKey,
      databaseUrl: '',
      uploadDir: '/tmp/contract-test-uploads',
      nodeEnv: 'test',
    });

    await server.start();
    app = server.getApp() as import('express').Express;
    request = (await import('supertest')).default;

    const { db } = await import('../db/index.js');

    // Admin user → holds UserManagement/Create (Admin bypass) → 201 path.
    const admin = (await db
      .prepare("SELECT id, session_version FROM users WHERE username = 'admin' LIMIT 1")
      .get()) as { id: string; session_version: number } | undefined;
    if (!admin) {
      throw new Error('Seeded admin user not found; cannot mint admin token');
    }
    adminToken = jwt.sign(
      { id: admin.id, session_version: admin.session_version ?? 1, role: 'Admin' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h' }
    );

    // Seeded 'test' user is an Internal Auditor with UserManagement: [] → lacks
    // UserManagement/Create → exercises the 403 unauthorized path.
    const auditor = (await db
      .prepare("SELECT id, session_version FROM users WHERE username = 'test' LIMIT 1")
      .get()) as { id: string; session_version: number } | undefined;
    if (!auditor) {
      throw new Error('Seeded test (auditor) user not found; cannot mint auditor token');
    }
    auditorToken = jwt.sign(
      { id: auditor.id, session_version: auditor.session_version ?? 1, role: 'Internal Auditor' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h' }
    );
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  // ─── R7.6 / R8.2 — unauthenticated register → 401 ───────────────────────────
  it('POST /api/auth/register returns 401 for an unauthenticated request', async () => {
    // Send a valid CSRF token (so the request passes CSRF and reaches the auth
    // guard) but NO Authorization header → authenticate rejects with 401.
    const res = await csrfReq('post', '/api/auth/register').send(validRegisterBody());
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
  });

  // ─── R7.6 / R8.3 — authenticated but unauthorized register → 403 ────────────
  it('POST /api/auth/register returns 403 for an authenticated user lacking UserManagement/Create', async () => {
    const res = await csrfReq('post', '/api/auth/register', auditorToken).send(validRegisterBody());
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
  });

  // ─── R7.6 / R8.4 — authorized valid register → 201 Success_Envelope data.user ─
  it('POST /api/auth/register returns a Success_Envelope with data.user for an authorized valid request', async () => {
    const body = validRegisterBody();
    const res = await csrfReq('post', '/api/auth/register', adminToken).send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.meta).toBe('object');
    expect(res.body.meta).not.toBeNull();
    expect(res.body.data).toBeTypeOf('object');
    expect(res.body.data.user).toBeTypeOf('object');
    expect(res.body.data.user).not.toBeNull();
    expect(res.body.data.user.username).toBe(body.username);
  });

  // ─── R7.6 / R8.6 — duplicate username/email rejected ────────────────────────
  it('POST /api/auth/register rejects a duplicate username with a conflict error', async () => {
    const body = validRegisterBody();

    // First registration succeeds.
    const first = await csrfReq('post', '/api/auth/register', adminToken).send(body);
    expect(first.status).toBe(201);

    // Re-registering the SAME username/email is rejected with an Error_Envelope.
    const dup = await csrfReq('post', '/api/auth/register', adminToken).send(body);
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(dup.status).toBe(409);
    expect(dup.body.success).toBe(false);
    expect(dup.body.data).toBeNull();
    expect(typeof dup.body.error.code).toBe('string');
    expect(dup.body.error.code.length).toBeGreaterThan(0);
    // The conflict identifies the duplicate field (username or email).
    expect(String(dup.body.error.message)).toMatch(/username|email/i);
  });

  it('POST /api/auth/register rejects a duplicate email with a conflict error', async () => {
    const base = validRegisterBody();
    const first = await csrfReq('post', '/api/auth/register', adminToken).send(base);
    expect(first.status).toBe(201);

    // Same email, different username → email conflict.
    const dupEmail = {
      ...base,
      username: `${base.username}_x`.slice(0, 50),
    };
    const res = await csrfReq('post', '/api/auth/register', adminToken).send(dupEmail);
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error.message)).toMatch(/email/i);
  });

  // ─── R7.6 / R8.8 — register CSRF exemption removed ──────────────────────────
  it('POST /api/auth/register is NOT exempt from CSRF (tokenless POST is rejected with CSRF_VALIDATION_FAILED)', async () => {
    // No CSRF cookie/header and no auth: if register were still CSRF-exempt the
    // request would fall through to authenticate (401). Because the exemption was
    // removed, CSRF rejects it first with 403 CSRF_VALIDATION_FAILED.
    const res = await request(app).post('/api/auth/register').send(validRegisterBody());
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    // Control: a still-exempt path (login) does NOT produce a CSRF failure for a
    // tokenless POST, confirming the exemption logic itself is intact and that
    // register specifically is no longer on the exempt list.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ usernameOrEmail: 'nobody', password: 'x' });
    expect(login.body?.error?.code).not.toBe('CSRF_VALIDATION_FAILED');
  });

  // ─── R7.7 / R9.1, R9.3 — bulk mark-read returns numeric data.updated ────────
  it('PUT /api/notifications/mark-read returns a Success_Envelope whose data.updated is a number', async () => {
    const res = await csrfReq('put', '/api/notifications/mark-read', adminToken).send({
      notification_ids: [crypto.randomUUID(), crypto.randomUUID()],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeTypeOf('object');
    expect(typeof res.body.data.updated).toBe('number');
  });

  // ─── R7.7 / R9.7 — missing notification_ids → 400 ───────────────────────────
  it('PUT /api/notifications/mark-read returns 400 when notification_ids is missing', async () => {
    const res = await csrfReq('put', '/api/notifications/mark-read', adminToken).send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error.code).toBe('string');
  });

  // ─── R7.7 / R9.7 — non-array notification_ids → 400 ─────────────────────────
  it('PUT /api/notifications/mark-read returns 400 when notification_ids is not an array', async () => {
    const res = await csrfReq('put', '/api/notifications/mark-read', adminToken).send({
      notification_ids: 'not-an-array',
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
  });

  // ─── R7.7 / R9.7 — array containing a non-UUID id → clean 400 (not 500) ─────
  it('PUT /api/notifications/mark-read returns 400 (not 500) when notification_ids contains a non-UUID id', async () => {
    const res = await csrfReq('put', '/api/notifications/mark-read', adminToken).send({
      notification_ids: ['not-a-uuid'],
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error.code).toBe('string');
    expect(res.body.error.code.length).toBeGreaterThan(0);
  });

  // ─── R7.8 / R9.4 — mark-all-read returns numeric data.updated ───────────────
  it('PUT /api/notifications/mark-all-read returns a Success_Envelope whose data.updated is a number', async () => {
    const res = await csrfReq('put', '/api/notifications/mark-all-read', adminToken).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.updated).toBe('number');
  });

  // ─── R9.5 — single mark-read (PUT /:id/read) still resolves (not 404) ───────
  it('PUT /api/notifications/:id/read still resolves (backward compatibility)', async () => {
    const res = await csrfReq(
      'put',
      `/api/notifications/${crypto.randomUUID()}/read`,
      adminToken
    ).send({});
    expect(res.status).not.toBe(404);
  });
});

// @vitest-environment node
/**
 * Contract Tests — Backend API Contract Alignment (Task 7.1)
 *
 * Feature: backend-api-contract-alignment
 *
 * Locks the routing, resource-name, version-header, and response-envelope
 * invariants of the unified frontend API contract against the REAL application
 * built by `createApiServer` (src/index.ts). The full server is started with the
 * optional infrastructure subsystems disabled (ENABLE_REDIS/QUEUES/WEBSOCKET/
 * CRON/METRICS = false) and `nodeEnv = 'test'`, so route registration, the
 * version-header middleware, the dual-path rewrite, and the response wrapper all
 * run exactly as in production while the database is the embedded PGlite engine.
 *
 * Assertions (Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 1.4):
 *  - R2 dual-path resolution + resource names do NOT 404 on the unversioned and
 *    versioned forms (R7.1, R2.*, R1.*).
 *  - GET /api/findings and GET /api/tasks return 404 (R7.2, R2.6).
 *  - Every /api success satisfies the Success_Envelope invariant and every /api
 *    error satisfies the Error_Envelope invariant (R7.3, R4, R5).
 *  - X-API-Version is present, identical across responses, and its major.minor
 *    equals Shared_API_Version's major.minor (R7.4, R3.2/3.3/3.4/3.7).
 *  - The wrapper does not double-wrap an already-wrapped body (R7.5, R6).
 *  - GET /api/v2/... returns 404 with VERSION_NOT_FOUND (R1.4).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 1.4
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { API_VERSION } from '@alsaqi/shared';
import { VERSION_SOURCE } from '../utils/apiVersionSource.js';
import { createApiServer } from '../index.js';
import type { ApiServer } from '../index.js';

// ─── Resources from Requirement 2 (must resolve, never 404 as unknown route) ──
// GET resources, expressed on the unversioned `/api` base; the versioned
// `/api/v1` form is derived per resource for the dual-path check (R2.7).
const GET_RESOURCES = [
  'audit-findings',
  'audit-tasks',
  'my-tasks',
  'audit-plans',
  'recommendations',
  'risk-register',
  'correspondence/incoming',
  'correspondence/outgoing',
  'correspondence/archive',
  'users',
  'departments',
  'dashboard-stats',
  'auth/me',
] as const;

// Authentication endpoints (POST) from R2.5 that must also resolve (never 404).
const AUTH_POST_ENDPOINTS = [
  'auth/login',
  'auth/refresh',
  'auth/logout',
  'auth/change-password',
] as const;

// Incorrect resource names that MUST 404 (R2.6).
const INCORRECT_RESOURCES = ['findings', 'tasks'] as const;

function majorMinor(version: string): string {
  const parts = version.split('.');
  return `${parts[0] ?? ''}.${parts[1] ?? ''}`;
}

describe('Task 7.1: API contract alignment (routing, resource names, version header, envelope)', () => {
  let server: ApiServer;
  let app: import('express').Express;
  let request: typeof import('supertest').default;
  let adminToken: string;

  // Accumulates EVERY response produced during the suite so the version-header
  // consistency assertion can confirm the value is identical across them all.
  const allResponses: Array<import('supertest').Response> = [];

  /** Fire a request, record its response (for the header-consistency check), and return it. */
  async function fire(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    opts: { auth?: boolean } = {}
  ): Promise<import('supertest').Response> {
    let req = request(app)[method](path);
    if (opts.auth) {
      req = req.set('Authorization', `Bearer ${adminToken}`);
    }
    const res = await req;
    allResponses.push(res);
    return res;
  }

  /** Assert the unified envelope invariant appropriate to the response status. */
  function assertEnvelope(res: import('supertest').Response, context: string): void {
    const body = res.body;
    if (res.status >= 200 && res.status < 300) {
      // Success_Envelope invariant (R4.1, R4.2).
      expect(body.success, `${context}: success === true`).toBe(true);
      expect(body, `${context}: has data field`).toHaveProperty('data');
      expect(typeof body.meta, `${context}: meta is object`).toBe('object');
      expect(body.meta, `${context}: meta not null`).not.toBeNull();
    } else if (res.status >= 400) {
      // Error_Envelope invariant (R5.1–R5.4).
      expect(body.success, `${context}: success === false`).toBe(false);
      expect(body.data, `${context}: data === null`).toBeNull();
      expect(body.error, `${context}: error is object`).toBeTypeOf('object');
      expect(body.error, `${context}: error not null`).not.toBeNull();
      expect(typeof body.error.code, `${context}: error.code is string`).toBe('string');
      expect(body.error.code.length, `${context}: error.code non-empty`).toBeGreaterThan(0);
      expect(typeof body.error.message, `${context}: error.message is string`).toBe('string');
      expect(body.error.message.length, `${context}: error.message non-empty`).toBeGreaterThan(0);
      // No nested error.error (R6.2).
      expect(
        body.error.error && typeof body.error.error === 'object',
        `${context}: no nested error.error object`
      ).toBeFalsy();
    }
  }

  beforeAll(async () => {
    // Disable optional infrastructure so start() boots only the HTTP/route layer
    // backed by the embedded PGlite database.
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_REDIS = 'false';
    process.env.ENABLE_QUEUES = 'false';
    process.env.ENABLE_WEBSOCKET = 'false';
    process.env.ENABLE_CRON = 'false';
    process.env.ENABLE_METRICS = 'false';
    // SecureFileService.assertConfigured() requires a >= 32-char file-access secret.
    if (!process.env.FILE_ACCESS_SECRET || process.env.FILE_ACCESS_SECRET.length < 32) {
      process.env.FILE_ACCESS_SECRET = 'contract-test-file-access-secret-0123456789';
    }
    // Use the embedded PGlite engine (no external DATABASE_URL in the test env).
    delete process.env.DATABASE_URL;
    // Point the embedded engine at a unique, per-suite on-disk data dir so this
    // full-server suite does not contend with the other contract/integration
    // suites for the shared default PGlite directory (which reproducibly aborts
    // the engine when suites run together). Set BEFORE createApiServer/start so
    // it is read when PGlite is lazily created during start().
    process.env.PGLITE_DATA_DIR = path.join(
      os.tmpdir(),
      `pglite_contract_alignment_${process.pid}`
    );

    // Generate an RSA key pair so the app verifies tokens (RS256) we mint here.
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

    // Mint an admin token for the seeded admin user so authenticated success
    // paths exercise the Success_Envelope branch.
    const { db } = await import('../db/index.js');
    const admin = (await db
      .prepare("SELECT id, session_version FROM users WHERE username = 'admin' LIMIT 1")
      .get()) as { id: string; session_version: number } | undefined;
    if (!admin) {
      throw new Error('Seeded admin user not found; cannot mint contract-test token');
    }
    adminToken = jwt.sign(
      { id: admin.id, session_version: admin.session_version ?? 1, role: 'Admin' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h' }
    );
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  // ─── R7.1 / R2.* / R1.* — dual-path resolution + resource names ─────────────
  it('resolves every Requirement-2 resource (no 404) on both unversioned and versioned forms', async () => {
    for (const resource of GET_RESOURCES) {
      const unversioned = await fire('get', `/api/${resource}`, { auth: true });
      const versioned = await fire('get', `/api/v1/${resource}`, { auth: true });

      expect(
        unversioned.status,
        `GET /api/${resource} must resolve (not 404)`
      ).not.toBe(404);
      expect(
        versioned.status,
        `GET /api/v1/${resource} must resolve (not 404)`
      ).not.toBe(404);
    }

    for (const endpoint of AUTH_POST_ENDPOINTS) {
      const unversioned = await fire('post', `/api/${endpoint}`);
      const versioned = await fire('post', `/api/v1/${endpoint}`);
      expect(
        unversioned.status,
        `POST /api/${endpoint} must resolve (not 404)`
      ).not.toBe(404);
      expect(
        versioned.status,
        `POST /api/v1/${endpoint} must resolve (not 404)`
      ).not.toBe(404);
    }
  });

  // ─── R7.2 / R2.6 — incorrect resource names return 404 ──────────────────────
  it('returns 404 for the incorrect resource names /api/findings and /api/tasks (both forms)', async () => {
    for (const resource of INCORRECT_RESOURCES) {
      const unversioned = await fire('get', `/api/${resource}`, { auth: true });
      const versioned = await fire('get', `/api/v1/${resource}`, { auth: true });
      expect(unversioned.status, `GET /api/${resource} should be 404`).toBe(404);
      expect(versioned.status, `GET /api/v1/${resource} should be 404`).toBe(404);
    }
  });

  // ─── R7.3 / R4 / R5 — every success/error satisfies its envelope invariant ──
  it('produces a Success_Envelope for every 2xx and an Error_Envelope for every error', async () => {
    // Guaranteed success paths.
    const successCandidates = [
      await fire('get', '/api/health'),
      await fire('get', '/api/users', { auth: true }),
      await fire('get', '/api/auth/me', { auth: true }),
      await fire('get', '/api/notifications', { auth: true }),
    ];

    // Guaranteed error paths covering several error producers:
    //  - unauthenticated 401 (auth middleware),
    //  - unknown route 404 (notFoundHandler),
    //  - unsupported version 404 (unsupportedVersionHandler),
    //  - incorrect resource 404.
    const errorCandidates = [
      await fire('get', '/api/users'), // unauthenticated → 401
      await fire('get', '/api/notifications'), // unauthenticated → 401
      await fire('get', '/api/this-route-does-not-exist', { auth: true }), // 404
      await fire('get', '/api/v2/audit-findings'), // 404 VERSION_NOT_FOUND
      await fire('get', '/api/findings', { auth: true }), // 404
    ];

    // At least one genuine 2xx must be present so the success branch is exercised.
    expect(successCandidates.some((r) => r.status >= 200 && r.status < 300)).toBe(true);

    for (const res of [...successCandidates, ...errorCandidates]) {
      assertEnvelope(res, `${res.req.method} ${res.req.path}`);
    }

    // Every error candidate must indeed be an error status.
    for (const res of errorCandidates) {
      expect(res.status, `${res.req.method} ${res.req.path} should be an error`).toBeGreaterThanOrEqual(400);
    }
  });

  // ─── R7.5 / R6 — no double-wrapping of an already-wrapped body ──────────────
  it('does not double-wrap an already-wrapped success body', async () => {
    // GET /api/users returns a body the route already wrapped via
    // createSuccessResponse; the response wrapper must pass it through unchanged.
    const res = await fire('get', '/api/users', { auth: true });
    expect(res.status).toBe(200);

    const body = res.body;
    // Exactly one top-level success and meta.
    expect(body.success).toBe(true);
    expect(typeof body.meta).toBe('object');
    // data must NOT itself be a Response_Envelope (no nested success+meta) (R6.3).
    const data = body.data;
    const dataIsEnvelope =
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      'success' in data &&
      typeof (data as any).success === 'boolean' &&
      'meta' in data &&
      typeof (data as any).meta === 'object';
    expect(dataIsEnvelope, 'data must not itself be a wrapped envelope').toBe(false);
  });

  // ─── R1.4 — unsupported version returns 404 VERSION_NOT_FOUND ───────────────
  it('returns 404 with VERSION_NOT_FOUND for /api/v2/* (unsupported version)', async () => {
    const res = await fire('get', '/api/v2/audit-findings');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
  });

  // ─── R7.4 / R3.2/3.3/3.4/3.7 — version header present, identical, major.minor ─
  it('sends X-API-Version present, identical across all responses, with matching major.minor', async () => {
    // This test runs last: allResponses now holds every response fired above.
    expect(allResponses.length).toBeGreaterThan(0);

    const headers = allResponses.map((r) => r.headers['x-api-version']);

    // Present on every response (R3.2).
    for (const h of headers) {
      expect(h, 'X-API-Version present on every /api response').toBeDefined();
    }

    // Identical across all responses (R3.7) and equal to the single source.
    const unique = new Set(headers);
    expect(unique.size, 'X-API-Version identical across all responses').toBe(1);
    expect([...unique][0]).toBe(VERSION_SOURCE);

    // major.minor equals Shared_API_Version major.minor (R3.3, R3.4).
    expect(majorMinor(String(headers[0]))).toBe(majorMinor(API_VERSION));
  });
});

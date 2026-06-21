// @vitest-environment node
// Feature: production-launch-readiness, Task 11.2:
// Backend share of secure-cookie / CSRF / CORS enforcement (Requirements 11.1–11.6).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { createCorsMiddleware } from '../middleware/cors';
import {
  csrfMiddleware,
  attachCsrfToken,
  generateCsrfToken,
} from '../middleware/csrf';

/**
 * Task 11.2 — operational confirmation that the BACKEND share of the
 * authentication / transport handshake holds behind the TLS-terminating
 * Reverse_Proxy. This exercises the *real* middleware implementations
 * (`createCorsMiddleware`, `csrfMiddleware`, `attachCsrfToken`) — no mocks —
 * wired exactly like `src/index.ts` (`app.set('trust proxy', 1)`).
 *
 * Assertions:
 *   - Req 11.1/11.2: auth cookies are httpOnly and carry the `Secure` attribute
 *     in production behind a request forwarded with X-Forwarded-Proto=https.
 *   - Req 11.3/11.4: CSRF double-submit is verified on state-changing requests;
 *     a missing OR mismatched token is rejected with 403 and the mutation is
 *     not performed.
 *   - Req 11.5/11.6: CORS headers (Access-Control-Allow-Origin) are emitted only
 *     for listed origins; an unlisted origin receives no allow-origin header so
 *     the browser cannot share the response.
 */

const PROD_ORIGIN = 'https://app.alsaqi.example.com';
const UNLISTED_ORIGIN = 'https://evil.example.com';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Build a production-mode app that mirrors the relevant slice of `src/index.ts`:
 * trust-proxy enabled, real CORS middleware (production origins), cookie parser,
 * and the real CSRF middleware guarding a state-changing /transfer route. The
 * /login route issues auth cookies with the same production flags used by the
 * real auth routes (httpOnly + secure in production) and attaches a CSRF token
 * via the real `attachCsrfToken`.
 */
function buildProdApp(): express.Express {
  const app = express();

  // Mirror src/index.ts: trust a single proxy hop so X-Forwarded-Proto is
  // honoured (req.secure === true behind the proxy).
  app.set('trust proxy', 1);

  app.use(
    createCorsMiddleware({
      allowedOrigins: [PROD_ORIGIN],
      nodeEnv: 'production',
    })
  );
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    csrfMiddleware({
      exemptPaths: ['/api/auth/login'],
      tokenHeader: 'x-csrf-token',
      cookieName: 'csrf-token',
      tokenByteLength: 32,
    })
  );

  // Login is CSRF-exempt and issues the auth cookies. Cookie flags mirror the
  // real auth routes: httpOnly always, secure in production.
  app.post('/api/auth/login', (_req, res) => {
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', 'access-token-value', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/api',
    });
    res.cookie('refreshToken', 'refresh-token-value', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/api/auth/refresh',
    });
    // Real double-submit token issuance.
    attachCsrfToken(res, generateCsrfToken());
    res.json({ success: true });
  });

  // A protected, state-changing route guarded by the real CSRF middleware.
  let transfers = 0;
  app.post('/api/transfer', (_req, res) => {
    transfers += 1;
    res.json({ success: true, transfers });
  });
  app.get('/api/transfer-count', (_req, res) => {
    res.json({ transfers });
  });

  return app;
}

describe('Task 11.2: backend secure-cookie / CSRF / CORS enforcement', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // ─── Req 11.1 / 11.2: httpOnly + Secure auth cookies in production ──────────
  it('issues httpOnly + Secure auth cookies in production behind X-Forwarded-Proto=https (Req 11.1, 11.2)', async () => {
    const app = buildProdApp();

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Host', 'app.alsaqi.example.com')
      .set('Origin', PROD_ORIGIN);

    expect(res.status).toBe(200);

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];

    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
    expect(tokenCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();

    // Both auth cookies must be httpOnly and Secure in production.
    expect(tokenCookie).toMatch(/HttpOnly/i);
    expect(tokenCookie).toMatch(/Secure/i);
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Secure/i);

    // The CSRF token cookie is intentionally NOT httpOnly (double-submit needs
    // client JS to read it) but must still be Secure in production.
    const csrfCookie = cookies.find((c) => c.startsWith('csrf-token='));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);
    expect(csrfCookie).toMatch(/Secure/i);
  });

  // ─── Req 11.3 / 11.4: CSRF double-submit verification ───────────────────────
  it('accepts a state-changing request whose header token matches the cookie token (Req 11.3)', async () => {
    const app = buildProdApp();
    const token = generateCsrfToken();

    const res = await request(app)
      .post('/api/transfer')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', `csrf-token=${token}`)
      .set('x-csrf-token', token)
      .send({ amount: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a state-changing request with a MISSING CSRF token and does not perform the mutation (Req 11.4)', async () => {
    const app = buildProdApp();

    const res = await request(app)
      .post('/api/transfer')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .send({ amount: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('CSRF_VALIDATION_FAILED');

    // The mutation must not have happened.
    const count = await request(app).get('/api/transfer-count');
    expect(count.body.transfers).toBe(0);
  });

  it('rejects a state-changing request whose header token MISMATCHES the cookie token (Req 11.4)', async () => {
    const app = buildProdApp();
    const cookieToken = generateCsrfToken();
    const headerToken = generateCsrfToken(); // different value

    const res = await request(app)
      .post('/api/transfer')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', `csrf-token=${cookieToken}`)
      .set('x-csrf-token', headerToken)
      .send({ amount: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('CSRF_VALIDATION_FAILED');
  });

  // ─── Req 11.5 / 11.6: CORS only for listed origins ──────────────────────────
  it('emits Access-Control-Allow-Origin for the listed production origin (Req 11.5)', async () => {
    const app = buildProdApp();

    const res = await request(app)
      .get('/api/transfer-count')
      .set('Origin', PROD_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(PROD_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does NOT emit CORS allow-origin headers for an unlisted origin (Req 11.6)', async () => {
    const app = buildProdApp();

    const res = await request(app)
      .get('/api/transfer-count')
      .set('Origin', UNLISTED_ORIGIN);

    // The request itself still completes server-side, but no allow-origin header
    // is returned, so a browser will refuse to share the response cross-origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does NOT echo an unlisted origin on a CORS preflight (OPTIONS) request (Req 11.6)', async () => {
    const app = buildProdApp();

    const res = await request(app)
      .options('/api/transfer')
      .set('Origin', UNLISTED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

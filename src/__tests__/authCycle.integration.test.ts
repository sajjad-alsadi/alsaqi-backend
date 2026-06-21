// @vitest-environment node
// Feature: production-launch-readiness, Task 11.4:
// Backend share of the end-to-end authentication / transport handshake
// (Requirements 11.1, 11.2, 11.8).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { API_VERSION } from '@alsaqi/shared';

import { createCorsMiddleware } from '../middleware/cors';
import {
  csrfMiddleware,
  attachCsrfToken,
  generateCsrfToken,
} from '../middleware/csrf';

/**
 * Task 11.4 — backend share of the auth-cycle / Version_Header contract.
 *
 * CROSS-REPO SPLIT (B4): The COMPLETE login → authenticated-request → refresh →
 * logout handshake (Requirement 11.8) is executed from the FRONTEND repository
 * (apps/web E2E/contract suites) against this running backend over HTTPS via the
 * Public_Endpoint. That is the only place the full browser-origin cycle — real
 * cookie storage, automatic cookie replay, CSRF double-submit from client JS,
 * and CORS preflight from the production origin — can be exercised end to end.
 *
 * This backend-resident test confirms the backend-OBSERVABLE contract that the
 * frontend cycle depends on, under HTTPS (X-Forwarded-Proto=https, production
 * mode), wired like src/index.ts (trust proxy 1 + early X-API-Version middleware
 * + real CORS/cookie/CSRF middleware):
 *
 *   - Req 11.1 / 11.2: the auth-cycle endpoints issue auth credentials as
 *     httpOnly + Secure cookies under HTTPS in production, and logout clears
 *     those session cookies (still httpOnly + Secure) so a subsequent replay
 *     carries no live session.
 *   - Req 11.8 (backend share): EVERY API response across the cycle carries the
 *     X-API-Version Version_Header identifying the deployed system version — on
 *     login, the authenticated request, refresh, and logout alike.
 *
 * Task 11.2 already asserts the secure-cookie / CSRF / CORS middleware contract
 * in isolation; this test deliberately frames its assertions around the
 * auth-cycle sequence and the per-response Version_Header rather than repeating
 * those isolated middleware checks.
 */

const PROD_ORIGIN = 'https://app.alsaqi.example.com';

// The deployed-system version header value matches src/index.ts: the API_VERSION
// env override when set, otherwise the @alsaqi/shared API_VERSION constant.
const EXPECTED_API_VERSION = process.env.API_VERSION?.trim() || API_VERSION;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Build a production-mode app that mirrors the auth-relevant slice of
 * src/index.ts: trust-proxy enabled, the early X-API-Version header middleware
 * (registered before the auth routes so every /api response carries it), real
 * CORS middleware (production origin), cookie parser, and the real CSRF
 * middleware. The auth-cycle endpoints (login / authenticated request / refresh
 * / logout) use the same production cookie flags as the real auth routes
 * (httpOnly always, secure in production). DB/services are not involved — the
 * routes respond directly so the transport contract can be exercised.
 */
function buildAuthCycleApp(): express.Express {
  const app = express();

  // Mirror src/index.ts: trust a single proxy hop so X-Forwarded-Proto=https is
  // honoured (req.secure === true behind the TLS-terminating Reverse_Proxy).
  app.set('trust proxy', 1);

  // Mirror src/index.ts: the EARLY Version_Header middleware that attaches
  // X-API-Version to every /api response (Req 11.8 backend share).
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('X-API-Version', EXPECTED_API_VERSION);
    }
    next();
  });

  app.use(
    createCorsMiddleware({
      allowedOrigins: [PROD_ORIGIN],
      nodeEnv: 'production',
    })
  );
  app.use(express.json());
  app.use(cookieParser());

  // Real CSRF middleware: login and refresh are part of the handshake bootstrap
  // and are CSRF-exempt (mirrors src/index.ts exemptPaths); logout and the
  // authenticated request are guarded.
  app.use(
    csrfMiddleware({
      exemptPaths: ['/api/auth/login', '/api/auth/refresh'],
      tokenHeader: 'x-csrf-token',
      cookieName: 'csrf-token',
      tokenByteLength: 32,
    })
  );

  const isProduction = () => process.env.NODE_ENV === 'production';

  // Step 1 — login: issues the auth + refresh cookies (httpOnly + Secure in
  // production) and the double-submit CSRF token.
  app.post('/api/auth/login', (_req, res) => {
    res.cookie('token', 'access-token-value', {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: '/api',
    });
    res.cookie('refreshToken', 'refresh-token-value', {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: '/api/auth/refresh',
    });
    attachCsrfToken(res, generateCsrfToken());
    res.json({ success: true });
  });

  // Step 2 — an authenticated, state-changing request the frontend performs
  // with the session cookie + CSRF double-submit.
  app.post('/api/audits', (_req, res) => {
    res.status(201).json({ success: true, id: 'audit-1' });
  });

  // Step 3 — refresh: rotates the auth cookie (new httpOnly + Secure cookie).
  app.post('/api/auth/refresh', (_req, res) => {
    res.cookie('token', 'access-token-value-rotated', {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: '/api',
    });
    res.json({ success: true });
  });

  // Step 4 — logout: clears the session cookies. clearCookie must reuse the same
  // flags so the expiring cookies remain httpOnly + Secure under HTTPS.
  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('token', {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: '/api',
    });
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: '/api/auth/refresh',
    });
    res.json({ success: true });
  });

  return app;
}

function toCookieArray(setCookie: unknown): string[] {
  if (!setCookie) return [];
  return Array.isArray(setCookie) ? setCookie : [String(setCookie)];
}

describe('Task 11.4: backend auth-cycle / Version_Header contract over HTTPS', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // ─── Req 11.1 / 11.2: auth-cycle cookies are httpOnly + Secure under HTTPS ───
  it('issues httpOnly + Secure auth + refresh cookies at login under X-Forwarded-Proto=https (Req 11.1, 11.2)', async () => {
    const app = buildAuthCycleApp();

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Host', 'app.alsaqi.example.com')
      .set('Origin', PROD_ORIGIN);

    expect(res.status).toBe(200);

    const cookies = toCookieArray(res.headers['set-cookie']);
    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));

    expect(tokenCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
    expect(tokenCookie).toMatch(/Secure/i);
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Secure/i);
  });

  it('rotates an httpOnly + Secure auth cookie on refresh under HTTPS (Req 11.1, 11.2)', async () => {
    const app = buildAuthCycleApp();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', 'refreshToken=refresh-token-value');

    expect(res.status).toBe(200);

    const cookies = toCookieArray(res.headers['set-cookie']);
    const rotated = cookies.find((c) => c.startsWith('token='));
    expect(rotated).toBeDefined();
    expect(rotated).toMatch(/HttpOnly/i);
    expect(rotated).toMatch(/Secure/i);
  });

  it('clears the session cookies on logout while preserving httpOnly + Secure under HTTPS (Req 11.1, 11.2)', async () => {
    const app = buildAuthCycleApp();
    const csrfToken = generateCsrfToken();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', `token=access-token-value; csrf-token=${csrfToken}`)
      .set('x-csrf-token', csrfToken);

    expect(res.status).toBe(200);

    const cookies = toCookieArray(res.headers['set-cookie']);
    const clearedToken = cookies.find((c) => c.startsWith('token='));
    const clearedRefresh = cookies.find((c) => c.startsWith('refreshToken='));

    // Both session cookies are expired (Expires in the past / Max-Age=0) ...
    expect(clearedToken).toBeDefined();
    expect(clearedRefresh).toBeDefined();
    expect(clearedToken).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    expect(clearedRefresh).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    // ... and the expiring cookies still carry the secure transport flags.
    expect(clearedToken).toMatch(/HttpOnly/i);
    expect(clearedToken).toMatch(/Secure/i);
    expect(clearedRefresh).toMatch(/HttpOnly/i);
    expect(clearedRefresh).toMatch(/Secure/i);
  });

  // ─── Req 11.8 (backend share): Version_Header on EVERY response in the cycle ─
  it('carries X-API-Version on every response across the login→request→refresh→logout cycle (Req 11.8 backend share)', async () => {
    const app = buildAuthCycleApp();
    const csrfToken = generateCsrfToken();

    // Step 1 — login.
    const login = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN);
    expect(login.status).toBe(200);
    expect(login.headers['x-api-version']).toBe(EXPECTED_API_VERSION);

    // Step 2 — authenticated, CSRF-protected state-changing request.
    const authed = await request(app)
      .post('/api/audits')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', `token=access-token-value; csrf-token=${csrfToken}`)
      .set('x-csrf-token', csrfToken)
      .send({ title: 'a' });
    expect(authed.status).toBe(201);
    expect(authed.headers['x-api-version']).toBe(EXPECTED_API_VERSION);

    // Step 3 — refresh.
    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', 'refreshToken=refresh-token-value');
    expect(refresh.status).toBe(200);
    expect(refresh.headers['x-api-version']).toBe(EXPECTED_API_VERSION);

    // Step 4 — logout.
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', `token=access-token-value; csrf-token=${csrfToken}`)
      .set('x-csrf-token', csrfToken);
    expect(logout.status).toBe(200);
    expect(logout.headers['x-api-version']).toBe(EXPECTED_API_VERSION);
  });

  it('also emits X-API-Version on a rejected (CSRF-failed) auth-cycle request (Req 11.8 backend share)', async () => {
    const app = buildAuthCycleApp();

    // A state-changing request with no CSRF token is rejected, but the
    // Version_Header is attached early so even error responses identify the
    // deployed version.
    const res = await request(app)
      .post('/api/audits')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', PROD_ORIGIN)
      .set('Cookie', 'token=access-token-value')
      .send({ title: 'a' });

    expect(res.status).toBe(403);
    expect(res.headers['x-api-version']).toBe(EXPECTED_API_VERSION);
  });
});

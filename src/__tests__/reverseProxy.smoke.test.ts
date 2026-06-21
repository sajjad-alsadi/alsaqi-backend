// @vitest-environment node
// Feature: production-launch-readiness, Task 8.4: Reverse-proxy integration/smoke test
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Task 8.4 — Reverse_Proxy integration/smoke test (Requirements 4.1, 4.3, 4.6).
 *
 * This suite verifies the two halves of the reverse-proxy contract:
 *
 *  1. App behaviour BEHIND the proxy (supertest, Requirement 4.6):
 *     A minimal Express app configured exactly like `src/index.ts`
 *     (`app.set('trust proxy', 1)`) must treat a request the proxy forwards
 *     with `X-Forwarded-Proto: https` as secure — i.e. `req.protocol` resolves
 *     to `https`, `req.secure` is `true`, absolute URLs are built with the
 *     https scheme, and the Secure-cookie logic fires (the cookie carries the
 *     `Secure` attribute). Without the forwarded header the request is treated
 *     as plain HTTP and the cookie is NOT marked Secure.
 *
 *  2. The Reverse_Proxy config file itself (text assertions, Req 4.1 & 4.3):
 *     `reverse-proxy/nginx.conf` must contain a 308 redirect that preserves the
 *     original path + query string (`$host$request_uri`) and emit an
 *     `Strict-Transport-Security` header whose `max-age` is at least 31536000
 *     seconds (one year).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: App behaviour behind the proxy (X-Forwarded-Proto=https)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that mirrors the trust-proxy setup of
 * `src/index.ts` (`app.set('trust proxy', 1)`). Two tiny routes are exposed:
 *
 *   GET /echo          — reports the proxy-derived protocol/secure flag and an
 *                        absolute URL built from req.protocol + host.
 *   POST /login        — issues an auth cookie whose `Secure` attribute mirrors
 *                        the (forwarded) request's secure-ness, exactly as the
 *                        production Secure-cookie logic does.
 */
function buildProxyAwareApp(): express.Express {
  const app = express();

  // Mirror src/index.ts: trust a single proxy hop so X-Forwarded-Proto/Host are
  // honoured (req.protocol === 'https', req.secure === true behind the proxy).
  app.set('trust proxy', 1);

  app.get('/echo', (req, res) => {
    const absoluteUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    res.json({
      protocol: req.protocol,
      secure: req.secure,
      absoluteUrl,
    });
  });

  app.post('/login', (req, res) => {
    // Secure-cookie logic: a request treated as HTTPS (because the proxy
    // forwarded X-Forwarded-Proto=https) gets a Secure cookie.
    res.cookie('auth', 'token-value', {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
    });
    res.json({ secure: req.secure });
  });

  return app;
}

describe('Task 8.4: reverse-proxy app behaviour behind X-Forwarded-Proto (Req 4.6)', () => {
  it('treats a request forwarded with X-Forwarded-Proto=https as secure and builds https absolute URLs', async () => {
    const app = buildProxyAwareApp();

    const res = await request(app)
      .get('/echo?foo=bar')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'api.example.local')
      .set('Host', 'api.example.local');

    expect(res.status).toBe(200);
    // Req 4.6: forwarded HTTPS protocol is honoured behind trust proxy.
    expect(res.body.protocol).toBe('https');
    expect(res.body.secure).toBe(true);
    // Absolute URLs are constructed with the https scheme.
    expect(res.body.absoluteUrl).toBe('https://api.example.local/echo?foo=bar');
  });

  it('issues a Secure cookie when the request is forwarded as HTTPS (Req 4.6)', async () => {
    const app = buildProxyAwareApp();

    const res = await request(app)
      .post('/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Host', 'api.example.local');

    expect(res.status).toBe(200);
    expect(res.body.secure).toBe(true);

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    // Secure-cookie logic: the auth cookie must carry the Secure attribute.
    expect(cookieHeader).toMatch(/auth=/);
    expect(cookieHeader).toMatch(/Secure/i);
    expect(cookieHeader).toMatch(/HttpOnly/i);
  });

  it('does NOT mark the cookie Secure and treats the request as http without the forwarded header', async () => {
    const app = buildProxyAwareApp();

    const res = await request(app).post('/login').set('Host', 'api.example.local');

    expect(res.status).toBe(200);
    // No X-Forwarded-Proto -> request is plain HTTP, so no Secure attribute.
    expect(res.body.secure).toBe(false);

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '');
    expect(cookieHeader).toMatch(/auth=/);
    expect(cookieHeader).not.toMatch(/Secure/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: Reverse_Proxy config file assertions (reverse-proxy/nginx.conf)
// ─────────────────────────────────────────────────────────────────────────────

function readNginxConf(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/__tests__
  const confPath = path.resolve(here, '..', '..', 'reverse-proxy', 'nginx.conf');
  return readFileSync(confPath, 'utf8');
}

describe('Task 8.4: reverse-proxy config file assertions (Req 4.1, 4.3)', () => {
  it('contains a 308 redirect that preserves the original path + query string (Req 4.1)', () => {
    const conf = readNginxConf();

    // A 308 (Permanent Redirect) to https that preserves $host$request_uri.
    // $request_uri carries the original path AND query string unmodified.
    const redirectRe = /return\s+308\s+https:\/\/\$host\$request_uri\s*;/;
    expect(conf).toMatch(redirectRe);
  });

  it('emits a Strict-Transport-Security header with max-age >= 31536000 (Req 4.3)', () => {
    const conf = readNginxConf();

    // Locate the HSTS header directive and extract its max-age value.
    const hstsMatch = conf.match(/Strict-Transport-Security\s+"([^"]*)"/i);
    expect(hstsMatch).not.toBeNull();

    const headerValue = hstsMatch![1];
    const maxAgeMatch = headerValue.match(/max-age=(\d+)/i);
    expect(maxAgeMatch).not.toBeNull();

    const maxAge = Number(maxAgeMatch![1]);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });
});

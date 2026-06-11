// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { csrfMiddleware } from '../csrf';

/**
 * Property Test: CSRF Exempt Path Bypass (Property 7)
 *
 * **Validates: Requirements 3.4**
 *
 * For any request to an exempt path (login, refresh, register),
 * the CSRF_Middleware SHALL skip validation regardless of token presence or absence.
 *
 * This means:
 * - Requests with no CSRF tokens should pass through (next() called)
 * - Requests with arbitrary/invalid tokens should pass through (next() called)
 * - Requests with mismatched tokens should pass through (next() called)
 * - All state-changing methods (POST, PUT, PATCH, DELETE) on exempt paths bypass CSRF
 */
describe('Property 7: CSRF Exempt Path Bypass', () => {
  const exemptPaths = [
    '/api/auth/login',
    '/api/auth/refresh',
    '/api/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/auth/register',
  ];

  const csrfOptions = {
    exemptPaths,
    tokenHeader: 'x-csrf-token',
    cookieName: 'csrf-token',
    tokenByteLength: 32,
  };

  function createTestApp() {
    const app = express();
    app.use(cookieParser());
    app.use(csrfMiddleware(csrfOptions));

    const handler = (_req: any, res: any) => {
      res.json({ success: true, data: { ok: true } });
    };

    // Register all exempt path routes for each method
    for (const path of exemptPaths) {
      app.post(path, handler);
      app.put(path, handler);
      app.patch(path, handler);
      app.delete(path, handler);
    }

    return app;
  }

  // Arbitrary for exempt paths
  const exemptPathArb = fc.constantFrom(...exemptPaths);

  // Arbitrary for state-changing HTTP methods
  const stateChangingMethodArb = fc.constantFrom('post', 'put', 'patch', 'delete') as fc.Arbitrary<'post' | 'put' | 'patch' | 'delete'>;

  // Arbitrary for random token strings (simulating arbitrary tokens)
  const arbitraryTokenArb = fc.oneof(
    // Hex-like tokens
    fc.string({ minLength: 1, maxLength: 128, unit: fc.constantFrom(...'0123456789abcdef'.split('')) }),
    // Random alphanumeric strings
    fc.string({ minLength: 1, maxLength: 64, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) }),
    // Very short tokens
    fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom(...'abc123'.split('')) }),
  );

  // Arbitrary for token presence scenarios
  const tokenScenarioArb = fc.oneof(
    // No tokens at all
    fc.constant({ headerToken: undefined, cookieToken: undefined } as { headerToken: string | undefined; cookieToken: string | undefined }),
    // Only header token (no cookie)
    arbitraryTokenArb.map(t => ({ headerToken: t, cookieToken: undefined } as { headerToken: string | undefined; cookieToken: string | undefined })),
    // Only cookie token (no header)
    arbitraryTokenArb.map(t => ({ headerToken: undefined, cookieToken: t } as { headerToken: string | undefined; cookieToken: string | undefined })),
    // Both tokens present but mismatched
    fc.tuple(arbitraryTokenArb, arbitraryTokenArb)
      .filter(([a, b]) => a !== b)
      .map(([h, c]) => ({ headerToken: h, cookieToken: c })),
    // Both tokens present and matching
    arbitraryTokenArb.map(t => ({ headerToken: t, cookieToken: t })),
  );

  it('exempt paths bypass CSRF validation regardless of token presence or absence', async () => {
    await fc.assert(
      fc.asyncProperty(
        exemptPathArb,
        stateChangingMethodArb,
        tokenScenarioArb,
        async (path, method, tokenScenario) => {
          const app = createTestApp();

          let req = (request(app) as any)[method](path);

          // Apply token scenario
          if (tokenScenario.headerToken) {
            req = req.set('x-csrf-token', tokenScenario.headerToken);
          }
          if (tokenScenario.cookieToken) {
            req = req.set('Cookie', `csrf-token=${tokenScenario.cookieToken}`);
          }

          const res = await req.send({});

          // Exempt paths should always pass through (200), never get 403 CSRF error
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('exempt paths with completely missing tokens still bypass CSRF', async () => {
    await fc.assert(
      fc.asyncProperty(
        exemptPathArb,
        stateChangingMethodArb,
        async (path, method) => {
          const app = createTestApp();

          // Send request with no CSRF tokens at all
          const res = await (request(app) as any)[method](path).send({});

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('exempt paths with arbitrary header tokens (no cookie) bypass CSRF', async () => {
    await fc.assert(
      fc.asyncProperty(
        exemptPathArb,
        stateChangingMethodArb,
        arbitraryTokenArb,
        async (path, method, token) => {
          const app = createTestApp();

          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', token)
            .send({});

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createCorsMiddleware } from '../cors';
import { csrfMiddleware } from '../csrf';

/**
 * Property Test: CORS Origin Rejection (Property 7)
 *
 * **Validates: Requirements 8.1**
 *
 * For any origin string NOT in the configured allowedOrigins list,
 * CORS middleware should not add access-control-allow-origin header
 * in the response.
 */
describe('Property 7: CORS Origin Rejection', () => {
  /**
   * Arbitrary to generate valid origin URLs that are NOT in the allowed list.
   * We use a fixed allowed list and generate arbitrary origins guaranteed not to match.
   */
  const allowedOrigins = [
    'https://app.alsaqi.com',
    'https://admin.alsaqi.com',
    'http://localhost:5173',
  ];

  // Generate random origin-like strings that are NOT in the allowed list
  const unllistedOriginArb = fc
    .tuple(
      fc.constantFrom('http', 'https'),
      fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.[a-z]{2,6}$/),
    )
    .map(([protocol, domain]) => `${protocol}://${domain}`)
    .filter((origin) => !allowedOrigins.includes(origin));

  function createTestApp(origins: string[], nodeEnv: 'production' | 'development' = 'production') {
    const app = express();
    app.use(createCorsMiddleware({ allowedOrigins: origins, nodeEnv }));
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true });
    });
    app.options('/api/test', (_req, res) => {
      res.sendStatus(204);
    });
    return app;
  }

  it('requests from unlisted origins do not receive access-control-allow-origin header', async () => {
    await fc.assert(
      fc.asyncProperty(unllistedOriginArb, async (origin) => {
        const app = createTestApp(allowedOrigins, 'production');

        const res = await request(app)
          .get('/api/test')
          .set('Origin', origin);

        // The response should NOT contain the access-control-allow-origin header
        const acaoHeader = res.headers['access-control-allow-origin'];
        expect(acaoHeader).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('preflight requests from unlisted origins do not receive CORS headers', async () => {
    await fc.assert(
      fc.asyncProperty(unllistedOriginArb, async (origin) => {
        const app = createTestApp(allowedOrigins, 'production');

        const res = await request(app)
          .options('/api/test')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');

        // No CORS headers should be present
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('requests from allowed origins DO receive access-control-allow-origin header', async () => {
    // Sanity check: allowed origins get the header
    const allowedOriginArb = fc.constantFrom(...allowedOrigins);

    await fc.assert(
      fc.asyncProperty(allowedOriginArb, async (origin) => {
        const app = createTestApp(allowedOrigins, 'production');

        const res = await request(app)
          .get('/api/test')
          .set('Origin', origin);

        expect(res.headers['access-control-allow-origin']).toBe(origin);
      }),
      { numRuns: 10 }
    );
  });
});

/**
 * Property Test: CSRF Enforcement on State-Changing Requests (Property 8)
 *
 * **Validates: Requirements 8.2**
 *
 * For any state-changing request (POST, PUT, DELETE) without a valid CSRF
 * token (or with mismatched token), CSRF middleware should reject with 403.
 */
describe('Property 8: CSRF Enforcement on State-Changing Requests', () => {
  const exemptPaths = ['/api/auth/login', '/api/v1/auth/login', '/api/auth/refresh', '/api/v1/auth/refresh'];
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

    // Set up specific test routes to avoid Express 5 path-to-regexp wildcard issues.
    // Register specific routes for the paths we test against.
    const handler = (_req: any, res: any) => {
      res.json({ success: true, data: { ok: true } });
    };

    app.get('/api/v1/findings', handler);
    app.post('/api/v1/findings', handler);
    app.put('/api/v1/findings', handler);
    app.delete('/api/v1/findings', handler);
    app.patch('/api/v1/findings', handler);

    app.get('/api/v1/findings/:id', handler);
    app.post('/api/v1/findings/:id', handler);
    app.put('/api/v1/findings/:id', handler);
    app.delete('/api/v1/findings/:id', handler);
    app.patch('/api/v1/findings/:id', handler);

    // Exempt paths for comparison
    app.post('/api/auth/login', handler);
    app.post('/api/v1/auth/login', handler);
    app.post('/api/auth/refresh', handler);
    app.post('/api/v1/auth/refresh', handler);

    return app;
  }

  // Generate non-exempt API paths (state-changing endpoints)
  const nonExemptPathArb = fc.constantFrom(
    '/api/v1/findings',
    '/api/v1/findings/1',
    '/api/v1/findings/123',
  );

  // Generate state-changing HTTP methods
  const stateChangingMethodArb = fc.constantFrom('post', 'put', 'delete', 'patch');

  // Generate random token strings (to simulate missing or mismatched tokens)
  const randomTokenArb = fc.string({ minLength: 10, maxLength: 64, unit: fc.constantFrom(...'0123456789abcdef'.split('')) });

  it('state-changing requests without CSRF token are rejected with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        async (method, path) => {
          const app = createTestApp();

          // Send request without any CSRF token (no header, no cookie)
          const res = await (request(app) as any)[method](path)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('state-changing requests with mismatched CSRF token are rejected with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        randomTokenArb,
        randomTokenArb,
        async (method, path, headerToken, cookieToken) => {
          // Ensure tokens are different
          fc.pre(headerToken !== cookieToken);

          const app = createTestApp();

          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', headerToken)
            .set('Cookie', `csrf-token=${cookieToken}`)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('state-changing requests with header token but no cookie are rejected with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        randomTokenArb,
        async (method, path, token) => {
          const app = createTestApp();

          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', token)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('state-changing requests with matching CSRF token are allowed (200)', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        randomTokenArb,
        async (method, path, token) => {
          // Ensure token is non-empty (valid)
          fc.pre(token.length > 0);

          const app = createTestApp();

          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', token)
            .set('Cookie', `csrf-token=${token}`)
            .send({});

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('GET requests bypass CSRF validation regardless of token presence', async () => {
    const app = createTestApp();

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('/api/v1/findings'),
        async (path) => {
          // GET without any token should succeed
          const res = await request(app)
            .get(path);

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 10 }
    );
  });

  it('exempt paths bypass CSRF validation for state-changing methods', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('/api/auth/login', '/api/v1/auth/login', '/api/auth/refresh', '/api/v1/auth/refresh'),
        async (path) => {
          const app = createTestApp();

          // POST to exempt path without CSRF token should succeed
          const res = await request(app)
            .post(path)
            .send({ username: 'test', password: 'test' });

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 10 }
    );
  });
});

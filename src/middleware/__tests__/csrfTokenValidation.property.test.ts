// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { csrfMiddleware } from '../csrf';

/**
 * Property Test: CSRF Token Validation on State-Changing Methods (Property 6)
 *
 * **Validates: Requirements 3.1, 3.2**
 *
 * For any POST, PUT, PATCH, or DELETE request to a non-exempt path, if the
 * `x-csrf-token` header value does not match the `csrf-token` cookie value,
 * the CSRF_Middleware SHALL respond with HTTP 403 and error code
 * CSRF_VALIDATION_FAILED.
 */
describe('Property 6: CSRF Token Validation on State-Changing Methods', () => {
  const exemptPaths = [
    '/api/auth/login',
    '/api/v1/auth/login',
    '/api/auth/refresh',
    '/api/v1/auth/refresh',
    '/api/auth/register',
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

    // Register routes for state-changing methods
    app.post('/api/v1/resources', handler);
    app.put('/api/v1/resources', handler);
    app.patch('/api/v1/resources', handler);
    app.delete('/api/v1/resources', handler);
    app.post('/api/v1/resources/:id', handler);
    app.put('/api/v1/resources/:id', handler);
    app.patch('/api/v1/resources/:id', handler);
    app.delete('/api/v1/resources/:id', handler);

    return app;
  }

  // Generate state-changing HTTP methods
  const stateChangingMethodArb = fc.constantFrom('post', 'put', 'patch', 'delete') as fc.Arbitrary<'post' | 'put' | 'patch' | 'delete'>;

  // Non-exempt API paths
  const nonExemptPathArb = fc.constantFrom(
    '/api/v1/resources',
    '/api/v1/resources/1',
    '/api/v1/resources/42',
  );

  // Generate random hex token strings (simulating real CSRF tokens)
  const tokenArb = fc.string({
    minLength: 8,
    maxLength: 64,
    unit: fc.constantFrom(...'0123456789abcdef'.split('')),
  });

  // Generate pairs of tokens that are guaranteed to be different
  const mismatchedTokenPairArb = fc
    .tuple(tokenArb, tokenArb)
    .filter(([a, b]) => a !== b);

  it('mismatched header and cookie tokens produce 403 with CSRF_VALIDATION_FAILED', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        mismatchedTokenPairArb,
        async (method, path, [headerToken, cookieToken]) => {
          const app = createTestApp();

          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', headerToken)
            .set('Cookie', `csrf-token=${cookieToken}`)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('missing header token produces 403 with CSRF_VALIDATION_FAILED', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        tokenArb,
        async (method, path, cookieToken) => {
          const app = createTestApp();

          // Cookie is present but header is missing
          const res = await (request(app) as any)[method](path)
            .set('Cookie', `csrf-token=${cookieToken}`)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('missing cookie token produces 403 with CSRF_VALIDATION_FAILED', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateChangingMethodArb,
        nonExemptPathArb,
        tokenArb,
        async (method, path, headerToken) => {
          const app = createTestApp();

          // Header is present but cookie is missing
          const res = await (request(app) as any)[method](path)
            .set('x-csrf-token', headerToken)
            .send({});

          expect(res.status).toBe(403);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createResponseWrapper } from '../responseWrapper';

/**
 * Property Test: Success envelope invariant
 *
 * Feature: backend-api-contract-alignment, Property 4: unwrapped 2xx body
 * becomes success envelope with data and meta
 *
 * **Validates: Requirements 4.1, 4.2, 4.4**
 *
 * For any unwrapped JSON-serializable body returned by a route handler with a
 * 2xx status code, the Response_Wrapper (`createResponseWrapper`, which
 * intercepts `res.json()`) SHALL produce a Success_Envelope such that:
 *   - `success` is the boolean `true`                              (R4.1)
 *   - a `data` field and a `meta` object are present              (R4.2)
 *   - the original (unwrapped) body is placed in the `data` field (R4.4)
 *
 * A minimal Express app mounts `createResponseWrapper` ahead of a single echo
 * route that replays a generated 2xx status code and body. fast-check drives
 * arbitrary JSON-serializable bodies and 2xx status codes (min 100 runs via the
 * global setup in src/test/setupPropertyTests.ts).
 *
 * Scope note: bodies that are already wrapped (Property 7) or that carry a
 * top-level `pagination` field lifted into `meta.pagination` (Property 5) are
 * excluded here so this property isolates the plain unwrapped-success case
 * where `data` must equal the original body verbatim.
 */

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * A response body is "already wrapped" when it is an object carrying a boolean
 * `success` and an object `meta` (mirrors the wrapper's `isAlreadyWrapped`).
 * Such bodies pass through unchanged, so they are excluded from this property.
 */
function isAlreadyWrapped(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'success' in (body as Record<string, unknown>) &&
    typeof (body as Record<string, unknown>).success === 'boolean' &&
    'meta' in (body as Record<string, unknown>) &&
    (body as Record<string, unknown>).meta !== null &&
    typeof (body as Record<string, unknown>).meta === 'object'
  );
}

/** Top-level objects with a `pagination` key are lifted (Property 5) — exclude. */
function hasTopLevelPagination(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'pagination' in (body as Record<string, unknown>)
  );
}

/** Avoid keys that can mutate Object.prototype when parsed by body-parser. */
function hasUnsafeKey(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some(hasUnsafeKey);
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (hasUnsafeKey(obj[key])) return true;
  }
  return false;
}

/** Arbitrary JSON-serializable body that is NOT already wrapped / paginated. */
const unwrappedBodyArb = fc
  .jsonValue()
  .filter((b) => !isAlreadyWrapped(b) && !hasTopLevelPagination(b) && !hasUnsafeKey(b));

/**
 * 2xx status codes that send a body. 204 and 205 are excluded because Express
 * strips the body for those statuses, so there is no envelope to assert on.
 */
const successStatusArb = fc.constantFrom(200, 201, 202, 203, 206, 207, 226);

// ─── Test App Factory ─────────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Provide a correlation id so the wrapper's meta.requestId is populated,
  // mirroring the correlation-id middleware in src/index.ts.
  app.use((req, _res, next) => {
    (req as any).correlationId = 'test-correlation-id';
    next();
  });

  // The middleware under test: intercepts res.json() and wraps unwrapped bodies.
  app.use(createResponseWrapper());

  // Echo route: replays the generated status code and body.
  app.post('/api/echo', (req, res) => {
    const { status, payload } = req.body as { status: number; payload: unknown };
    res.status(status).json(payload);
  });

  return app;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('Property 4: unwrapped 2xx body becomes success envelope with data and meta', () => {
  it('wraps any unwrapped 2xx body into a Success_Envelope (success=true, data=original body, meta object)', async () => {
    await fc.assert(
      fc.asyncProperty(successStatusArb, unwrappedBodyArb, async (status, payload) => {
        const app = createTestApp();

        const res = await request(app)
          .post('/api/echo')
          .set('Content-Type', 'application/json')
          .send({ status, payload });

        // The handler used the generated 2xx status.
        expect(res.status).toBe(status);

        const body = res.body;

        // R4.1: success is the boolean true.
        expect(body.success).toBe(true);

        // R4.2: a `data` field and a `meta` object are present.
        expect(body).toHaveProperty('data');
        expect(body.meta).toBeDefined();
        expect(typeof body.meta).toBe('object');
        expect(body.meta).not.toBeNull();

        // R4.4: the original unwrapped body is placed in `data` verbatim.
        // (JSON round-trips through the request/response, so null stays null.)
        expect(body.data).toEqual(payload ?? null);
      }),
      { numRuns: 100 }
    );
  });
});

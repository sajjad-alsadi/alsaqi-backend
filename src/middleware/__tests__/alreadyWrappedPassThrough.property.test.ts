// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createResponseWrapper } from '../responseWrapper';

/**
 * Property Test: Already-wrapped pass-through (idempotence)
 *
 * Feature: backend-api-contract-alignment, Property 7: already-wrapped body
 * passes through unchanged with exactly one top-level success and meta
 *
 * **Validates: Requirements 6.1, 6.3, 6.4**
 *
 * When a route handler returns a body that already carries both a boolean
 * `success` field and an object `meta` field, the Response_Wrapper
 * (`createResponseWrapper`, which intercepts `res.json()`) treats it as already
 * wrapped and passes it through unchanged. Therefore, for any such already-
 * wrapped body:
 *   - the response body equals the input verbatim (no re-wrapping)        (R6.1)
 *   - the `data` field is NOT itself a Response_Envelope (no nested
 *     `data.success` + `data.meta`)                                       (R6.3)
 *   - the final body contains exactly one top-level `success` field and
 *     exactly one top-level `meta` object (idempotence)                   (R6.4)
 *
 * A minimal Express app mounts `createResponseWrapper` ahead of a single echo
 * route that replays a generated 2xx status code and an already-wrapped body.
 * fast-check drives arbitrary already-wrapped bodies (boolean `success`, object
 * `meta`, and arbitrary JSON-serializable `data`) with min 100 runs via the
 * global setup in src/test/setupPropertyTests.ts.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Mirror of the wrapper's `isAlreadyWrapped`: an object carrying a boolean
 * `success` and a non-null object `meta`.
 */
function isWrappedEnvelope(body: unknown): boolean {
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

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * Arbitrary JSON-serializable `data` payload that is free of unsafe keys and is
 * not itself a wrapped envelope, so the R6.3 assertion (data must not be a
 * Response_Envelope) tests the wrapper rather than a coincidental input shape.
 */
const dataArb = fc.jsonValue().filter((d) => !hasUnsafeKey(d) && !isWrappedEnvelope(d));

/** Arbitrary `meta` object (always a non-null object). */
const metaArb = fc
  .record(
    {
      requestId: fc.string(),
      timestamp: fc.string(),
      version: fc.string(),
      extra: fc.option(fc.jsonValue(), { nil: undefined }),
    },
    { requiredKeys: [] }
  )
  .filter((m) => !hasUnsafeKey(m));

/**
 * An already-wrapped body: boolean `success`, object `meta`, and arbitrary
 * `data`. Optionally carries an `error` object so both success and error
 * envelope shapes are exercised.
 */
const alreadyWrappedBodyArb = fc
  .record(
    {
      success: fc.boolean(),
      data: dataArb,
      meta: metaArb,
      error: fc.option(
        fc.record({ code: fc.string(), message: fc.string() }),
        { nil: undefined }
      ),
    },
    { requiredKeys: ['success', 'data', 'meta'] }
  )
  .filter((b) => !hasUnsafeKey(b))
  // Guard: ensure the generated body actually satisfies isAlreadyWrapped.
  .filter((b) => isWrappedEnvelope(b));

/**
 * 2xx status codes that send a body. 204 and 205 are excluded because Express
 * strips the body for those statuses, so there is no envelope to assert on.
 */
const successStatusArb = fc.constantFrom(200, 201, 202, 203, 206, 207, 226);

// ─── Test App Factory ─────────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Provide a correlation id, mirroring the correlation-id middleware.
  app.use((req, _res, next) => {
    (req as any).correlationId = 'test-correlation-id';
    next();
  });

  // The middleware under test: intercepts res.json() and wraps unwrapped bodies.
  app.use(createResponseWrapper());

  // Echo route: replays the generated status code and already-wrapped body.
  app.post('/api/echo', (req, res) => {
    const { status, payload } = req.body as { status: number; payload: unknown };
    res.status(status).json(payload);
  });

  return app;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('Property 7: already-wrapped body passes through unchanged with exactly one top-level success and meta', () => {
  it('passes an already-wrapped body through unchanged (idempotence: no double-wrap, single success + meta)', async () => {
    await fc.assert(
      fc.asyncProperty(successStatusArb, alreadyWrappedBodyArb, async (status, payload) => {
        const app = createTestApp();

        const res = await request(app)
          .post('/api/echo')
          .set('Content-Type', 'application/json')
          .send({ status, payload });

        // The handler used the generated 2xx status.
        expect(res.status).toBe(status);

        const body = res.body;

        // R6.1: the already-wrapped body is passed through unchanged (verbatim).
        // No re-wrapping occurred. The expected value is the JSON round-trip of
        // the payload so both sides are normalized identically (e.g. JSON
        // serialization maps -0 to 0); this keeps the comparison deterministic
        // while still asserting verbatim pass-through.
        expect(body).toEqual(JSON.parse(JSON.stringify(payload)));

        // R6.4: exactly one top-level `success` field and one top-level `meta`
        // object. Counting own enumerable keys guarantees no duplication.
        const keys = Object.keys(body);
        expect(keys.filter((k) => k === 'success')).toHaveLength(1);
        expect(keys.filter((k) => k === 'meta')).toHaveLength(1);
        expect(typeof body.success).toBe('boolean');
        expect(body.meta).toBeDefined();
        expect(typeof body.meta).toBe('object');
        expect(body.meta).not.toBeNull();

        // R6.3: the `data` field is NOT itself a Response_Envelope (i.e. it does
        // not itself carry a boolean `success` plus an object `meta`).
        expect(isWrappedEnvelope(body.data)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

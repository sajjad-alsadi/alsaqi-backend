// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createResponseWrapper } from '../responseWrapper';

/**
 * Property Test: No nested error.error
 *
 * Feature: backend-api-contract-alignment, Property 8: error body with object
 * error field does not produce nested error.error
 *
 * **Validates: Requirements 6.2**
 *
 * When a route handler returns an unwrapped error body (status >= 400) that
 * carries a non-empty object `error` field (e.g. `{ error: { code, message } }`),
 * the Response_Wrapper (`createResponseWrapper`, which intercepts `res.json()`)
 * lifts that inner error OBJECT straight onto the canonical envelope's `error`
 * field rather than nesting it under `error.error`. Therefore, for any such
 * error body the produced Error_Envelope SHALL NOT contain a nested
 * `error.error` field (the structure stays exactly one level deep).      (R6.2)
 *
 * A minimal Express app mounts `createResponseWrapper` ahead of a single echo
 * route that replays a generated >=400 status code and a body whose `error`
 * field is an object. fast-check drives arbitrary >=400 status codes and
 * arbitrary object-`error` bodies (with and without code/message, and with
 * extra sibling fields) with min 100 runs via the global setup in
 * src/test/setupPropertyTests.ts.
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
 * A body is "already wrapped" when it carries a boolean `success` and an object
 * `meta` (mirrors the wrapper's `isAlreadyWrapped`). Such bodies pass through
 * unchanged, so they are excluded so this property isolates the unwrapped
 * object-`error` case.
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

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * Reserved keys excluded from extra sibling fields so the generated body does
 * not accidentally become already-wrapped (`success`/`meta`) or carry a
 * top-level `pagination` (lifted into `meta`); `data` is allowed as a sibling
 * since the wrapper reads it but it does not affect the nested-error invariant.
 */
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype', 'success', 'meta', 'pagination'];

const extraFieldsArb = fc.dictionary(
  fc.string().filter((k) => k.length > 0 && !RESERVED_KEYS.includes(k) && k !== 'error'),
  fc.jsonValue(),
  { maxKeys: 4 }
);

/**
 * A non-empty object suitable to be the inner `error` payload. It may carry a
 * `code`/`message` (the realistic shape) or arbitrary fields. It never carries
 * its own `error` key, so any `error.error` in the produced envelope can only
 * come from the wrapper double-nesting — which is what R6.2 forbids.
 */
const innerErrorObjectArb = fc
  .record(
    {
      code: fc.option(fc.string(), { nil: undefined }),
      message: fc.option(fc.string(), { nil: undefined }),
      extras: extraFieldsArb,
    },
    { requiredKeys: ['extras'] }
  )
  .map(({ code, message, extras }) => {
    const o: Record<string, unknown> = { ...extras };
    if (code !== undefined) o.code = code;
    if (message !== undefined) o.message = message;
    return o;
  })
  // Guarantee a non-empty object error field (the precondition for lifting).
  .map((o) => (Object.keys(o).length === 0 ? { code: 'E', message: 'm' } : o));

/**
 * An unwrapped error body whose `error` field is a (non-empty) object, optionally
 * with extra sibling fields alongside it.
 */
const objectErrorBodyArb = fc
  .record(
    {
      error: innerErrorObjectArb,
      siblings: extraFieldsArb,
    },
    { requiredKeys: ['error'] }
  )
  .map(({ error, siblings }) => ({ ...siblings, error }))
  .filter((b) => !isAlreadyWrapped(b) && !hasUnsafeKey(b));

/** Arbitrary error status codes (client 4xx and server 5xx). */
const errorStatusArb = fc.integer({ min: 400, max: 599 });

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

  // The middleware under test: intercepts res.json() and wraps error bodies.
  app.use(createResponseWrapper());

  // Echo route: replays the generated status code and body.
  app.post('/api/echo', (req, res) => {
    const { status, payload } = req.body as { status: number; payload: unknown };
    res.status(status).json(payload);
  });

  return app;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('Property 8: error body with object error field does not produce nested error.error', () => {
  it('lifts an object error payload onto the canonical envelope without nesting it under error.error', async () => {
    await fc.assert(
      fc.asyncProperty(errorStatusArb, objectErrorBodyArb, async (status, payload) => {
        const app = createTestApp();

        const res = await request(app)
          .post('/api/echo')
          .set('Content-Type', 'application/json')
          .send({ status, payload });

        // The handler used the generated >=400 status.
        expect(res.status).toBe(status);

        const body = res.body;

        // Canonical error envelope: success=false, error is a non-null object.
        expect(body.success).toBe(false);
        expect(body.error).toBeDefined();
        expect(body.error).not.toBeNull();
        expect(typeof body.error).toBe('object');

        // R6.2: the inner object error payload is lifted onto the envelope's
        // `error` field, never nested under `error.error`. The structure stays
        // exactly one level deep.
        expect(Object.prototype.hasOwnProperty.call(body.error, 'error')).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

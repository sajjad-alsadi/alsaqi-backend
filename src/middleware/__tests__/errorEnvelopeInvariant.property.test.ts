// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createResponseWrapper } from '../responseWrapper';

/**
 * Property Test: Error envelope invariant
 *
 * Feature: backend-api-contract-alignment, Property 6: unwrapped >=400 body
 * becomes error envelope with success false, data null, non-empty code/message
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 *
 * For any unwrapped body returned by a route handler with a status code of 400
 * or greater, the Response_Wrapper (`createResponseWrapper`, which intercepts
 * `res.json()`) SHALL produce an Error_Envelope such that:
 *   - `success` is the boolean `false`                                   (R5.1)
 *   - `error` is an object carrying a non-empty `code` and a non-empty
 *     `message` (the `normalizeErrorObject` helper backfills these from the
 *     status code when the raw body omits them)                          (R5.2)
 *   - the error information from the body is placed inside `error`        (R5.3)
 *   - `data` is `null`                                                    (R5.4)
 *   - the canonical envelope has no nested `error.error` field (an object
 *     `error` payload is lifted, not nested)                             (R5.3)
 *
 * A minimal Express app mounts `createResponseWrapper` ahead of a single echo
 * route that replays a generated >=400 status code and body. fast-check drives
 * arbitrary unwrapped error bodies — message strings, bare error objects with
 * and without code/message, and bodies carrying a nested `error` object — plus
 * arbitrary >=400 status codes (min 100 runs via the global setup in
 * src/test/setupPropertyTests.ts).
 *
 * Scope note: bodies that are already wrapped (Property 7) are excluded so this
 * property isolates the plain unwrapped-error case, and bodies carrying a
 * top-level `data` field are excluded so the `data === null` invariant (R5.4)
 * is asserted on the canonical error shape.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * Extra, contract-neutral fields that may ride alongside an error payload. The
 * reserved keys are excluded so the generated body neither becomes
 * already-wrapped (`success`/`meta`), nor carries a `data` field (which the
 * wrapper would lift into the envelope `data`, breaking the `data === null`
 * invariant), nor a `pagination` field (lifted into `meta`), nor an `error`
 * field (handled explicitly by the nested-error arbitrary), nor `code`/`message`
 * (provided authoritatively below).
 */
const RESERVED_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'success',
  'meta',
  'data',
  'error',
  'pagination',
  'code',
  'message',
];

const extraFieldsArb = fc.dictionary(
  fc.string().filter((k) => k.length > 0 && !RESERVED_KEYS.includes(k)),
  fc.jsonValue(),
  { maxKeys: 4 }
);

/**
 * A flat error object that MAY omit `code` and/or `message` (and may supply them
 * as empty strings), to exercise the wrapper's `normalizeErrorObject` backfill.
 * It never carries a nested `error` field, so it is the safe inner payload for
 * the nested-error arbitrary below.
 */
const errorObjectArb = fc
  .record({
    code: fc.option(fc.string(), { nil: undefined }),
    message: fc.option(fc.string(), { nil: undefined }),
    extras: extraFieldsArb,
  })
  .map(({ code, message, extras }) => {
    const o: Record<string, unknown> = { ...extras };
    if (code !== undefined) o.code = code;
    if (message !== undefined) o.message = message;
    return o;
  });

/**
 * Arbitrary unwrapped error body covering the meaningful shapes a handler might
 * emit for a >=400 status:
 *   - a bare error message string                          (e.g. 'Not found')
 *   - a flat error object with/without code/message        (e.g. { code, message })
 *   - a body carrying a nested error OBJECT                 (e.g. { error: {...} })
 *   - null / a primitive (no error info at all)
 */
const errorBodyArb = fc
  .oneof(
    fc.string(),
    errorObjectArb,
    errorObjectArb.map((e) => ({ error: e })),
    fc.constant(null)
  )
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

describe('Property 6: unwrapped >=400 body becomes error envelope with success false, data null, non-empty code/message', () => {
  it('wraps any unwrapped >=400 body into an Error_Envelope (success=false, data=null, non-empty error.code/message, no nested error.error)', async () => {
    await fc.assert(
      fc.asyncProperty(errorStatusArb, errorBodyArb, async (status, payload) => {
        const app = createTestApp();

        const res = await request(app)
          .post('/api/echo')
          .set('Content-Type', 'application/json')
          .send({ status, payload });

        // The handler used the generated >=400 status.
        expect(res.status).toBe(status);

        const body = res.body;

        // R5.1: success is the boolean false.
        expect(body.success).toBe(false);

        // R5.4: data is null on the canonical error envelope.
        expect(body.data).toBeNull();

        // R5.2 / R5.3: error is an object with a non-empty code and message.
        expect(body.error).toBeDefined();
        expect(body.error).not.toBeNull();
        expect(typeof body.error).toBe('object');
        expect(typeof body.error.code).toBe('string');
        expect(body.error.code.length).toBeGreaterThan(0);
        expect(typeof body.error.message).toBe('string');
        expect(body.error.message.length).toBeGreaterThan(0);

        // R5.3 (no double-nesting): an object error payload is lifted onto the
        // canonical envelope, never nested under error.error.
        expect(Object.prototype.hasOwnProperty.call(body.error, 'error')).toBe(false);

        // A meta object is always present on the envelope.
        expect(body.meta).toBeDefined();
        expect(typeof body.meta).toBe('object');
        expect(body.meta).not.toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});

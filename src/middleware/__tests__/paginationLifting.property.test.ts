// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createResponseWrapper } from '../responseWrapper';

/**
 * Property Test: Pagination lifting into meta.pagination
 *
 * Feature: backend-api-contract-alignment, Property 5: pagination field is
 * lifted into meta.pagination and removed from body root
 *
 * **Validates: Requirements 4.5**
 *
 * For any unwrapped 2xx body that is an object carrying a top-level
 * `pagination` field, the Response_Wrapper (`createResponseWrapper`, which
 * intercepts `res.json()`) SHALL produce a Success_Envelope such that:
 *   - `meta.pagination` equals the original `pagination` value           (R4.5)
 *   - the resulting `data` payload no longer carries a `pagination` field
 *     at its root (it was moved, not copied)                             (R4.5)
 *   - the remaining (non-pagination) fields of the original body are
 *     preserved verbatim inside `data`
 *
 * A minimal Express app mounts `createResponseWrapper` ahead of a single echo
 * route that replays a generated 2xx status code and body. fast-check drives
 * arbitrary object bodies that always include a `pagination` field plus
 * arbitrary sibling fields (min 100 runs via the global setup in
 * src/test/setupPropertyTests.ts).
 *
 * Scope note: bodies that are already wrapped (Property 7) are excluded so this
 * property isolates the pagination-lifting case.
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
 * Realistic pagination metadata shapes (the canonical PaginationMeta), plus a
 * grab-bag of arbitrary JSON values to confirm the wrapper lifts whatever sits
 * under the `pagination` key without inspecting its contents.
 */
const paginationArb = fc.oneof(
  fc.record({
    page: fc.integer({ min: 1, max: 1000 }),
    pageSize: fc.integer({ min: 1, max: 200 }),
    total: fc.integer({ min: 0, max: 100000 }),
    totalPages: fc.integer({ min: 0, max: 1000 }),
    hasNext: fc.boolean(),
    hasPrev: fc.boolean(),
  }),
  fc.jsonValue().filter((v) => v !== null)
);

/**
 * Sibling fields placed alongside `pagination`. Keys exclude `pagination` so the
 * generated field is the single authoritative pagination entry, and exclude the
 * wrapper's reserved `success`/`meta` pair so the body is never already-wrapped.
 */
const siblingFieldsArb = fc
  .dictionary(
    fc.string().filter((k) => k !== 'pagination' && k.length > 0),
    fc.jsonValue(),
    { maxKeys: 5 }
  )
  .filter((obj) => !('success' in obj && 'meta' in obj));

/**
 * Arbitrary unwrapped 2xx object body that always carries a top-level
 * `pagination` field plus arbitrary sibling fields.
 */
const paginatedBodyArb = fc
  .record({ pagination: paginationArb, siblings: siblingFieldsArb })
  .map(({ pagination, siblings }) => ({ ...siblings, pagination }))
  .filter((b) => !isAlreadyWrapped(b) && !hasUnsafeKey(b));

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

  // The middleware under test: intercepts res.json() and lifts pagination.
  app.use(createResponseWrapper());

  // Echo route: replays the generated status code and body.
  app.post('/api/echo', (req, res) => {
    const { status, payload } = req.body as { status: number; payload: unknown };
    res.status(status).json(payload);
  });

  return app;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe('Property 5: pagination field is lifted into meta.pagination and removed from body root', () => {
  it('moves a top-level pagination field into meta.pagination and removes it from data', async () => {
    await fc.assert(
      fc.asyncProperty(successStatusArb, paginatedBodyArb, async (status, payload) => {
        const app = createTestApp();

        const res = await request(app)
          .post('/api/echo')
          .set('Content-Type', 'application/json')
          .send({ status, payload });

        // The handler used the generated 2xx status.
        expect(res.status).toBe(status);

        const body = res.body;

        // Success envelope shape.
        expect(body.success).toBe(true);
        expect(body.meta).toBeDefined();
        expect(typeof body.meta).toBe('object');

        // R4.5: pagination is lifted into meta.pagination, equal to the original.
        // JSON round-trips through the request/response, so undefined-bearing
        // structures normalize identically on both sides.
        expect(body.meta.pagination).toEqual((payload as any).pagination);

        // R4.5: data no longer carries pagination at its root (moved, not copied).
        expect(body).toHaveProperty('data');
        expect(body.data).not.toBeNull();
        expect(typeof body.data).toBe('object');
        expect(Object.prototype.hasOwnProperty.call(body.data, 'pagination')).toBe(false);

        // The remaining (non-pagination) sibling fields are preserved verbatim.
        const { pagination, ...expectedData } = payload as Record<string, unknown>;
        expect(body.data).toEqual(expectedData);
      }),
      { numRuns: 100 }
    );
  });
});

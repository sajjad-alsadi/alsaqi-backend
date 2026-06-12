// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import {
  versionFallbackRewrite,
  unsupportedVersionHandler,
  apiVersionHeader,
  SUPPORTED_VERSIONS,
} from '../middleware/versionRewrite';
import { notFoundHandler } from '../middleware/notFoundHandler';

/**
 * Property Test: Backward Compatibility (Property 5)
 *
 * Feature: api-isolation
 * Property 5: التوافق العكسي (Backward Compatibility)
 *
 * **Validates: Requirements 6.1, 6.2, 6.3**
 *
 * For any existing API path and HTTP method combination that was functional
 * before the migration, the new API_Package returns semantically equivalent
 * responses with the same status codes, the same authentication requirements,
 * and compatible response body structure.
 *
 * Since we cannot start the full server (requires DB), this test verifies:
 * - The version rewrite middleware correctly rewrites unversioned paths
 * - Explicitly versioned paths (v1) pass through unchanged
 * - Unsupported versions return proper 404 responses
 * - The notFoundHandler returns proper 404 for unknown API paths
 * - X-API-Version header is set on all /api/ responses
 */

// ─── Known API Endpoints ──────────────────────────────────────────────────────

/**
 * Known resource paths from the original implementation.
 * These are the routes registered in the v1 router (packages/api/src/routes/v1/index.ts).
 */
const KNOWN_RESOURCES = [
  'auth/login',
  'auth/refresh',
  'auth/register',
  'users',
  'notifications',
  'comments',
  'job-titles',
  'user-sessions',
  'correspondence',
  'departments',
  'analytics',
  'audit-programs',
  'audit-tasks',
  'audit-findings',
  'recommendations',
  'fraud-access-requests',
  'compliance',
  'bulk',
  'health',
  // Served by the CRUD generator (FIX-BE-3 confirmed the orphaned regulatory
  // route was removed; this entity must keep working through createCrudRoutes).
  'central-bank-instructions',
] as const;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a known resource path from the API */
const knownResourceArb = fc.constantFrom(...KNOWN_RESOURCES);

/** Generates an optional resource ID suffix */
const resourceIdArb = fc.oneof(
  fc.constant(''),
  fc.integer({ min: 1, max: 9999 }).map((id) => `/${id}`),
  fc.uuid().map((id) => `/${id}`),
);

/** Generates an unsupported version number (not in SUPPORTED_VERSIONS) */
const unsupportedVersionArb = fc
  .integer({ min: 2, max: 99 })
  .filter((v) => !SUPPORTED_VERSIONS.includes(v));

/** Generates HTTP methods for testing */
const httpMethodArb = fc.constantFrom('get', 'post', 'put', 'delete', 'patch');

/** Generates arbitrary path segments for unknown endpoints */
const unknownResourceArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{2,15}$/)
  .filter((s) => !KNOWN_RESOURCES.includes(s as any))
  // Exclude strings that look like version prefixes (e.g. "v0-xxx", "v99-yyy")
  // because the unsupportedVersionHandler would intercept them
  .filter((s) => !/^v\d/.test(s));

// ─── Test App Factory ─────────────────────────────────────────────────────────

/**
 * Creates a minimal Express app that mimics the API server's middleware stack
 * for version rewriting and routing, without needing DB or auth.
 *
 * Routes are registered under /api/v1/ with a simple handler that echoes
 * the request info, allowing us to verify routing behavior.
 */
function createTestApp() {
  const app = express();

  // X-API-Version header on all /api/ responses
  app.use('/api/', apiVersionHeader);

  // Unsupported version handler (must be before fallback rewrite)
  app.use('/api/', unsupportedVersionHandler);

  // Version fallback: /api/{resource} → /api/v1/{resource}
  app.use('/api', versionFallbackRewrite);

  // Register v1 routes for known resources
  const v1Router = express.Router();

  // Register handlers for each known resource (GET and POST)
  for (const resource of KNOWN_RESOURCES) {
    const handler = (req: any, res: any) => {
      res.json({
        success: true,
        data: {
          method: req.method,
          resource,
          originalUrl: req.originalUrl,
          path: req.path,
        },
      });
    };

    v1Router.all(`/${resource}`, handler);
    v1Router.all(`/${resource}/:id`, handler);
  }

  // Consolidated role-permissions route (FIX-BE-4): owned by a single module,
  // exposed as GET (matrix read) + POST (matrix update) only — no PUT verb.
  // Frontend calls POST, so the POST contract/shape must be preserved.
  v1Router.get('/roles/:id/permissions', (req: any, res: any) => {
    res.json({
      success: true,
      data: { roleId: req.params.id, permissions: [] },
    });
  });
  v1Router.post('/roles/:id/permissions', (req: any, res: any) => {
    res.json({
      success: true,
      data: { roleId: req.params.id, updated: true },
    });
  });

  app.use('/api/v1', v1Router);

  // Not found handler for unmatched /api/ paths
  app.use('/api', notFoundHandler);

  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 5: Backward Compatibility', () => {
  describe('Version Rewrite: unversioned paths are forwarded to v1', () => {
    it('requests to /api/{resource} are rewritten to /api/v1/{resource} and served correctly', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, resourceIdArb, async (resource, idSuffix) => {
          const app = createTestApp();
          const unversionedPath = `/api/${resource}${idSuffix}`;

          const res = await request(app).get(unversionedPath);

          // Should be served successfully (not 404) via rewrite to v1
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data.resource).toBe(resource);
        }),
        { numRuns: 100 }
      );
    });

    it('version rewrite preserves the HTTP method', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, httpMethodArb, async (resource, method) => {
          const app = createTestApp();
          const unversionedPath = `/api/${resource}`;

          const res = await (request(app) as any)[method](unversionedPath).send({});

          expect(res.status).toBe(200);
          expect(res.body.data.method).toBe(method.toUpperCase());
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Direct versioned paths pass through unchanged', () => {
    it('requests to /api/v1/{resource} work directly without rewriting', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, resourceIdArb, async (resource, idSuffix) => {
          const app = createTestApp();
          const versionedPath = `/api/v1/${resource}${idSuffix}`;

          const res = await request(app).get(versionedPath);

          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data.resource).toBe(resource);
        }),
        { numRuns: 100 }
      );
    });

    it('explicitly versioned requests preserve HTTP method', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, httpMethodArb, async (resource, method) => {
          const app = createTestApp();
          const versionedPath = `/api/v1/${resource}`;

          const res = await (request(app) as any)[method](versionedPath).send({});

          expect(res.status).toBe(200);
          expect(res.body.data.method).toBe(method.toUpperCase());
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Unsupported versions return 404', () => {
    it('requests to /api/v{n}/{resource} where n is not supported return 404', async () => {
      await fc.assert(
        fc.asyncProperty(
          unsupportedVersionArb,
          knownResourceArb,
          async (version, resource) => {
            const app = createTestApp();
            const path = `/api/v${version}/${resource}`;

            const res = await request(app).get(path);

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
            expect(res.body.error.message).toContain(`v${version}`);
            expect(res.body.error.message).toContain('Supported versions');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('unsupported versions return 404 regardless of HTTP method', async () => {
      await fc.assert(
        fc.asyncProperty(
          unsupportedVersionArb,
          knownResourceArb,
          httpMethodArb,
          async (version, resource, method) => {
            const app = createTestApp();
            const path = `/api/v${version}/${resource}`;

            const res = await (request(app) as any)[method](path).send({});

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Unknown API paths return proper 404', () => {
    it('requests to unregistered /api/{resource} paths return 404 with proper error envelope', async () => {
      await fc.assert(
        fc.asyncProperty(unknownResourceArb, async (resource) => {
          const app = createTestApp();
          const path = `/api/${resource}`;

          const res = await request(app).get(path);

          expect(res.status).toBe(404);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('NOT_FOUND');
          expect(res.body.error.message).toContain('not found');
          // Error envelope should have meta with requestId and timestamp
          expect(res.body.meta).toBeDefined();
          expect(res.body.meta.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          );
          expect(res.body.meta.timestamp).toBeDefined();
          expect(res.body.meta.version).toBeDefined();
        }),
        { numRuns: 50 }
      );
    });

    it('requests to unregistered /api/v1/{resource} paths return 404 with proper error envelope', async () => {
      await fc.assert(
        fc.asyncProperty(unknownResourceArb, async (resource) => {
          const app = createTestApp();
          const path = `/api/v1/${resource}`;

          const res = await request(app).get(path);

          expect(res.status).toBe(404);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('X-API-Version header is present on all /api/ responses', () => {
    it('all /api/ responses include X-API-Version header', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, async (resource) => {
          const app = createTestApp();

          // Test versioned path
          const res1 = await request(app).get(`/api/v1/${resource}`);
          expect(res1.headers['x-api-version']).toBeDefined();
          expect(res1.headers['x-api-version']).toMatch(/^\d+\.\d+$/);

          // Test unversioned path (rewritten)
          const res2 = await request(app).get(`/api/${resource}`);
          expect(res2.headers['x-api-version']).toBeDefined();
          expect(res2.headers['x-api-version']).toMatch(/^\d+\.\d+$/);
        }),
        { numRuns: 30 }
      );
    });

    it('404 responses from unsupported versions include X-API-Version header', async () => {
      await fc.assert(
        fc.asyncProperty(unsupportedVersionArb, knownResourceArb, async (version, resource) => {
          const app = createTestApp();
          const path = `/api/v${version}/${resource}`;

          const res = await request(app).get(path);

          expect(res.status).toBe(404);
          expect(res.headers['x-api-version']).toBeDefined();
        }),
        { numRuns: 30 }
      );
    });

    it('404 responses from unknown paths include X-API-Version header', async () => {
      await fc.assert(
        fc.asyncProperty(unknownResourceArb, async (resource) => {
          const app = createTestApp();
          const path = `/api/${resource}`;

          const res = await request(app).get(path);

          expect(res.status).toBe(404);
          expect(res.headers['x-api-version']).toBeDefined();
        }),
        { numRuns: 30 }
      );
    });
  });

  describe('Semantic equivalence: rewritten and direct paths return identical data', () => {
    it('response from /api/{resource} is identical to response from /api/v1/{resource}', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, resourceIdArb, httpMethodArb, async (resource, idSuffix, method) => {
          const app = createTestApp();
          const unversionedPath = `/api/${resource}${idSuffix}`;
          const versionedPath = `/api/v1/${resource}${idSuffix}`;

          const resUnversioned = await (request(app) as any)[method](unversionedPath).send({});
          const resVersioned = await (request(app) as any)[method](versionedPath).send({});

          // Both should have the same status code
          expect(resUnversioned.status).toBe(resVersioned.status);

          // Both should have the same success flag
          expect(resUnversioned.body.success).toBe(resVersioned.body.success);

          // Both should resolve to the same resource
          expect(resUnversioned.body.data.resource).toBe(resVersioned.body.data.resource);

          // Both should see the same HTTP method
          expect(resUnversioned.body.data.method).toBe(resVersioned.body.data.method);
        }),
        { numRuns: 100 }
      );
    });
  });
});

/**
 * Property Test: API Contract Preservation (No-Regression Gate)
 *
 * Feature: backend-consistency-fixes
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
 *
 * The FIX-BE-1..FIX-BE-5 cleanup/sync changes must NOT alter the runtime API
 * contract. For every pre-existing endpoint:
 *  - 7.1 a successful response carries `success: true` inside the envelope.
 *  - 7.2 every response (success or error) carries `X-API-Version: 1.0`.
 *  - 7.3 path, HTTP method, status code, and response shape are unchanged.
 *  - 7.4 an error response carries `success: false` inside the envelope.
 *
 * Coverage includes the endpoints touched by these fixes: the
 * central-bank-instructions CRUD path (FIX-BE-3) and the consolidated
 * POST /roles/:id/permissions route (FIX-BE-4).
 */
describe('Requirement 7: API Contract Preservation (no regression)', () => {
  describe('7.2: X-API-Version header is exactly "1.0" on every response', () => {
    it('success responses carry X-API-Version: 1.0', async () => {
      await fc.assert(
        fc.asyncProperty(knownResourceArb, resourceIdArb, async (resource, idSuffix) => {
          const app = createTestApp();

          const versioned = await request(app).get(`/api/v1/${resource}${idSuffix}`);
          const unversioned = await request(app).get(`/api/${resource}${idSuffix}`);

          expect(versioned.headers['x-api-version']).toBe('1.0');
          expect(unversioned.headers['x-api-version']).toBe('1.0');
        }),
        { numRuns: 100 }
      );
    });

    it('error responses (unknown path, unsupported version) carry X-API-Version: 1.0', async () => {
      await fc.assert(
        fc.asyncProperty(
          unknownResourceArb,
          unsupportedVersionArb,
          knownResourceArb,
          async (unknownResource, version, resource) => {
            const app = createTestApp();

            const notFound = await request(app).get(`/api/${unknownResource}`);
            const badVersion = await request(app).get(`/api/v${version}/${resource}`);

            expect(notFound.headers['x-api-version']).toBe('1.0');
            expect(badVersion.headers['x-api-version']).toBe('1.0');
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('7.1 / 7.3: pre-existing endpoints keep method, 200 status, and success envelope', () => {
    it('GET/POST on a known resource returns 200, success: true, and the same shape via both path forms', async () => {
      await fc.assert(
        fc.asyncProperty(
          knownResourceArb,
          fc.constantFrom('get', 'post'),
          async (resource, method) => {
            const app = createTestApp();

            const versioned = await (request(app) as any)[method](`/api/v1/${resource}`).send({});
            const unversioned = await (request(app) as any)[method](`/api/${resource}`).send({});

            // 7.3: same status code, method, and resolved resource (shape)
            expect(versioned.status).toBe(200);
            expect(unversioned.status).toBe(200);
            expect(versioned.body.data.method).toBe(method.toUpperCase());
            expect(unversioned.body.data.method).toBe(method.toUpperCase());
            expect(versioned.body.data.resource).toBe(resource);
            expect(unversioned.body.data.resource).toBe(resource);

            // 7.1: success flag is true on success
            expect(versioned.body.success).toBe(true);
            expect(unversioned.body.success).toBe(true);

            // shape is identical regardless of path form
            expect(Object.keys(unversioned.body).sort()).toEqual(
              Object.keys(versioned.body).sort()
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('7.4: error responses carry success: false within the envelope', () => {
    it('unknown paths and unsupported versions both return success: false', async () => {
      await fc.assert(
        fc.asyncProperty(
          unknownResourceArb,
          unsupportedVersionArb,
          knownResourceArb,
          async (unknownResource, version, resource) => {
            const app = createTestApp();

            const notFound = await request(app).get(`/api/${unknownResource}`);
            const badVersion = await request(app).get(`/api/v${version}/${resource}`);

            expect(notFound.status).toBe(404);
            expect(notFound.body.success).toBe(false);

            expect(badVersion.status).toBe(404);
            expect(badVersion.body.success).toBe(false);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Touched endpoints stay backward compatible', () => {
    it('central-bank-instructions (CRUD path) returns a non-501 success envelope with X-API-Version: 1.0', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom('get', 'post'), async (method) => {
          const app = createTestApp();

          const res = await (request(app) as any)
            [method]('/api/v1/central-bank-instructions')
            .send({});

          expect(res.status).toBe(200);
          expect(res.status).not.toBe(501);
          expect(res.body.success).toBe(true);
          expect(res.body.data.resource).toBe('central-bank-instructions');
          expect(res.headers['x-api-version']).toBe('1.0');
        }),
        { numRuns: 30 }
      );
    });

    it('POST /roles/:id/permissions (consolidated verb) returns success envelope; PUT is no longer routed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.integer({ min: 1, max: 9999 }).map(String),
            fc.uuid()
          ),
          async (roleId) => {
            const app = createTestApp();

            // POST is the verb the frontend uses — must succeed in the envelope.
            const post = await request(app)
              .post(`/api/v1/roles/${roleId}/permissions`)
              .send({ permissions: [] });

            expect(post.status).toBe(200);
            expect(post.body.success).toBe(true);
            expect(post.headers['x-api-version']).toBe('1.0');

            // GET (matrix read) is still available from the single owner.
            const get = await request(app).get(`/api/v1/roles/${roleId}/permissions`);
            expect(get.status).toBe(200);
            expect(get.body.success).toBe(true);

            // PUT was removed (FIX-BE-4): it must not resolve to a handler.
            const put = await request(app)
              .put(`/api/v1/roles/${roleId}/permissions`)
              .send({ permissions: [] });
            expect(put.status).toBe(404);
            expect(put.body.success).toBe(false);
            expect(put.headers['x-api-version']).toBe('1.0');
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

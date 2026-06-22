// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import {
  versionFallbackRewrite,
  unsupportedVersionHandler,
} from '../middleware/versionRewrite';
import { VERSION_SOURCE } from '../utils/apiVersionSource';
import { notFoundHandler } from '../middleware/notFoundHandler';
import { createSuccessResponse } from '../utils/responseEnvelope.js';

/**
 * Property Test: Dual-Path Equivalence and Resource Name Resolution (Property 9)
 *
 * Feature: backend-api-contract-alignment, Property 9: each contract resource
 * resolves identically on unversioned and versioned paths, and findings/tasks
 * return 404
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**
 *
 * The mechanism under test is the dual-path routing layer documented in
 * design.md §1 ("التوجيه المزدوج"):
 *  - `versionFallbackRewrite` (src/middleware/versionRewrite.ts) rewrites
 *    /api/{resource} → /api/v1/{resource} before route matching (R1.1), while
 *    passing /api/v1/{resource} through unchanged (R1.2).
 *  - The same Resource_Name therefore resolves to the SAME handler via both the
 *    unversioned and versioned forms, producing the same status and body shape
 *    (R1.3, R2.7).
 *  - The exact contract resource names (audit-findings, audit-tasks, my-tasks,
 *    audit-plans, recommendations, risk-register, correspondence/*, users,
 *    departments, dashboard-stats, auth/me, and the auth POST endpoints) are
 *    registered and resolve without an unknown-route 404 (R2.1–R2.5).
 *  - The incorrect aliases `findings` and `tasks` are NOT registered, so they
 *    fall through to `notFoundHandler` and return 404 (R2.6).
 *
 * Because the full server requires a database, this test reuses the REAL
 * `versionFallbackRewrite` + `unsupportedVersionHandler` middleware plus a
 * DB-free v1 router that registers exactly the contract resources, mirroring the
 * test-app approach in `backwardCompat.property.test.ts`.
 */

// ─── Contract resources from Requirement 2 ─────────────────────────────────────

/**
 * GET resources that MUST resolve (never 404 as an unknown route), expressed on
 * the unversioned `/api` base. Covers R2.1 (audit-findings), R2.2 (audit-tasks),
 * R2.3 (my-tasks), R2.4 (the listed read resources incl. correspondence/* and
 * dashboard-stats and auth/me).
 */
const GET_RESOURCES = [
  'audit-findings',
  'audit-tasks',
  'my-tasks',
  'audit-plans',
  'recommendations',
  'risk-register',
  'correspondence/incoming',
  'correspondence/outgoing',
  'correspondence/archive',
  'users',
  'departments',
  'dashboard-stats',
  'auth/me',
] as const;

/** Authentication POST endpoints from R2.5 that must also resolve (never 404). */
const AUTH_POST_ENDPOINTS = [
  'auth/login',
  'auth/refresh',
  'auth/logout',
  'auth/change-password',
] as const;

/** Incorrect resource names that MUST 404 (R2.6) — no alias exists. */
const INCORRECT_RESOURCES = ['findings', 'tasks'] as const;

// ─── Arbitraries ───────────────────────────────────────────────────────────────

const getResourceArb = fc.constantFrom(...GET_RESOURCES);
const authPostArb = fc.constantFrom(...AUTH_POST_ENDPOINTS);
const incorrectResourceArb = fc.constantFrom(...INCORRECT_RESOURCES);

/** Optional resource id suffix to exercise both collection and item paths. */
const resourceIdArb = fc.oneof(
  fc.constant(''),
  fc.integer({ min: 1, max: 9999 }).map((id) => `/${id}`),
  fc.uuid().map((id) => `/${id}`),
);

// ─── Test App Factory ───────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app wired with the REAL dual-path middleware and a
 * DB-free v1 router that registers exactly the contract resources. The handler
 * echoes the resolved resource so we can assert that the unversioned and
 * versioned forms hit the same handler and return an identical body shape.
 *
 * The incorrect aliases `findings`/`tasks` are intentionally NOT registered, so
 * they fall through to `notFoundHandler` (404).
 */
function createTestApp() {
  const app = express();
  app.use(express.json());

  // X-API-Version header on all /api responses from the single VERSION_SOURCE,
  // mirroring the early inline middleware in src/index.ts step 0a.
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('X-API-Version', VERSION_SOURCE);
    }
    next();
  });

  // Unsupported version handler must run before the fallback rewrite.
  app.use('/api/', unsupportedVersionHandler);

  // Version fallback: /api/{resource} → /api/v1/{resource}.
  app.use('/api', versionFallbackRewrite);

  const v1Router = express.Router();

  const makeHandler = (resource: string) => (req: any, res: any) => {
    res
      .status(200)
      .json(
        createSuccessResponse({
          data: { resource, method: req.method, path: req.path },
        }),
      );
  };

  // Register the GET contract resources (collection + item forms).
  for (const resource of GET_RESOURCES) {
    v1Router.get(`/${resource}`, makeHandler(resource));
    v1Router.get(`/${resource}/:id`, makeHandler(resource));
  }

  // Register the auth POST endpoints.
  for (const endpoint of AUTH_POST_ENDPOINTS) {
    v1Router.post(`/${endpoint}`, makeHandler(endpoint));
  }

  app.use('/api/v1', v1Router);

  // Unmatched /api paths (including the incorrect findings/tasks aliases) → 404.
  app.use('/api', notFoundHandler);

  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 9: dual-path equivalence and resource name resolution', () => {
  it('each contract GET resource resolves identically on unversioned and versioned paths (R1.1, R1.2, R1.3, R2.1–R2.4, R2.7)', async () => {
    await fc.assert(
      fc.asyncProperty(getResourceArb, resourceIdArb, async (resource, idSuffix) => {
        const app = createTestApp();
        const unversioned = await request(app).get(`/api/${resource}${idSuffix}`);
        const versioned = await request(app).get(`/api/v1/${resource}${idSuffix}`);

        // Resolves (never an unknown-route 404) on both forms (R2.1–R2.4).
        expect(unversioned.status).not.toBe(404);
        expect(versioned.status).not.toBe(404);

        // Identical status code (R1.3).
        expect(unversioned.status).toBe(versioned.status);
        expect(unversioned.status).toBe(200);

        // Identical body shape: same top-level keys and same resolved resource.
        expect(Object.keys(unversioned.body).sort()).toEqual(
          Object.keys(versioned.body).sort(),
        );
        expect(unversioned.body.success).toBe(versioned.body.success);
        expect(unversioned.body.data.resource).toBe(versioned.body.data.resource);
        expect(unversioned.body.data.resource).toBe(resource);

        // The version header is present and identical on both forms (R2.7).
        expect(unversioned.headers['x-api-version']).toBe(VERSION_SOURCE);
        expect(versioned.headers['x-api-version']).toBe(VERSION_SOURCE);
      }),
      { numRuns: 100 },
    );
  });

  it('each auth POST endpoint resolves identically on unversioned and versioned paths (R2.5, R2.7)', async () => {
    await fc.assert(
      fc.asyncProperty(authPostArb, async (endpoint) => {
        const app = createTestApp();
        const unversioned = await request(app).post(`/api/${endpoint}`).send({});
        const versioned = await request(app).post(`/api/v1/${endpoint}`).send({});

        expect(unversioned.status).not.toBe(404);
        expect(versioned.status).not.toBe(404);
        expect(unversioned.status).toBe(versioned.status);

        expect(Object.keys(unversioned.body).sort()).toEqual(
          Object.keys(versioned.body).sort(),
        );
        expect(unversioned.body.data.resource).toBe(versioned.body.data.resource);
        expect(unversioned.body.data.resource).toBe(endpoint);
      }),
      { numRuns: 100 },
    );
  });

  it('incorrect resource names /api/findings and /api/tasks return 404 on both forms (R2.6, R2.7)', async () => {
    await fc.assert(
      fc.asyncProperty(incorrectResourceArb, resourceIdArb, async (resource, idSuffix) => {
        const app = createTestApp();
        const unversioned = await request(app).get(`/api/${resource}${idSuffix}`);
        const versioned = await request(app).get(`/api/v1/${resource}${idSuffix}`);

        // Both forms must 404 — no alias exists for the incorrect name.
        expect(unversioned.status).toBe(404);
        expect(versioned.status).toBe(404);

        // And both must 404 identically (dual-path equivalence holds for the
        // unknown case too).
        expect(unversioned.status).toBe(versioned.status);
        expect(unversioned.body.success).toBe(false);
        expect(versioned.body.success).toBe(false);
        expect(unversioned.body.error.code).toBe('NOT_FOUND');
        expect(versioned.body.error.code).toBe('NOT_FOUND');
      }),
      { numRuns: 100 },
    );
  });
});

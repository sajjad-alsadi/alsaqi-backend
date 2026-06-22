// @vitest-environment node
// Feature: backend-api-contract-alignment, Task 6.2: OpenAPI documentation coverage (R10.7, R7.9)
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as loadYaml } from 'js-yaml';

import {
  checkOpenApiRouteEquivalence,
  type Operation,
} from '../openapiEquivalence.js';
import { buildRoutePermissionInventory } from '../../security/routeInventory.js';

// Real route factories that register the R10 routes documented in docs/openapi.yaml.
import { createNotificationRoutes } from '../../routes/notifications.js';
import { createDashboardRoutes } from '../../routes/dashboard.js';
import { createAuthRoutes } from '../../routes/auth/index.js';

/**
 * Contract Test — OpenAPI ↔ Route equivalence for the R10 documented routes.
 *
 * Task 6.1 documented the R10 routes in docs/openapi.yaml on the unversioned
 * `/api` base. This test, built on the existing OpenAPI_Equivalence_Check
 * (`checkOpenApiRouteEquivalence`), verifies that documentation coverage:
 *
 *   1. The live application routes are extracted with the SAME stack-extraction
 *      logic used by the route↔permission inventory
 *      (`buildRoutePermissionInventory`), then normalized: Express `:param`
 *      segments are rewritten to OpenAPI `{param}` syntax and every path is
 *      expressed on the unversioned `/api` base.
 *   2. The OpenAPI operations are parsed from `docs/openapi.yaml` and likewise
 *      expressed on the `/api` base (the spec declares `/api` as its server url).
 *   3. `checkOpenApiRouteEquivalence(routes, spec)` is invoked, and we assert
 *      that NONE of the R10 routes appear in `missingInSpec` — i.e. every R10
 *      route registered on the live app is documented in the OpenAPI spec.
 *
 * The R10 routes are the notification routes (GET /notifications,
 * GET /notifications/unread-count, PUT /notifications/{id}/read,
 * PUT /notifications/mark-read, PUT /notifications/mark-all-read,
 * DELETE /notifications/{id}), GET /my-tasks, GET /dashboard-stats, the 2FA
 * endpoints (POST /auth/2fa/setup, /verify, /validate, /setup-pending,
 * /setup-complete, /backup; DELETE /auth/2fa) and POST /auth/register.
 *
 * NOTE ON APP CONSTRUCTION: `createApiServer().start()` mounts the route modules
 * only inside `start()`, which initializes the database and runs migrations. To
 * avoid a live DB dependency, this test mounts the same real route factories
 * used by `createV1Router`, with injected no-op middleware — the identical
 * pattern used by the existing routeInventory / apiVersioning tests. Because
 * Express 5's stack regex does not reliably expose a sub-router's mount path,
 * each factory is extracted on its own root-mounted app and the known mount
 * prefix (the same one `createV1Router` uses) is prepended. The route TOPOLOGY
 * (method + path) is what the equivalence check cares about, and it is identical
 * to what `start()` would register on the unversioned `/api` base.
 *
 * Validates: Requirements 10.7, 7.9
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The unversioned API base the unified contract and the OpenAPI spec use. */
const API_BASE = '/api';

/** The Docs_Endpoint excluded from equivalence on both sides. */
const DOCS_ENDPOINT_PATH = '/api/v1/docs';

// ─── Injected no-op dependencies ──────────────────────────────────────────────
// The route factories only need these to register routes; behavior is irrelevant
// to the (method, path) topology the equivalence check compares.
const passthrough = (_req: any, _res: any, next: any) => next();
const checkPermission = () => passthrough;
const noopAsync = vi.fn();

/**
 * Each R10 route group: the real route factory mounted at a known sub-path,
 * mirroring how `createV1Router` mounts them. Express 5's stack regex does not
 * reliably expose a sub-router's mount path, so we apply the stack-extraction
 * logic (`buildRoutePermissionInventory`) per-router on a root-mounted app and
 * prepend the known mount prefix ourselves — yielding the same topology
 * `start()` would register on the unversioned `/api` base.
 */
function routeGroups(): Array<{ mount: string; build: () => express.Router }> {
  return [
    {
      // createV1Router: v1Router.use('/notifications', createNotificationRoutes(...))
      mount: `${API_BASE}/notifications`,
      build: () => createNotificationRoutes({} as any, passthrough) as express.Router,
    },
    {
      // createV1Router: v1Router.use('/', createDashboardRoutes(...))
      mount: API_BASE,
      build: () =>
        createDashboardRoutes({} as any, passthrough, () => passthrough, noopAsync) as express.Router,
    },
    {
      // createV1Router: v1Router.use('/auth', createAuthRoutes(...))
      mount: `${API_BASE}/auth`,
      build: () =>
        createAuthRoutes(
          {} as any,
          'test-public-key',
          'test-private-key',
          passthrough, // authLimiter
          passthrough, // authenticate
          checkPermission,
          noopAsync, // createNotification
          noopAsync // logError
        ) as express.Router,
    },
  ];
}

/**
 * Normalize a live (Express) route path to the OpenAPI path-template
 * convention: `:param` → `{param}`.
 */
function toPathTemplate(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Join a mount prefix and a router-relative path into a normalized full path. */
function joinPath(mount: string, routePath: string): string {
  const left = mount.replace(/\/+$/, '');
  const right = routePath === '/' ? '' : routePath.startsWith('/') ? routePath : `/${routePath}`;
  const joined = `${left}${right}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * Build the live-route Operation[] using the route↔permission inventory's
 * stack-extraction logic, normalizing `:param` → `{param}` and expressing each
 * path on the unversioned `/api` base. Entries whose method is the synthetic
 * 'ALL' (a route with no explicit verb) are dropped.
 */
function buildLiveOperations(): Operation[] {
  const operations: Operation[] = [];
  for (const group of routeGroups()) {
    // Mount the router at root so the inventory's stack extraction yields
    // router-relative paths, then prepend the known mount prefix.
    const app = express();
    app.use('/', group.build());

    const inventory = buildRoutePermissionInventory(app);
    for (const entry of inventory) {
      if (entry.method === 'ALL') continue;
      operations.push({
        method: entry.method,
        pathTemplate: toPathTemplate(joinPath(group.mount, entry.path)),
      });
    }
  }
  return operations;
}

/**
 * Parse `docs/openapi.yaml` into Operation[] expressed on the unversioned `/api`
 * base. Each (path, httpMethod) pair becomes one operation; non-method keys
 * (e.g. `parameters`) under a path item are ignored.
 */
function buildSpecOperations(): Operation[] {
  const candidatePaths = [
    path.resolve(__dirname, '../../../docs/openapi.yaml'),
    path.resolve(process.cwd(), 'docs/openapi.yaml'),
  ];
  let raw: string | null = null;
  for (const candidate of candidatePaths) {
    try {
      raw = fs.readFileSync(candidate, 'utf-8');
      break;
    } catch {
      // try next candidate
    }
  }
  if (raw === null) {
    throw new Error('Could not locate docs/openapi.yaml');
  }

  const doc = loadYaml(raw) as { paths?: Record<string, Record<string, unknown>> };
  const paths = doc.paths ?? {};
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

  const operations: Operation[] = [];
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const methodKey of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(methodKey.toLowerCase())) continue;
      operations.push({
        method: methodKey.toUpperCase(),
        // Spec paths are relative to the `/api` server url → prefix it.
        pathTemplate: `${API_BASE}${pathKey}`,
      });
    }
  }
  return operations;
}

// ─── The R10 routes that MUST be documented (expressed on the /api base) ───────
const R10_ROUTES: Operation[] = [
  // Notifications
  { method: 'GET', pathTemplate: '/api/notifications' },
  { method: 'GET', pathTemplate: '/api/notifications/unread-count' },
  { method: 'PUT', pathTemplate: '/api/notifications/{id}/read' },
  { method: 'PUT', pathTemplate: '/api/notifications/mark-read' },
  { method: 'PUT', pathTemplate: '/api/notifications/mark-all-read' },
  { method: 'DELETE', pathTemplate: '/api/notifications/{id}' },
  // Dashboard
  { method: 'GET', pathTemplate: '/api/my-tasks' },
  { method: 'GET', pathTemplate: '/api/dashboard-stats' },
  // 2FA
  { method: 'POST', pathTemplate: '/api/auth/2fa/setup' },
  { method: 'POST', pathTemplate: '/api/auth/2fa/verify' },
  { method: 'POST', pathTemplate: '/api/auth/2fa/validate' },
  { method: 'POST', pathTemplate: '/api/auth/2fa/setup-pending' },
  { method: 'POST', pathTemplate: '/api/auth/2fa/setup-complete' },
  { method: 'POST', pathTemplate: '/api/auth/2fa/backup' },
  { method: 'DELETE', pathTemplate: '/api/auth/2fa' },
  // Register
  { method: 'POST', pathTemplate: '/api/auth/register' },
];

function keyOf(op: Operation): string {
  return `${op.method.toUpperCase()} ${op.pathTemplate}`;
}

describe('Task 6.2: OpenAPI documents the R10 routes (checkOpenApiRouteEquivalence)', () => {
  let liveOps: Operation[];
  let specOps: Operation[];

  beforeAll(() => {
    liveOps = buildLiveOperations();
    specOps = buildSpecOperations();
  });

  it('registers every R10 route on the live app (sanity check of the extracted topology)', () => {
    const liveKeys = new Set(liveOps.map(keyOf));
    const notRegistered = R10_ROUTES.filter((op) => !liveKeys.has(keyOf(op)));
    expect(notRegistered, `R10 routes missing from the live app: ${notRegistered.map(keyOf).join(', ')}`).toEqual([]);
  });

  it('documents every R10 route in docs/openapi.yaml (none appear in missingInSpec)', () => {
    const report = checkOpenApiRouteEquivalence(liveOps, specOps);

    const missingKeys = new Set(report.missingInSpec.map(keyOf));
    const undocumentedR10 = R10_ROUTES.filter((op) => missingKeys.has(keyOf(op)));

    expect(
      undocumentedR10,
      `R10 routes missing from OpenAPI spec: ${undocumentedR10.map(keyOf).join(', ')}`
    ).toEqual([]);
  });

  it('excludes the Docs_Endpoint from the equivalence comparison on both sides', () => {
    const report = checkOpenApiRouteEquivalence(liveOps, specOps);
    expect(report.missingInSpec.some((op) => op.pathTemplate === DOCS_ENDPOINT_PATH)).toBe(false);
    expect(report.missingInRoutes.some((op) => op.pathTemplate === DOCS_ENDPOINT_PATH)).toBe(false);
  });
});

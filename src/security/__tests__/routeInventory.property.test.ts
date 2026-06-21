// @vitest-environment node
// Feature: production-launch-readiness, Property 7
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import {
  buildRoutePermissionInventory,
  findAuthorizationGaps,
  ROUTE_PERMISSION_METADATA_KEY,
} from '../routeInventory.js';
import type { RoutePermissionEntry } from '../../launch/types.js';

/**
 * Property 7: اكتمال جرد المسار↔الصلاحية وكشف الفجوات
 * (Completeness of the route↔permission inventory and authorization-gap detection).
 *
 * **Validates: Requirements 6.4, 6.5**
 *
 * For any Express application assembled from an arbitrary set of routes — where
 * each route declares an HTTP method, a path, and is randomly either tagged with
 * a {module, action} permission or left untagged — the following must hold:
 *
 *  - `buildRoutePermissionInventory(app)` produces EXACTLY one entry per
 *    registered route+method, each mapped to its {module, action} pair (when the
 *    route carries a permission-tagged handler) or to `null` (when it does not).
 *  - `findAuthorizationGaps(inventory)` returns EXACTLY the entries that are
 *    mutating (POST/PUT/PATCH/DELETE) AND have `permission === null` — no more,
 *    no less.
 *
 * Both claims are checked against an independent oracle computed directly from
 * the generated route definitions, never from the module under test.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Permission = { module: string; action: string };

interface RouteSpec {
  method: (typeof HTTP_METHODS)[number];
  path: string;
  permission: Permission | null;
}

// ─── Tagging mechanism (mirrors checkPermission factory in src/middleware/auth.ts) ──
//
// The real `checkPermission(module, action)` middleware factory tags its returned
// middleware with a non-enumerable property under ROUTE_PERMISSION_METADATA_KEY.
// We replicate that tagging exactly so the inventory exercises the same code path.
function makeTaggedHandler(permission: Permission): RequestHandler {
  const handler: RequestHandler = (_req, _res, next) => next();
  Object.defineProperty(handler, ROUTE_PERMISSION_METADATA_KEY, {
    value: { module: permission.module, action: permission.action },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return handler;
}

function makePlainHandler(): RequestHandler {
  return (_req, _res) => {
    /* no-op terminal handler, no permission metadata */
  };
}

function buildApp(routes: RouteSpec[]): Express {
  const app = express();
  for (const route of routes) {
    const verb = route.method.toLowerCase() as Lowercase<(typeof HTTP_METHODS)[number]>;
    if (route.permission) {
      app[verb](route.path, makeTaggedHandler(route.permission));
    } else {
      app[verb](route.path, makePlainHandler());
    }
  }
  return app;
}

// ─── Generators ──────────────────────────────────────────────────────────────

const segment = fc
  .stringMatching(/^[a-z][a-z0-9]{0,7}$/)
  .filter((s) => s.length > 0);

const pathArb = fc
  .array(segment, { minLength: 1, maxLength: 3 })
  .map((segs) => `/${segs.join('/')}`);

const identifier = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,11}$/).filter((s) => s.length > 0);

const permissionArb: fc.Arbitrary<Permission> = fc.record({
  module: identifier,
  action: identifier,
});

const routeArb: fc.Arbitrary<RouteSpec> = fc.record({
  method: fc.constantFrom(...HTTP_METHODS),
  path: pathArb,
  permission: fc.option(permissionArb, { nil: null }),
});

/**
 * Generate a list of routes, then keep only the first occurrence of each
 * (method, path) pair. Express registers one route layer per call, so distinct
 * (method, path) pairs guarantee one inventory entry each, keeping the oracle
 * a straightforward 1:1 mapping.
 */
const routesArb = fc.array(routeArb, { minLength: 0, maxLength: 12 }).map((routes) => {
  const seen = new Set<string>();
  const unique: RouteSpec[] = [];
  for (const r of routes) {
    const key = `${r.method}\u0000${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  return unique;
});

// ─── Oracle ──────────────────────────────────────────────────────────────────

function keyOf(method: string, path: string): string {
  return `${method.toUpperCase()}\u0000${path}`;
}

describe('Property 7: route↔permission inventory completeness & gap detection', () => {
  it('inventory has exactly one entry per route+method mapped to its permission or null', () => {
    fc.assert(
      fc.property(routesArb, (routes) => {
        const app = buildApp(routes);
        const inventory = buildRoutePermissionInventory(app);

        // (1) Cardinality: exactly one entry per registered route+method.
        expect(inventory.length).toBe(routes.length);

        // (2) The set of (method, path) keys matches the generated routes exactly.
        const invByKey = new Map<string, RoutePermissionEntry>();
        for (const entry of inventory) {
          const k = keyOf(entry.method, entry.path);
          // No duplicate keys allowed.
          expect(invByKey.has(k)).toBe(false);
          invByKey.set(k, entry);
        }

        for (const route of routes) {
          const k = keyOf(route.method, route.path);
          const entry = invByKey.get(k);
          expect(entry).toBeDefined();
          if (!entry) continue;

          // (3) permission mapping matches the oracle.
          if (route.permission === null) {
            expect(entry.permission).toBeNull();
          } else {
            expect(entry.permission).toEqual({
              module: route.permission.module,
              action: route.permission.action,
            });
          }

          // (4) mutating / isGap derived correctly.
          const mutating = MUTATING.has(route.method);
          expect(entry.mutating).toBe(mutating);
          expect(entry.isGap).toBe(mutating && route.permission === null);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('findAuthorizationGaps returns exactly the mutating routes with null permission', () => {
    fc.assert(
      fc.property(routesArb, (routes) => {
        const app = buildApp(routes);
        const inventory = buildRoutePermissionInventory(app);
        const gaps = findAuthorizationGaps(inventory);

        // Independent oracle: mutating routes that have no permission.
        const expectedKeys = new Set(
          routes
            .filter((r) => MUTATING.has(r.method) && r.permission === null)
            .map((r) => keyOf(r.method, r.path)),
        );

        const actualKeys = new Set(gaps.map((g) => keyOf(g.method, g.path)));

        // Exactly the expected set — no more, no less.
        expect(actualKeys.size).toBe(expectedKeys.size);
        expect(gaps.length).toBe(expectedKeys.size);
        for (const k of expectedKeys) {
          expect(actualKeys.has(k)).toBe(true);
        }
        // Every returned gap is genuinely a mutating, permission-less entry.
        for (const g of gaps) {
          expect(g.mutating).toBe(true);
          expect(g.permission).toBeNull();
          expect(g.isGap).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

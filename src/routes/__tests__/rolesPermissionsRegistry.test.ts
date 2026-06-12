import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-registry tests — consolidated `/roles/:id/permissions` (FIX-BE-4)
 *
 * After consolidation (task 5.1), ownership of `/roles/:id/permissions` lives
 * solely in `permissionAdmin.ts`:
 *   - GET  /roles/:id/permissions  (matrix read)   → permissionAdmin.ts only
 *   - POST /roles/:id/permissions  (matrix update) → permissionAdmin.ts only
 *   - PUT  /roles/:id/permissions                  → no longer registered anywhere
 * and `roles.ts` no longer registers GET/POST for that path.
 *
 * These tests construct the real route factories and inspect the Express router
 * stacks to derive each module's actual route registrations, then run those
 * registrations through the duplicate-detection utility (`detectDuplicates` /
 * `logDuplicateRoutes` over `routeRegistry`).
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.8
 */

// The route factories transitively import service modules that pull in the db
// at module load. Stub the db module so importing the real routers is side-effect
// free — we only inspect route registrations, never execute handlers.
vi.mock('../../db/index', () => ({ db: {} }));

import { createRoleRoutes } from '../roles';
import { createPermissionAdminRoutes } from '../permissionAdmin';
import {
  detectDuplicates,
  logDuplicateRoutes,
  registerRoute,
  clearRegistry,
  type RouteRegistration,
} from '../../utils/routeRegistry';

const PERMISSIONS_PATH = '/roles/:id/permissions';

/** No-op middleware/dependency stubs (handlers are never invoked here). */
const noop = (..._args: any[]) => undefined;
const passthrough = (_req: any, _res: any, next: any) => next();
const checkPermission = () => passthrough;
const authorize = () => passthrough;

/**
 * Walks an Express router's layer stack and returns one RouteRegistration per
 * (method, path) the router actually registers, tagged with the given source.
 */
function collectRoutes(router: any, source: string): RouteRegistration[] {
  const out: RouteRegistration[] = [];
  const stack: any[] = router?.stack ?? [];
  for (const layer of stack) {
    const route = layer?.route;
    if (!route) continue; // skip non-route middleware layers (e.g. rate limiter)
    const path: string = route.path;
    const methods: Record<string, boolean> = route.methods ?? {};
    for (const method of Object.keys(methods)) {
      if (!methods[method] || method === '_all') continue;
      out.push({ method: method.toUpperCase(), path, source });
    }
  }
  return out;
}

function buildRegistrations(): RouteRegistration[] {
  const rolesRouter = createRoleRoutes({} as any, passthrough, authorize, checkPermission, noop);
  const permissionAdminRouter = createPermissionAdminRoutes({} as any, passthrough, checkPermission, noop);
  return [
    ...collectRoutes(rolesRouter, 'roles.ts'),
    ...collectRoutes(permissionAdminRouter, 'permissionAdmin.ts'),
  ];
}

function sourcesFor(regs: RouteRegistration[], method: string, path: string): string[] {
  return regs
    .filter((r) => r.method === method && r.path === path)
    .map((r) => r.source);
}

describe('Route registry — consolidated /roles/:id/permissions (FIX-BE-4)', () => {
  let registrations: RouteRegistration[];

  beforeEach(() => {
    clearRegistry();
    registrations = buildRegistrations();
  });

  describe('Requirement 4.1: GET /roles/:id/permissions resolves to exactly one source', () => {
    it('registers GET /roles/:id/permissions in exactly one module (permissionAdmin.ts)', () => {
      const sources = sourcesFor(registrations, 'GET', PERMISSIONS_PATH);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toBe('permissionAdmin.ts');
    });
  });

  describe('Requirement 4.2: the write op for /roles/:id/permissions resolves to exactly one source', () => {
    it('registers POST /roles/:id/permissions in exactly one module (permissionAdmin.ts)', () => {
      const sources = sourcesFor(registrations, 'POST', PERMISSIONS_PATH);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toBe('permissionAdmin.ts');
    });
  });

  describe('Requirement 4.3: write op uses POST only, PUT is no longer registered', () => {
    it('does not register PUT /roles/:id/permissions in any module', () => {
      const sources = sourcesFor(registrations, 'PUT', PERMISSIONS_PATH);
      expect(sources).toHaveLength(0);
    });

    it('roles.ts no longer registers GET or POST /roles/:id/permissions', () => {
      const rolesOnly = registrations.filter((r) => r.source === 'roles.ts');
      const permRoutes = rolesOnly.filter((r) => r.path === PERMISSIONS_PATH);
      expect(permRoutes).toHaveLength(0);
    });
  });

  describe('Requirement 4.8: duplicate detector reports zero duplicates for the consolidated routes', () => {
    it('detectDuplicates finds no duplicate registration for GET or POST /roles/:id/permissions', () => {
      const duplicates = detectDuplicates(registrations);
      const permDuplicates = duplicates.filter((d) => d.path === PERMISSIONS_PATH);
      expect(permDuplicates).toHaveLength(0);
    });

    it('logDuplicateRoutes (over routeRegistry) reports zero duplicates for /roles/:id/permissions', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Populate the global registry with the real registrations, then run the
      // startup duplicate-detection routine.
      for (const reg of registrations) {
        registerRoute(reg.method, reg.path, reg.source);
      }

      const duplicates = logDuplicateRoutes();
      const permDuplicates = duplicates.filter((d) => d.path === PERMISSIONS_PATH);
      expect(permDuplicates).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });
});

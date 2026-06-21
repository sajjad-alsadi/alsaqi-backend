/**
 * CI Gate (2/4): Route↔permission authorization gaps — fail-closed.
 *
 * Design region (هـ); Requirements 6.5.
 *
 * Builds the live v1 router with stub dependencies but with the REAL
 * `checkPermission` factory (from `createAuthMiddlewares`) so that each protected
 * route carries the permission metadata the inventory introspects. It then runs
 * `buildRoutePermissionInventory` + `findAuthorizationGaps` and exits NON-ZERO if
 * any state-mutating route is missing a permission check (`isGap === true`), or if
 * the app/router cannot be constructed (inability to evaluate ⇒ fail closed).
 *
 * Run with `tsx scripts/ci/checkRoutePermissions.ts`.
 */

// Force production mode BEFORE importing auth middleware so the real
// `checkPermission` factory returns a tagged middleware for any unregistered
// module instead of throwing in dev — the gate must still evaluate, fail closed.
process.env.NODE_ENV = 'production';

import express from 'express';

import { createV1Router } from '../../src/routes/v1/index.js';
import { createCrudRoutes } from '../../src/utils/crudGenerator.js';
import { createAuthMiddlewares } from '../../src/middleware/auth.js';
import {
  buildRoutePermissionInventory,
  findAuthorizationGaps,
} from '../../src/security/routeInventory.js';

/**
 * Definitionally-public state-mutating routes that CANNOT carry a `checkPermission`
 * (module-plus-action) check, because they ARE the authentication lifecycle or are
 * explicitly unauthenticated. Requirement 6.5 targets registered *protected* routes;
 * these are public by design, so they are not authorization gaps.
 *
 * Keyed as "METHOD path" using the server-relative path produced by the route
 * inventory. This list is intentionally narrow: ONLY the `/auth` self-service
 * lifecycle (login / refresh / logout / password / pre-auth 2FA) and the
 * unauthenticated `/web-vitals` metrics intake. Every other mutating route without
 * a permission check still fails the gate closed.
 *
 * Adding a route here is a deliberate security decision and must be justified.
 */
const PUBLIC_MUTATING_ROUTES: ReadonlySet<string> = new Set([
  // /auth lifecycle (self-service; no RBAC module/action applies)
  'POST /login',
  'POST /refresh',
  'POST /logout',
  'POST /logout-all',
  'POST /forgot-password',
  'POST /change-password',
  'POST /update-password',
  // Pre-auth / self-service 2FA enrollment + verification
  'POST /2fa/setup',
  'POST /2fa/verify',
  'POST /2fa/validate',
  'POST /2fa/setup-pending',
  'POST /2fa/setup-complete',
  'POST /2fa/backup',
  'DELETE /2fa',
  // Unauthenticated client metrics intake (frontend reports before/during login)
  'POST /web-vitals',
]);

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function buildApp(): express.Express {
  const noop = (_req: any, _res: any, next: any) => (next ? next() : undefined);

  // Minimal stub DB sufficient for route registration (no queries are executed).
  const db: any = {
    isExternal: false,
    client: { dataDir: '/tmp' },
    prepare: () => ({ get: async () => null, all: async () => [], run: async () => undefined }),
    query: async () => ({ rows: [] }),
    transaction: (fn: Function) => fn(),
    validateIdentifier: (n: string) => n,
    exec: async () => undefined,
  };

  // REAL auth middlewares so checkPermission tags routes with { module, action }.
  const { authenticate, checkPermission, authorize, authLimiter } = createAuthMiddlewares(
    db,
    'ci-symmetric-secret',
    'ci-public-key',
  );

  const deps: any = {
    db,
    authenticate,
    authorize,
    checkPermission,
    authLimiter,
    createNotification: async () => true,
    createCrudRoutes,
    saveFile: async () => '/uploads/x',
    logError: async () => undefined,
    config: { jwtSecret: 's', jwtPrivateKey: 'priv', jwtPublicKey: 'pub' },
    idempotencyMiddleware: noop,
    queueService: null,
    storageService: null,
  };

  const app = express();
  app.use('/api/v1', createV1Router(deps));
  return app;
}

function main(): void {
  let app: express.Express;
  try {
    app = buildApp();
  } catch (err) {
    console.error(
      `[CI:route-perms] FATAL: could not build the Express app to inventory routes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  let gaps: ReturnType<typeof findAuthorizationGaps>;
  try {
    const inventory = buildRoutePermissionInventory(app);

    if (inventory.length === 0) {
      // No routes enumerated at all is itself suspicious — fail closed.
      console.error('[CI:route-perms] FATAL: route inventory is empty; cannot verify authorization coverage.');
      process.exit(1);
      return;
    }

    // Drop definitionally-public routes (auth lifecycle + web-vitals); every other
    // mutating route without a permission check remains a gap and fails closed.
    gaps = findAuthorizationGaps(inventory).filter(
      (entry) => !PUBLIC_MUTATING_ROUTES.has(routeKey(entry.method, entry.path)),
    );
  } catch (err) {
    console.error(
      `[CI:route-perms] FATAL: could not build the route↔permission inventory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  if (gaps.length > 0) {
    console.error(
      `[CI:route-perms] FAILED: ${gaps.length} state-mutating route(s) with no permission check (authorization gaps):`,
    );
    for (const gap of gaps) {
      console.error(`  ✗ ${gap.method} ${gap.path}`);
    }
    process.exit(1);
    return;
  }

  console.log('[CI:route-perms] OK: no authorization gaps on state-mutating routes.');
}

main();

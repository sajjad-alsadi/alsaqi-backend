/**
 * CI Gate (4/4): OpenAPI ↔ route bidirectional equivalence — fail-closed.
 *
 * Design region (ز); Requirements 10.4.
 *
 * Extracts the registered operations from the live v1 router (the same
 * enumeration used to generate docs/openapi.yaml), parses the operations from
 * docs/openapi.yaml, and runs the pure `checkOpenApiRouteEquivalence`. The gate
 * exits NON-ZERO if:
 *   - any registered route has no matching documented operation, OR
 *   - any documented operation has no matching registered route, OR
 *   - the router cannot be built or the spec cannot be read/parsed (inability to
 *     evaluate ⇒ fail closed).
 * Each divergent (method, pathTemplate) on either side is listed.
 *
 * The Docs_Endpoint (`/docs`) is excluded by the pure equivalence function.
 *
 * Run with `tsx scripts/ci/checkOpenApiEquivalence.ts`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { createV1Router } from '../../src/routes/v1/index.js';
import { createCrudRoutes } from '../../src/utils/crudGenerator.js';
import {
  checkOpenApiRouteEquivalence,
  type Operation,
} from '../../src/docs/openapiEquivalence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, '../../docs/openapi.yaml');

// ── Route enumeration (mirrors scripts/generate-openapi.mts so the comparison is
//    apples-to-apples with the document that script produces) ──────────────────

const noop = (_req: any, _res: any, next: any) => (next ? next() : undefined);
const passThrough = () => noop;

const deps: any = {
  db: {
    isExternal: false,
    client: { dataDir: '/tmp' },
    prepare: () => ({ get: async () => ({}), all: async () => [], run: async () => undefined }),
    query: async () => ({ rows: [] }),
  },
  authenticate: noop,
  authorize: passThrough,
  checkPermission: passThrough,
  authLimiter: noop,
  createNotification: async () => true,
  createCrudRoutes,
  saveFile: async () => '/x',
  logError: async () => undefined,
  config: { jwtSecret: 's', jwtPrivateKey: 'priv', jwtPublicKey: 'pub' },
  idempotencyMiddleware: noop,
  queueService: null,
  storageService: null,
};

// Ordered mount prefixes for each sub-router layer, matching the mount order in
// src/routes/v1/index.ts (kept in sync with scripts/generate-openapi.mts).
const MOUNTS: string[] = [
  '/', '/auth', '/', '/', '/notifications', '/comments', '/job-titles', '/users', '/', '/user-sessions',
  '/', '/', '/', '/', '/', '/correspondence', '/', '/', '/', '/', '/', '/departments', '/analytics', '/',
  '/audit-programs', '/audit-tasks', '/audit-findings', '/recommendations', '/', '/fraud-access-requests',
  '/compliance', '/bulk', '/admin', '/', '/reports', '/metrics',
];

function joinPaths(base: string, sub: string): string {
  let p = (base + '/' + sub).replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function toTemplate(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collectLeafRoutes(stack: any[], base: string, out: Operation[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePath: string = layer.route.path;
      const methods = layer.route.methods || {};
      const paths = Array.isArray(routePath) ? routePath : [routePath];
      for (const rp of paths) {
        const full = joinPaths(base, rp);
        for (const m of Object.keys(methods)) {
          if (methods[m] && m !== '_all') {
            out.push({ method: m.toUpperCase(), pathTemplate: toTemplate(full) });
          }
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectLeafRoutes(layer.handle.stack, base, out);
    }
  }
}

function enumerateRouteOperations(): Operation[] {
  const router = createV1Router(deps) as any;
  const ops: Operation[] = [];
  let routerIdx = 0;

  for (const layer of router.stack) {
    if (layer.route) {
      const methods = layer.route.methods || {};
      for (const m of Object.keys(methods)) {
        if (methods[m] && m !== '_all') {
          ops.push({ method: m.toUpperCase(), pathTemplate: toTemplate(joinPaths('', layer.route.path)) });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const prefix = MOUNTS[routerIdx] ?? '/';
      routerIdx++;
      collectLeafRoutes(layer.handle.stack, prefix === '/' ? '' : prefix, ops);
    }
  }

  // Exclude the Docs_Endpoint itself (GET /docs), matching the exclusion applied
  // by scripts/generate-openapi.mts before it writes docs/openapi.yaml. Because
  // routes are enumerated server-relative (no /api/v1 prefix), the docs route
  // surfaces as `/docs`; the pure equivalence function's own exclusion targets the
  // fully-prefixed `/api/v1/docs`, so we drop it here to stay apples-to-apples.
  const withoutDocs = ops.filter((op) => !(op.method === 'GET' && op.pathTemplate === '/docs'));

  // Deduplicate identical (method, path) pairs.
  const seen = new Set<string>();
  return withoutDocs.filter((op) => {
    const key = `${op.method} ${op.pathTemplate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── OpenAPI spec parsing ──────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function parseSpecOperations(rawYaml: string): Operation[] {
  const doc = parseYaml(rawYaml) as { paths?: Record<string, Record<string, unknown>> };
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    throw new Error('OpenAPI document has no "paths" object');
  }

  const ops: Operation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const key of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(key.toLowerCase())) {
        ops.push({ method: key.toUpperCase(), pathTemplate });
      }
    }
  }
  return ops;
}

function main(): void {
  let routes: Operation[];
  try {
    routes = enumerateRouteOperations();
    if (routes.length === 0) {
      throw new Error('no routes enumerated from the v1 router');
    }
  } catch (err) {
    console.error(
      `[CI:openapi] FATAL: could not enumerate registered routes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  let specOps: Operation[];
  try {
    const raw = readFileSync(SPEC_PATH, 'utf-8');
    specOps = parseSpecOperations(raw);
  } catch (err) {
    console.error(
      `[CI:openapi] FATAL: could not read/parse OpenAPI spec "${SPEC_PATH}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  const report = checkOpenApiRouteEquivalence(routes, specOps);

  if (!report.equivalent) {
    console.error('[CI:openapi] FAILED: OpenAPI ↔ route divergence detected.');
    if (report.missingInSpec.length > 0) {
      console.error(`  Registered routes with no documented operation (${report.missingInSpec.length}):`);
      for (const op of report.missingInSpec) {
        console.error(`    ✗ ${op.method} ${op.pathTemplate}`);
      }
    }
    if (report.missingInRoutes.length > 0) {
      console.error(`  Documented operations with no registered route (${report.missingInRoutes.length}):`);
      for (const op of report.missingInRoutes) {
        console.error(`    ✗ ${op.method} ${op.pathTemplate}`);
      }
    }
    process.exit(1);
    return;
  }

  console.log(
    `[CI:openapi] OK: ${routes.length} routes equivalent to ${specOps.length} documented operations.`,
  );
}

main();

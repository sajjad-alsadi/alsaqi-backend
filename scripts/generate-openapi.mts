/**
 * OpenAPI generator (task 7.1).
 *
 * Builds the live v1 router with stub dependencies, enumerates every registered
 * (method, pathTemplate) pair under /api/v1, and emits a structurally valid
 * OpenAPI 3.0 document at docs/openapi.yaml.
 *
 *   - Express `:param` segments are normalized to OpenAPI `{param}` style.
 *   - Each `{param}` is declared as a required string path parameter (so strict
 *     validators accept the document).
 *   - The Docs_Endpoint itself (GET /docs) is EXCLUDED from paths, per the
 *     equivalence contract in the design (region ز).
 *   - Every operation carries a summary + at least one response object.
 *
 * The document is emitted by hand (no yaml dependency available in this repo)
 * using a tiny, deterministic serializer that quotes every scalar — sufficient
 * for the simple, fixed shape we produce here.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createV1Router } from '../src/routes/v1/index.js';
import { createCrudRoutes } from '../src/utils/crudGenerator.js';

const noop = (_req: any, _res: any, next: any) => (next ? next() : undefined);
const passThrough = () => noop;
const deps: any = {
  db: { isExternal: false, client: { dataDir: '/tmp' }, prepare: () => ({ get: async () => ({}), all: async () => [], run: async () => undefined }), query: async () => ({ rows: [] }) },
  authenticate: noop, authorize: passThrough, checkPermission: passThrough, authLimiter: noop,
  createNotification: async () => true, createCrudRoutes, saveFile: async () => '/x', logError: async () => undefined,
  config: { jwtSecret: 's', jwtPrivateKey: 'priv', jwtPublicKey: 'pub' }, idempotencyMiddleware: noop, queueService: null, storageService: null,
};

const MOUNTS: string[] = [
  '/', '/auth', '/', '/', '/notifications', '/comments', '/job-titles', '/users', '/', '/user-sessions',
  '/', '/', '/', '/', '/', '/correspondence', '/', '/', '/', '/', '/', '/departments', '/analytics', '/',
  '/audit-programs', '/audit-tasks', '/audit-findings', '/recommendations', '/', '/fraud-access-requests',
  '/compliance', '/bulk', '/admin', '/', '/reports', '/metrics',
];

const router = createV1Router(deps) as any;

interface Op { method: string; pathTemplate: string; }
const ops: Op[] = [];

function joinPaths(base: string, sub: string): string {
  let p = (base + '/' + sub).replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function collectLeafRoutes(stack: any[], base: string): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePath: string = layer.route.path;
      const methods = layer.route.methods || {};
      const paths = Array.isArray(routePath) ? routePath : [routePath];
      for (const rp of paths) {
        const full = joinPaths(base, rp);
        for (const m of Object.keys(methods)) {
          if (methods[m] && m !== '_all') ops.push({ method: m.toUpperCase(), pathTemplate: full });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectLeafRoutes(layer.handle.stack, base);
    }
  }
}

let routerIdx = 0;
for (const layer of router.stack) {
  if (layer.route) {
    const methods = layer.route.methods || {};
    for (const m of Object.keys(methods)) {
      if (methods[m] && m !== '_all') ops.push({ method: m.toUpperCase(), pathTemplate: joinPaths('', layer.route.path) });
    }
  } else if (layer.name === 'router' && layer.handle?.stack) {
    const prefix = MOUNTS[routerIdx] ?? '/';
    routerIdx++;
    collectLeafRoutes(layer.handle.stack, prefix === '/' ? '' : prefix);
  }
}

// Express `:param` -> OpenAPI `{param}`
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
function paramNames(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

// Exclude the Docs_Endpoint itself (GET /docs) from the spec, per design region ز.
const filtered = ops.filter((o) => !(o.method === 'GET' && o.pathTemplate === '/docs'));

// Group methods by OpenAPI path.
const byPath = new Map<string, Set<string>>();
for (const o of filtered) {
  const oapiPath = toOpenApiPath(o.pathTemplate);
  if (!byPath.has(oapiPath)) byPath.set(oapiPath, new Set());
  byPath.get(oapiPath)!.add(o.method.toLowerCase());
}

const sortedPaths = [...byPath.keys()].sort();
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

const totalOps = filtered.length;
const lines: string[] = [];
lines.push('openapi: 3.0.3');
lines.push('info:');
lines.push('  title: Alsaqi Internal Audit API');
lines.push('  version: 1.0.0');
lines.push('  description: >-');
lines.push('    Auto-generated OpenAPI contract for the Alsaqi backend. Operations are');
lines.push('    derived from the routes registered under /api/v1 in');
lines.push('    src/routes/v1/index.ts. The Docs_Endpoint (GET /docs) is intentionally');
lines.push('    excluded from this contract.');
lines.push('servers:');
lines.push('  - url: /api/v1');
lines.push('    description: Versioned API base path');
lines.push('paths:');

for (const p of sortedPaths) {
  const methods = byPath.get(p)!;
  const params = paramNames(p);
  lines.push(`  ${quoteKey(p)}:`);
  if (params.length > 0) {
    lines.push('    parameters:');
    for (const name of params) {
      lines.push(`      - name: ${name}`);
      lines.push('        in: path');
      lines.push('        required: true');
      lines.push('        schema:');
      lines.push('          type: string');
    }
  }
  for (const m of METHOD_ORDER) {
    if (!methods.has(m)) continue;
    lines.push(`    ${m}:`);
    lines.push(`      summary: ${m.toUpperCase()} ${p}`);
    lines.push(`      operationId: ${operationId(m, p)}`);
    lines.push('      responses:');
    lines.push(`        '${defaultStatus(m)}':`);
    lines.push(`          description: Successful response`);
  }
}

function quoteKey(p: string): string {
  // Path keys contain { } and / — quote to be safe in YAML.
  return `'${p}'`;
}
function defaultStatus(method: string): string {
  return method === 'post' ? '201' : '200';
}
function operationId(method: string, p: string): string {
  const slug = p
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[^A-Za-z0-9]+/g, '_'))
    .join('_');
  return `${method}_${slug || 'root'}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../docs/openapi.yaml');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
console.error(`Wrote ${outPath}: ${sortedPaths.length} paths, ${totalOps} operations (router layers matched: ${routerIdx}).`);

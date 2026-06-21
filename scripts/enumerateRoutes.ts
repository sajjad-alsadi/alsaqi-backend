/**
 * Route enumeration helper (one-off, used to author docs/openapi.yaml).
 *
 * Builds the live v1 router with stub dependencies and walks the Express
 * router stack to extract every registered (method, pathTemplate) pair
 * under /api/v1. Express path params (":id") are converted to OpenAPI
 * path templates ("{id}").
 */
import express from 'express';
import { createV1Router } from '../src/routes/v1/index.js';
import { createCrudRoutes } from '../src/utils/crudGenerator.js';

const noop = (_req: any, _res: any, next: any) => (next ? next() : undefined);
const passthroughFactory = (..._args: any[]) => noop;

const deps: any = {
  db: {
    prepare: () => ({ get: async () => null, all: async () => [], run: async () => ({}) }),
    transaction: (fn: Function) => fn(),
    validateIdentifier: (n: string) => n,
    exec: async () => undefined,
  },
  authenticate: noop,
  authorize: () => noop,
  checkPermission: () => noop,
  authLimiter: noop,
  createNotification: async () => true,
  createCrudRoutes,
  saveFile: async () => '/uploads/x',
  logError: async () => undefined,
  config: { jwtPublicKey: 'x', jwtPrivateKey: 'x' },
  idempotencyMiddleware: noop,
  queueService: null,
  storageService: null,
};

interface Op {
  method: string;
  path: string;
}

function expressPathToTemplate(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collect(stack: any[], prefix: string, out: Op[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const full = joinPaths(prefix, routePath);
      const methods = Object.keys(layer.route.methods || {}).filter((m) => m !== '_all');
      for (const m of methods) {
        out.push({ method: m.toUpperCase(), path: expressPathToTemplate(full) });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mount = extractMountPath(layer, prefix);
      collect(layer.handle.stack, mount, out);
    }
  }
}

function joinPaths(a: string, b: string): string {
  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b.startsWith('/') ? b : `/${b}`;
  const joined = `${left}${right}`;
  return joined === '' ? '/' : joined.replace(/\/{2,}/g, '/');
}

function extractMountPath(layer: any, prefix: string): string {
  // Express 5 stores the mount regexp; recover a literal path if possible.
  const fast = layer.regexp?.fast_slash;
  if (fast) return prefix;
  const src: string | undefined = layer.regexp?.source;
  if (!src) return prefix;
  // Typical source: ^\/segment\/?(?=\/|$)
  const m = src.match(/^\^\\\/(.*?)\\\/\?\(\?=/);
  if (m && m[1]) {
    const seg = m[1].replace(/\\\//g, '/');
    return joinPaths(prefix, `/${seg}`);
  }
  return prefix;
}

const router = createV1Router(deps);
const ops: Op[] = [];
collect((router as any).stack, '/api/v1', ops);

// Deduplicate
const seen = new Set<string>();
const unique = ops.filter((o) => {
  const k = `${o.method} ${o.path}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

unique.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

for (const o of unique) {
  console.log(`${o.method}\t${o.path}`);
}
console.error(`TOTAL: ${unique.length}`);

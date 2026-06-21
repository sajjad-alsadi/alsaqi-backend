import express from 'express';
import { createV1Router } from '../src/routes/v1/index.js';
import { createCrudRoutes } from '../src/utils/crudGenerator.js';

const noop = (_req: any, _res: any, next: any) => (next ? next() : undefined);
const deps: any = {
  db: { prepare: () => ({ get: async () => null, all: async () => [], run: async () => ({}) }), transaction: (fn: Function) => fn(), validateIdentifier: (n: string) => n, exec: async () => undefined },
  authenticate: noop, authorize: () => noop, checkPermission: () => noop, authLimiter: noop,
  createNotification: async () => true, createCrudRoutes, saveFile: async () => '/uploads/x',
  logError: async () => undefined, config: { jwtPublicKey: 'x', jwtPrivateKey: 'x' },
  idempotencyMiddleware: noop, queueService: null, storageService: null,
};
const router = createV1Router(deps);
for (const layer of (router as any).stack) {
  if (layer.name === 'router') {
    console.log(JSON.stringify({ name: layer.name, keys: Object.keys(layer), regexp: layer.regexp ? { source: layer.regexp.source, keys: layer.keys } : undefined, matchers: layer.matchers, path: layer.path }, null, 0));
  }
}

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { API_VERSION } from '@alsaqi/shared';
import {
  versionFallbackRewrite,
  unsupportedVersionHandler,
  SUPPORTED_VERSIONS,
} from '../middleware/versionRewrite';
import { notFoundHandler } from '../middleware/notFoundHandler';
import { VERSION_SOURCE } from '../utils/apiVersionSource';

/**
 * Property Test: X-API-Version major.minor matches Shared_API_Version
 *
 * Feature: backend-api-contract-alignment, Property 2: X-API-Version
 * major.minor equals Shared_API_Version major.minor under default config
 *
 * **Validates: Requirements 3.3, 3.4**
 *
 * Under the default configuration (no `API_VERSION` environment override),
 * the single VERSION_SOURCE equals Shared_API_Version (the `API_VERSION`
 * constant exported from `@alsaqi/shared`). Consequently the MajorMinor
 * portion (`major.minor`) of the `X-API-Version` header sent on every `/api`
 * response equals the MajorMinor portion of Shared_API_Version, so the
 * frontend's major.minor comparison reports no mismatch (no false
 * "update available" notice).
 *
 * The test app mirrors the relevant slice of `createApiServer` in src/index.ts:
 *  - the early version-header middleware (step 0a) sets X-API-Version from the
 *    single VERSION_SOURCE before downstream middleware;
 *  - versionFallbackRewrite + a v1 router produce 200 successes;
 *  - unsupportedVersionHandler produces 404 (VERSION_NOT_FOUND) for v2+;
 *  - notFoundHandler produces 404 for unknown routes.
 *
 * Starting the full app requires a DB, so this minimal app reuses the real
 * middleware (the single source of truth VERSION_SOURCE) without a DB. The
 * property is scoped to the default config, so this run asserts that
 * VERSION_SOURCE itself resolves to Shared_API_Version on major.minor.
 */

// ─── major.minor extraction ──────────────────────────────────────────────────

/** Returns the `major.minor` portion of a semver-ish string (e.g. "1.0.0" → "1.0"). */
function majorMinor(version: string): string {
  const [major = '', minor = ''] = version.split('.');
  return `${major}.${minor}`;
}

// ─── Known API resources (resolve to 200) ────────────────────────────────────

const KNOWN_RESOURCES = [
  'audit-findings',
  'audit-tasks',
  'my-tasks',
  'dashboard-stats',
  'users',
  'notifications',
  'departments',
] as const;

// ─── Test App Factory ─────────────────────────────────────────────────────────

function createTestApp() {
  const app = express();

  // Step 0a: early X-API-Version header from the single VERSION_SOURCE.
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('X-API-Version', VERSION_SOURCE);
    }
    next();
  });

  // Unsupported version handler (before fallback rewrite) → 404 VERSION_NOT_FOUND.
  app.use('/api/', unsupportedVersionHandler);

  // Version fallback: /api/{resource} → /api/v1/{resource}
  app.use('/api', versionFallbackRewrite);

  // v1 router with known resources (success path).
  const v1Router = express.Router();
  for (const resource of KNOWN_RESOURCES) {
    const handler = (req: any, res: any) => {
      res.json({ success: true, data: { resource }, meta: {} });
    };
    v1Router.all(`/${resource}`, handler);
    v1Router.all(`/${resource}/:id`, handler);
  }
  app.use('/api/v1', v1Router);

  // Unknown /api routes → 404.
  app.use('/api', notFoundHandler);

  return app;
}

// ─── Arbitraries: each describes one /api request of a given kind ─────────────

type ReqDescriptor =
  | { kind: 'success'; resource: string }
  | { kind: 'unknown'; resource: string }
  | { kind: 'badVersion'; version: number; resource: string };

const knownResourceArb = fc.constantFrom(...KNOWN_RESOURCES);

const unknownResourceArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{2,15}$/)
  .filter((s) => !KNOWN_RESOURCES.includes(s as any))
  .filter((s) => !/^v\d/.test(s));

const unsupportedVersionArb = fc
  .integer({ min: 2, max: 99 })
  .filter((v) => !SUPPORTED_VERSIONS.includes(v));

const requestDescriptorArb: fc.Arbitrary<ReqDescriptor> = fc.oneof(
  knownResourceArb.map((resource) => ({ kind: 'success' as const, resource })),
  unknownResourceArb.map((resource) => ({ kind: 'unknown' as const, resource })),
  fc
    .record({ version: unsupportedVersionArb, resource: knownResourceArb })
    .map(({ version, resource }) => ({ kind: 'badVersion' as const, version, resource }))
);

// ─── Driver: fire one descriptor and return the response ──────────────────────

async function fire(app: express.Express, d: ReqDescriptor) {
  switch (d.kind) {
    case 'success':
      return request(app).get(`/api/${d.resource}`);
    case 'unknown':
      return request(app).get(`/api/${d.resource}`);
    case 'badVersion':
      return request(app).get(`/api/v${d.version}/${d.resource}`);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 2: X-API-Version major.minor equals Shared_API_Version major.minor under default config', () => {
  it('VERSION_SOURCE resolves to Shared_API_Version under the default config (no API_VERSION override)', () => {
    // The suite runs without an API_VERSION env override, so the single source
    // of truth equals Shared_API_Version exactly.
    expect(VERSION_SOURCE).toBe(API_VERSION);
  });

  it('every /api response carries an X-API-Version whose major.minor equals Shared_API_Version major.minor', async () => {
    const expectedMajorMinor = majorMinor(API_VERSION);

    await fc.assert(
      fc.asyncProperty(requestDescriptorArb, async (descriptor) => {
        const app = createTestApp();

        const res = await fire(app, descriptor);
        const header = res.headers['x-api-version'];

        // The header is present and derived from the single VERSION_SOURCE.
        expect(header).toBeDefined();

        // R3.3: under default config VERSION_SOURCE equals Shared_API_Version.
        // R3.4: the major.minor portion of the header equals Shared_API_Version
        // major.minor, so the frontend comparison reports no mismatch.
        expect(majorMinor(header as string)).toBe(expectedMajorMinor);
      }),
      { numRuns: 100 }
    );
  });
});

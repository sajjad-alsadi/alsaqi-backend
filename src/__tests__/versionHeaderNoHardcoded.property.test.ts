// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import {
  versionFallbackRewrite,
  unsupportedVersionHandler,
  CURRENT_API_VERSION,
  SUPPORTED_VERSIONS,
} from '../middleware/versionRewrite';
import { bodySizeLimit, MAX_BODY_SIZE } from '../middleware/validate';
import { notFoundHandler } from '../middleware/notFoundHandler';
import { VERSION_SOURCE } from '../utils/apiVersionSource';

/**
 * Property Test: X-API-Version has no conflicting hardcoded value
 *
 * Feature: backend-api-contract-alignment, Property 3: X-API-Version always
 * equals VERSION_SOURCE, never a hardcoded alternative such as "1.0"
 *
 * **Validates: Requirements 3.1, 3.6**
 *
 * The codebase previously set `X-API-Version` from three conflicting writers,
 * one of which (`apiVersionHeader` in versionRewrite.ts) hardcoded the
 * major.minor-only string `"1.0"` (i.e.
 * `${CURRENT_API_VERSION.major}.${CURRENT_API_VERSION.minor}`). That writer was
 * removed in favour of a single source of truth (VERSION_SOURCE in
 * src/utils/apiVersionSource.ts).
 *
 * This property asserts that for ANY /api request — successful ones AND
 * early-rejection ones such as 404 (unknown route / unsupported version) and
 * 413 (payload too large) — the `X-API-Version` header always equals the single
 * VERSION_SOURCE value and is never the hardcoded major.minor-only alternative
 * `"1.0"` (R3.1, R3.6). Under the default config VERSION_SOURCE is the full
 * semver `"1.0.0"`, which is distinct from the removed hardcoded `"1.0"`; the
 * guard only relaxes in the (non-default) case where VERSION_SOURCE itself is
 * exactly equal to that string.
 *
 * The test app mirrors the relevant slice of `createApiServer` in src/index.ts:
 *  - the early version-header middleware (step 0a) sets X-API-Version from the
 *    single VERSION_SOURCE BEFORE body parsing and the body-size limit, so the
 *    header is set even on early-rejection responses;
 *  - bodySizeLimit produces 413;
 *  - unsupportedVersionHandler produces 404 (VERSION_NOT_FOUND) for v2+;
 *  - versionFallbackRewrite + a v1 router produce 200 successes;
 *  - notFoundHandler produces 404 for unknown routes.
 *
 * Starting the full app requires a DB, so this minimal app reuses the real
 * middleware (the single source of truth VERSION_SOURCE) without a DB.
 */

// ─── The removed hardcoded value ──────────────────────────────────────────────

/**
 * The major.minor-only value that the deleted `apiVersionHeader` middleware
 * used to hardcode. We reconstruct it from CURRENT_API_VERSION exactly as the
 * removed code did, so the assertion tracks the real alternative value rather
 * than a magic literal.
 */
const HARDCODED_MAJOR_MINOR = `${CURRENT_API_VERSION.major}.${CURRENT_API_VERSION.minor}`;

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
  // Registered BEFORE body parsing and the body-size limit so the header is
  // present even on early-rejection responses (413/404).
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('X-API-Version', VERSION_SOURCE);
    }
    next();
  });

  // Parse JSON with a high limit so the dedicated bodySizeLimit middleware
  // (1 MB) is the writer that produces the 413, mirroring src/index.ts.
  app.use(express.json({ limit: '10mb' }));

  // Body-size limit → 413 early-rejection responses.
  app.use('/api', bodySizeLimit);

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
  | { kind: 'badVersion'; version: number; resource: string }
  | { kind: 'tooLarge'; resource: string };

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
    .map(({ version, resource }) => ({ kind: 'badVersion' as const, version, resource })),
  knownResourceArb.map((resource) => ({ kind: 'tooLarge' as const, resource }))
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
    case 'tooLarge': {
      // A body larger than MAX_BODY_SIZE triggers the 413 early rejection.
      const big = 'x'.repeat(MAX_BODY_SIZE + 1024);
      return request(app)
        .post(`/api/${d.resource}`)
        .set('Content-Type', 'application/json')
        .send({ blob: big });
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 3: X-API-Version always equals VERSION_SOURCE, never a hardcoded alternative such as "1.0"', () => {
  it('for any /api request the header equals VERSION_SOURCE and is never the hardcoded major.minor-only value', async () => {
    await fc.assert(
      fc.asyncProperty(requestDescriptorArb, async (descriptor) => {
        const app = createTestApp();

        const res = await fire(app, descriptor);
        const header = res.headers['x-api-version'];

        // R3.1: the header is derived from the single VERSION_SOURCE.
        expect(header).toBeDefined();
        expect(header).toBe(VERSION_SOURCE);

        // R3.6: the header is never the removed hardcoded value "1.0", unless
        // VERSION_SOURCE itself is exactly that string (it is "1.0.0" under the
        // default semver config, so this guard holds).
        if (VERSION_SOURCE !== HARDCODED_MAJOR_MINOR) {
          expect(header).not.toBe(HARDCODED_MAJOR_MINOR);
        }
      }),
      { numRuns: 100 }
    );
  });
});

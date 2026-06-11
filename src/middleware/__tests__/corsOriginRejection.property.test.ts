// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createCorsMiddleware } from '../cors';

/**
 * Property 11: CORS Origin Rejection
 *
 * **Validates: Requirements 7.2**
 *
 * For any request origin string that is not present in the configured
 * CORS_ORIGIN comma-separated list, the CORS middleware in production mode
 * SHALL omit CORS headers (effectively rejecting the cross-origin request).
 *
 * Strategy:
 * - Configure createCorsMiddleware with a fixed set of allowed origins
 *   (simulating the parsed CORS_ORIGIN env variable).
 * - Generate random origin strings guaranteed NOT to be in the allowed list.
 * - Send requests with these origins and verify Access-Control-Allow-Origin
 *   header is absent from the response.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Fixed allowed origins simulating the CORS_ORIGIN env variable parsed as
 * comma-separated list: "https://app.alsaqi.com,https://admin.alsaqi.com,http://localhost:5173"
 */
const ALLOWED_ORIGINS = [
  'https://app.alsaqi.com',
  'https://admin.alsaqi.com',
  'http://localhost:5173',
];

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate random origin-like strings that are NOT in the allowed list.
 * Origins follow the pattern: protocol://domain
 * We generate valid-looking origins and filter out any that match the allowed list.
 */
const unlimitedOriginArb = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.[a-z]{2,6}$/)
  )
  .map(([protocol, domain]) => `${protocol}://${domain}`)
  .filter((origin) => !ALLOWED_ORIGINS.includes(origin));

/**
 * Generate more exotic origin strings that should never match any real allowed origin.
 * Includes random subdomains, ports, IP addresses, etc.
 */
const exoticOriginArb = fc.oneof(
  // Random subdomain of alsaqi.com (not in allowed list)
  fc
    .stringMatching(/^[a-z]{3,10}$/)
    .filter((sub) => sub !== 'app' && sub !== 'admin')
    .map((sub) => `https://${sub}.alsaqi.com`),
  // Origins with port numbers
  fc
    .tuple(
      fc.constantFrom('http', 'https'),
      fc.stringMatching(/^[a-z][a-z0-9-]{2,12}\.[a-z]{2,4}$/),
      fc.integer({ min: 1000, max: 65535 }).filter((port) => port !== 5173)
    )
    .map(([protocol, domain, port]) => `${protocol}://${domain}:${port}`),
  // IP-based origins
  fc
    .tuple(
      fc.constantFrom('http', 'https'),
      fc.integer({ min: 1, max: 254 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 })
    )
    .map(([protocol, a, b, c, d]) => `${protocol}://${a}.${b}.${c}.${d}`)
);

/**
 * Combined arbitrary that produces diverse unlisted origins.
 */
const unlistedOriginArb = fc.oneof(unlimitedOriginArb, exoticOriginArb);

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createProductionApp(allowedOrigins: string[]) {
  const app = express();
  app.use(
    createCorsMiddleware({
      allowedOrigins,
      nodeEnv: 'production',
    })
  );
  app.get('/api/test', (_req, res) => {
    res.json({ ok: true });
  });
  app.options('/api/test', (_req, res) => {
    res.sendStatus(204);
  });
  return app;
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 11: CORS Origin Rejection', () => {
  it('for ANY origin NOT in the allowed CORS_ORIGIN list, the CORS middleware SHALL omit Access-Control-Allow-Origin header', async () => {
    await fc.assert(
      fc.asyncProperty(unlistedOriginArb, async (origin) => {
        const app = createProductionApp(ALLOWED_ORIGINS);

        const res = await request(app).get('/api/test').set('Origin', origin);

        // Access-Control-Allow-Origin MUST be absent for rejected origins
        const acaoHeader = res.headers['access-control-allow-origin'];
        expect(acaoHeader).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('for ANY origin NOT in the allowed list, preflight OPTIONS requests SHALL omit all CORS response headers', async () => {
    await fc.assert(
      fc.asyncProperty(unlistedOriginArb, async (origin) => {
        const app = createProductionApp(ALLOWED_ORIGINS);

        const res = await request(app)
          .options('/api/test')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');

        // No CORS headers should be present for rejected origins
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
        expect(res.headers['access-control-allow-headers']).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('wildcard (*) in the allowed list is filtered out in production mode, still rejecting unlisted origins', async () => {
    // Even if wildcard is in the list, production mode strips it
    const originsWithWildcard = ['*', ...ALLOWED_ORIGINS];

    await fc.assert(
      fc.asyncProperty(unlistedOriginArb, async (origin) => {
        const app = createProductionApp(originsWithWildcard);

        const res = await request(app).get('/api/test').set('Origin', origin);

        // Wildcard should be ignored in production — origin still rejected
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('sanity check: origins IN the allowed list DO receive Access-Control-Allow-Origin header', async () => {
    const allowedOriginArb = fc.constantFrom(...ALLOWED_ORIGINS);

    await fc.assert(
      fc.asyncProperty(allowedOriginArb, async (origin) => {
        const app = createProductionApp(ALLOWED_ORIGINS);

        const res = await request(app).get('/api/test').set('Origin', origin);

        expect(res.headers['access-control-allow-origin']).toBe(origin);
      }),
      { numRuns: 10 }
    );
  });
});

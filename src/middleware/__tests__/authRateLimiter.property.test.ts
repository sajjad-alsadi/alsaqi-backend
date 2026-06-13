// @vitest-environment node
// Feature: backend-security-hardening, Property 26: Rate-limit keying is per source IP across usernames
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test: Rate-limit keying is per source IP across usernames (Property 26)
 *
 * **Validates: Requirements 18.1**
 *
 * For any set of authentication attempts originating from a single source IP
 * with arbitrary (including differing) supplied usernames, all attempts map to
 * the same rate-limit counter key, so the per-source-IP count increases
 * regardless of which username is supplied. Conversely, attempts from different
 * source IPs map to different keys.
 *
 * The `authLimiter` keyGenerator is defined in src/middleware/auth.ts
 * (createAuthMiddlewares -> authLimiter) and returns `req.ip` only (falling back
 * to 'no-ip'). To exercise it in isolation we mock `express-rate-limit` so we can
 * capture the `keyGenerator` option passed when the middleware is constructed.
 */

// Capture the options passed to rateLimit() so we can extract the keyGenerator.
let capturedRateLimitOptions: any = null;

vi.mock('express-rate-limit', () => ({
  rateLimit: (options: any) => {
    capturedRateLimitOptions = options;
    // Return a no-op middleware; we only care about the captured options here.
    return (_req: any, _res: any, next: any) => next();
  },
}));

// Mock Redis to avoid real connections
vi.mock('../../cache/redisManager.js', () => ({
  redisManager: {
    getClient: () => null,
    isAvailable: false,
    status: 'degraded',
    get: async () => null,
    set: async () => false,
    del: async () => false,
  },
}));

// Mock logger to suppress output during tests
vi.mock('../../utils/logger.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createAuthMiddlewares } from '../auth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a mock DB (not used by authLimiter, but needed to create middlewares) */
function createMockDb() {
  return {
    prepare: () => ({
      get: async () => null,
    }),
  };
}

/**
 * Builds the auth middlewares (which constructs authLimiter via the mocked
 * rateLimit) and returns the captured keyGenerator function.
 */
function getKeyGenerator(): (req: any) => string {
  capturedRateLimitOptions = null;
  createAuthMiddlewares(createMockDb(), 'test-jwt-secret', 'test-public-key');
  expect(capturedRateLimitOptions).not.toBeNull();
  expect(typeof capturedRateLimitOptions.keyGenerator).toBe('function');
  return capturedRateLimitOptions.keyGenerator;
}

/** Creates a mock Express Request simulating a login attempt */
function createMockLoginReq(ip: string, username: string) {
  return {
    ip,
    headers: {},
    body: { usernameOrEmail: username },
    cookies: {},
    originalUrl: '/api/v1/auth/login',
    method: 'POST',
  } as any;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a valid IPv4 address */
const ipv4Arb = fc
  .tuple(
    fc.integer({ min: 1, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 })
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Generates an arbitrary username string (including unusual/edge content) */
const usernameArb = fc.string({ maxLength: 40 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 26: Rate-limit keying is per source IP across usernames', () => {
  beforeEach(() => {
    capturedRateLimitOptions = null;
  });

  it('maps all usernames from the same IP to the same rate-limit key (Req 18.1)', async () => {
    const keyGenerator = getKeyGenerator();

    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        fc.array(usernameArb, { minLength: 1, maxLength: 10 }),
        async (ip, usernames) => {
          // Every attempt from this IP, regardless of username, must yield the same key.
          const keys = usernames.map((u) => keyGenerator(createMockLoginReq(ip, u)));
          for (const k of keys) {
            expect(k).toBe(ip);
          }
          // All keys identical to each other.
          expect(new Set(keys).size).toBe(1);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('maps different source IPs to different keys (Req 18.1)', async () => {
    const keyGenerator = getKeyGenerator();

    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        ipv4Arb,
        usernameArb,
        usernameArb,
        async (ip1, ip2, username1, username2) => {
          fc.pre(ip1 !== ip2);
          // Different IPs => different keys, even with the same or different usernames.
          const key1 = keyGenerator(createMockLoginReq(ip1, username1));
          const key2 = keyGenerator(createMockLoginReq(ip2, username2));
          expect(key1).not.toBe(key2);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('produces a key independent of req.body.usernameOrEmail (Req 18.1)', async () => {
    const keyGenerator = getKeyGenerator();

    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        usernameArb,
        async (ip, username) => {
          // Same IP: with a username vs. without any body at all => same key.
          const keyWithUser = keyGenerator(createMockLoginReq(ip, username));
          const keyNoBody = keyGenerator({ ip, headers: {}, cookies: {} } as any);
          expect(keyWithUser).toBe(keyNoBody);
          expect(keyWithUser).toBe(ip);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('falls back to a stable key when req.ip is absent (Req 18.1)', async () => {
    const keyGenerator = getKeyGenerator();

    await fc.assert(
      fc.asyncProperty(usernameArb, async (username) => {
        // No req.ip: all such attempts must still collapse to one stable key,
        // never keyed by username.
        const key = keyGenerator({ ip: undefined, body: { usernameOrEmail: username } } as any);
        expect(key).toBe('no-ip');
      }),
      { numRuns: 200 }
    );
  });
});

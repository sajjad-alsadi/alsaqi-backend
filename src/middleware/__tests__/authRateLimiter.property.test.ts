// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test: Rate Limit Enforcement (Property 8)
 *
 * **Validates: Requirements 5.1, 5.2**
 *
 * For any IP-plus-username combination making more than 10 login requests
 * within a 15-minute window, the Auth_Middleware SHALL reject subsequent
 * requests with the error message TOO_MANY_ATTEMPTS.
 */

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

/**
 * Creates a mock Express Response compatible with express-rate-limit v8.
 * express-rate-limit calls: response.status(), response.setHeader(),
 * response.send(), response.headersSent, response.writableEnded, response.once()
 */
function createMockRes() {
  let statusCode = 200;
  let body: any = null;
  const headers: Record<string, string> = {};
  let headersSent = false;
  let writableEnded = false;

  const res = {
    headersSent,
    writableEnded,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      headersSent = true;
      writableEnded = true;
      res.headersSent = true;
      res.writableEnded = true;
      return res;
    },
    send(data: any) {
      body = data;
      headersSent = true;
      writableEnded = true;
      res.headersSent = true;
      res.writableEnded = true;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    // express-rate-limit uses response.once for skip tracking
    once(_event: string, _handler: () => void) {},
    getStatusCode: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  } as any;

  let nextCalled = false;
  const next = () => { nextCalled = true; };
  const wasNextCalled = () => nextCalled;

  return { res, next, wasNextCalled };
}

/**
 * Invokes the authLimiter middleware and waits for it to complete.
 * express-rate-limit v8 is async, so we need to properly await it.
 */
async function invokeRateLimiter(
  authLimiter: any,
  req: any,
  res: any,
  next: () => void
): Promise<void> {
  await authLimiter(req, res, next);
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

/** Generates a plausible username (alphanumeric, 3-20 chars) */
const usernameArb = fc
  .tuple(
    fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    fc.array(
      fc.constantFrom('a', 'b', 'c', 'd', 'e', '0', '1', '2', '3', '_'),
      { minLength: 2, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest.join(''));

/** Generates a number of requests exceeding the limit (11 to 15) */
const requestCountAboveLimitArb = fc.integer({ min: 11, max: 15 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 8: Rate Limit Enforcement', () => {
  it('allows up to 10 requests from the same IP+username within the window', async () => {
    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        usernameArb,
        async (ip, username) => {
          // Create fresh middlewares for each property run (fresh rate limiter store)
          const { authLimiter } = createAuthMiddlewares(
            createMockDb(),
            'test-jwt-secret',
            'test-public-key'
          );

          // Send exactly 10 requests - all should be allowed
          for (let i = 0; i < 10; i++) {
            const req = createMockLoginReq(ip, username);
            const { res, next, wasNextCalled } = createMockRes();

            await invokeRateLimiter(authLimiter, req, res, next);

            expect(wasNextCalled()).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects the 11th+ request from the same IP+username with TOO_MANY_ATTEMPTS', async () => {
    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        usernameArb,
        requestCountAboveLimitArb,
        async (ip, username, totalRequests) => {
          // Create fresh middlewares for each property run (fresh rate limiter store)
          const { authLimiter } = createAuthMiddlewares(
            createMockDb(),
            'test-jwt-secret',
            'test-public-key'
          );

          // Exhaust the rate limit (10 allowed requests)
          for (let i = 0; i < 10; i++) {
            const req = createMockLoginReq(ip, username);
            const { res, next } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
          }

          // Now send requests beyond the limit - all should be rejected
          for (let i = 10; i < totalRequests; i++) {
            const req = createMockLoginReq(ip, username);
            const { res, next, wasNextCalled } = createMockRes();

            await invokeRateLimiter(authLimiter, req, res, next);

            // Must NOT call next (request is blocked)
            expect(wasNextCalled()).toBe(false);
            // Must respond with 429 status
            expect(res.getStatusCode()).toBe(429);
            // Must respond with TOO_MANY_ATTEMPTS message
            const body = res.getBody();
            expect(body).not.toBeNull();
            expect(body.error).toBe('TOO_MANY_ATTEMPTS');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('does not rate limit different IP+username combinations independently', async () => {
    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        ipv4Arb,
        usernameArb,
        usernameArb,
        async (ip1, ip2, username1, username2) => {
          // Ensure different combinations
          const key1 = `${ip1}_${username1.toLowerCase()}`;
          const key2 = `${ip2}_${username2.toLowerCase()}`;
          fc.pre(key1 !== key2);

          // Create fresh middlewares
          const { authLimiter } = createAuthMiddlewares(
            createMockDb(),
            'test-jwt-secret',
            'test-public-key'
          );

          // Exhaust the rate limit for IP1+username1
          for (let i = 0; i < 10; i++) {
            const req = createMockLoginReq(ip1, username1);
            const { res, next } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
          }

          // Verify IP1+username1 is now blocked
          {
            const req = createMockLoginReq(ip1, username1);
            const { res, next, wasNextCalled } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
            expect(wasNextCalled()).toBe(false);
            expect(res.getStatusCode()).toBe(429);
          }

          // IP2+username2 should still be able to make requests
          {
            const req = createMockLoginReq(ip2, username2);
            const { res, next, wasNextCalled } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
            expect(wasNextCalled()).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('key generator normalizes username to lowercase', async () => {
    await fc.assert(
      fc.asyncProperty(
        ipv4Arb,
        usernameArb,
        async (ip, username) => {
          // Create fresh middlewares
          const { authLimiter } = createAuthMiddlewares(
            createMockDb(),
            'test-jwt-secret',
            'test-public-key'
          );

          // Mix case variations of the same username share the same rate limit bucket
          const upperUsername = username.toUpperCase();

          // Send 5 requests with lowercase
          for (let i = 0; i < 5; i++) {
            const req = createMockLoginReq(ip, username);
            const { res, next } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
          }

          // Send 5 requests with uppercase (same user, same bucket)
          for (let i = 0; i < 5; i++) {
            const req = createMockLoginReq(ip, upperUsername);
            const { res, next } = createMockRes();
            await invokeRateLimiter(authLimiter, req, res, next);
          }

          // The 11th request (either case) should be rate limited
          const req = createMockLoginReq(ip, username);
          const { res, next, wasNextCalled } = createMockRes();
          await invokeRateLimiter(authLimiter, req, res, next);

          expect(wasNextCalled()).toBe(false);
          expect(res.getStatusCode()).toBe(429);
          const body = res.getBody();
          expect(body).not.toBeNull();
          expect(body.error).toBe('TOO_MANY_ATTEMPTS');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import type { Request, Response, NextFunction } from 'express';

/**
 * Property Tests for Rate Limiting (Task 5.2)
 *
 * - Property 12: Real IP Extraction
 * - Property 13: Per-Endpoint Rate Limits
 * - Property 14: Rate Limit Exceeded Response
 *
 * **Validates: Requirements 8.1, 8.3, 8.4**
 */

// Mock Redis as unavailable so it falls back to in-memory store
vi.mock('../../cache/redisManager.js', () => ({
  default: {
    getClient: () => null,
    isAvailable: false,
    status: 'degraded',
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

import {
  extractClientIp,
  createRateLimiter,
  resetRateLimiterStore,
  stopRateLimiterCleanup,
} from '../rateLimiter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a mock Express Request object */
function createMockReq(overrides: Partial<Request> & { ip?: string; headers?: Record<string, string>; originalUrl?: string } = {}): Request {
  return {
    ip: overrides.ip,
    headers: overrides.headers || {},
    socket: { remoteAddress: '127.0.0.1' },
    originalUrl: overrides.originalUrl || '/api/test',
    path: overrides.originalUrl || '/api/test',
    user: (overrides as any).user || undefined,
    ...overrides,
  } as unknown as Request;
}

/** Creates a mock Express Response object that captures status, headers, and body */
function createMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: any = null;
  let nextCalled = false;

  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => body,
  } as unknown as Response & { getStatusCode: () => number; getHeaders: () => Record<string, string>; getBody: () => any };

  const next: NextFunction = () => { nextCalled = true; };
  const wasNextCalled = () => nextCalled;

  return { res, next, wasNextCalled };
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

/** Generates a chain of IPs for X-Forwarded-For (1 to 5 IPs) */
const xForwardedForChainArb = fc
  .array(ipv4Arb, { minLength: 1, maxLength: 5 })
  .map((ips) => ips.join(', '));

/** Generates per-endpoint rate limit config */
const endpointPatternArb = fc.constantFrom(
  '/api/v1/pdf-templates/preview-pdf',
  '/api/v1/pdf-templates/preview-html',
  '/api/v1/reports/generate',
  '/api/v1/custom-endpoint'
);

const endpointLimitArb = fc.integer({ min: 1, max: 20 });
const endpointWindowArb = fc.integer({ min: 10, max: 120 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 12: Real IP Extraction', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * For ANY X-Forwarded-For header value, extractClientIp extracts
   * the first IP in the chain (the real client IP).
   */

  it('extracts the first IP from any X-Forwarded-For chain', () => {
    fc.assert(
      fc.property(xForwardedForChainArb, (xForwardedFor) => {
        // Simulate a request with X-Forwarded-For header but no req.ip
        const mockReq = createMockReq({
          ip: undefined,
          headers: { 'x-forwarded-for': xForwardedFor },
        });

        const extractedIp = extractClientIp(mockReq);

        // The first IP in the comma-separated chain is the real client IP
        const expectedFirstIp = xForwardedFor.split(',')[0].trim();
        expect(extractedIp).toBe(expectedFirstIp);
      }),
      { numRuns: 200 }
    );
  });

  it('when req.ip is set (trust proxy enabled), uses req.ip directly', () => {
    fc.assert(
      fc.property(ipv4Arb, xForwardedForChainArb, (ip, xForwardedFor) => {
        // When trust proxy is enabled, Express sets req.ip
        const mockReq = createMockReq({
          ip,
          headers: { 'x-forwarded-for': xForwardedFor },
        });

        const extractedIp = extractClientIp(mockReq);

        // When req.ip exists, it should be used directly
        expect(extractedIp).toBe(ip);
      }),
      { numRuns: 100 }
    );
  });

  it('falls back to remoteAddress when no X-Forwarded-For and no req.ip', () => {
    fc.assert(
      fc.property(ipv4Arb, (remoteAddress) => {
        const mockReq = {
          ip: undefined,
          headers: {},
          socket: { remoteAddress },
          originalUrl: '/api/test',
          path: '/api/test',
        } as unknown as Request;

        const extractedIp = extractClientIp(mockReq);
        expect(extractedIp).toBe(remoteAddress);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 13: Per-Endpoint Rate Limits', () => {
  /**
   * **Validates: Requirements 8.3**
   *
   * For ANY request to a configured endpoint with custom limits,
   * the custom limit is applied instead of defaults.
   */

  beforeEach(() => {
    resetRateLimiterStore();
  });

  afterEach(() => {
    resetRateLimiterStore();
    stopRateLimiterCleanup();
  });

  it('custom per-endpoint limits override default limits', async () => {
    await fc.assert(
      fc.asyncProperty(
        endpointPatternArb,
        endpointLimitArb,
        endpointWindowArb,
        ipv4Arb,
        async (pattern, maxRequests, windowSeconds, clientIp) => {
          // Reset store before each property run
          resetRateLimiterStore();

          // Create a rate limiter with a custom endpoint limit
          const rateLimiter = createRateLimiter({
            authenticatedLimit: 100,
            unauthenticatedLimit: 50,
            windowSeconds: 60,
            endpointLimits: [{ pattern, maxRequests, windowSeconds }],
          });

          // Send requests up to the custom limit - all should pass (next() called)
          for (let i = 0; i < maxRequests; i++) {
            const req = createMockReq({
              ip: undefined,
              headers: { 'x-forwarded-for': clientIp },
              originalUrl: pattern,
            });
            const { res, next, wasNextCalled } = createMockRes();
            await rateLimiter(req, res, next);
            expect(wasNextCalled()).toBe(true);
          }

          // The next request should be rate limited (429)
          const req = createMockReq({
            ip: undefined,
            headers: { 'x-forwarded-for': clientIp },
            originalUrl: pattern,
          });
          const { res, next, wasNextCalled } = createMockRes();
          await rateLimiter(req, res, next);

          expect(wasNextCalled()).toBe(false);
          expect(res.getStatusCode()).toBe(429);
          // Verify the X-RateLimit-Limit header matches custom limit
          expect(res.getHeaders()['x-ratelimit-limit']).toBe(String(maxRequests));
        }
      ),
      { numRuns: 10 } // Reduced runs since each iteration makes multiple calls
    );
  });

  it('non-custom endpoints use the default limit', async () => {
    resetRateLimiterStore();

    const customLimit = 5;
    const defaultLimit = 50; // unauthenticated default

    const rateLimiter = createRateLimiter({
      authenticatedLimit: 100,
      unauthenticatedLimit: defaultLimit,
      windowSeconds: 60,
      endpointLimits: [
        { pattern: '/api/v1/pdf-templates/preview-pdf', maxRequests: customLimit, windowSeconds: 60 },
      ],
    });

    // Request to non-custom endpoint should show default limit in header
    const req = createMockReq({
      ip: undefined,
      headers: { 'x-forwarded-for': '10.0.0.2' },
      originalUrl: '/api/v1/regular-endpoint',
    });
    const { res, next, wasNextCalled } = createMockRes();
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
    expect(res.getHeaders()['x-ratelimit-limit']).toBe(String(defaultLimit));
  });
});

describe('Property 14: Rate Limit Exceeded Response', () => {
  /**
   * **Validates: Requirements 8.4**
   *
   * For ANY client that exceeds the rate limit, the response is
   * HTTP 429 with a positive Retry-After header value.
   */

  beforeEach(() => {
    resetRateLimiterStore();
  });

  afterEach(() => {
    resetRateLimiterStore();
    stopRateLimiterCleanup();
  });

  it('exceeded rate limit returns 429 with positive Retry-After header', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        ipv4Arb,
        async (limit, clientIp) => {
          // Reset store before each property run
          resetRateLimiterStore();

          const rateLimiter = createRateLimiter({
            authenticatedLimit: limit,
            unauthenticatedLimit: limit,
            windowSeconds: 60,
          });

          // Exhaust the rate limit
          for (let i = 0; i < limit; i++) {
            const req = createMockReq({
              ip: undefined,
              headers: { 'x-forwarded-for': clientIp },
            });
            const { res, next } = createMockRes();
            await rateLimiter(req, res, next);
          }

          // The next request should be rate limited
          const req = createMockReq({
            ip: undefined,
            headers: { 'x-forwarded-for': clientIp },
          });
          const { res, next, wasNextCalled } = createMockRes();
          await rateLimiter(req, res, next);

          // Must be 429
          expect(res.getStatusCode()).toBe(429);
          expect(wasNextCalled()).toBe(false);

          // Must include Retry-After header with a positive integer value
          const retryAfter = res.getHeaders()['retry-after'];
          expect(retryAfter).toBeDefined();
          const retryAfterValue = parseInt(retryAfter, 10);
          expect(retryAfterValue).toBeGreaterThan(0);

          // Must include proper error response body
          const body = res.getBody();
          expect(body.success).toBe(false);
          expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
        }
      ),
      { numRuns: 15 } // Reduced runs since each iteration makes multiple calls
    );
  });

  it('rate limit headers are present on all responses including 429', async () => {
    resetRateLimiterStore();

    const limit = 3;
    const rateLimiter = createRateLimiter({
      unauthenticatedLimit: limit,
      windowSeconds: 60,
    });

    // Send requests and verify headers on each
    for (let i = 0; i < limit; i++) {
      const req = createMockReq({
        ip: undefined,
        headers: { 'x-forwarded-for': '192.168.1.1' },
      });
      const { res, next } = createMockRes();
      await rateLimiter(req, res, next);

      expect(res.getHeaders()['x-ratelimit-limit']).toBe(String(limit));
      expect(res.getHeaders()['x-ratelimit-remaining']).toBe(String(limit - i - 1));
      expect(res.getHeaders()['x-ratelimit-reset']).toBeDefined();
    }

    // 429 response also has rate limit headers
    const req = createMockReq({
      ip: undefined,
      headers: { 'x-forwarded-for': '192.168.1.1' },
    });
    const { res, next } = createMockRes();
    await rateLimiter(req, res, next);

    expect(res.getStatusCode()).toBe(429);
    expect(res.getHeaders()['x-ratelimit-limit']).toBe(String(limit));
    expect(res.getHeaders()['x-ratelimit-remaining']).toBe('0');
    expect(res.getHeaders()['retry-after']).toBeDefined();
    expect(parseInt(res.getHeaders()['retry-after'], 10)).toBeGreaterThan(0);
  });
});

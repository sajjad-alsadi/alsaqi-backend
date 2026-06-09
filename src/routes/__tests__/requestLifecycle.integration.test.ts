// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { correlationIdMiddleware } from '../../middleware/correlationId';
import { createResponseWrapper } from '../../middleware/responseWrapper';
import { createRateLimiter, resetRateLimiterStore, stopRateLimiterCleanup } from '../../middleware/rateLimiter';
import { createRequestLogger } from '../../middleware/requestLogger';
import { validateBody } from '../../middleware/validate';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Integration Tests - Full Request Lifecycle
 *
 * Tests the complete middleware chain interaction:
 * Rate Limiter → Correlation ID → Response Wrapper → CSRF → Auth → Validation → Idempotency → Request Logger
 *
 * These tests verify middleware interactions, not individual middleware in isolation.
 * Requirements: All
 */

// Mock the database module used by request logger and idempotency
vi.mock('../../db/index', () => {
  const mockGet = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue([]);
  const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

  return {
    default: {
      prepare: vi.fn().mockReturnValue({
        get: mockGet,
        all: mockAll,
        run: mockRun,
      }),
      transaction: vi.fn(async (fn: Function) => fn()),
      validateIdentifier: vi.fn((name: string) => name),
      exec: vi.fn().mockResolvedValue(undefined),
    },
    db: {
      prepare: vi.fn().mockReturnValue({
        get: mockGet,
        all: mockAll,
        run: mockRun,
      }),
      transaction: vi.fn(async (fn: Function) => fn()),
      validateIdentifier: vi.fn((name: string) => name),
      exec: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock the logger to suppress output during tests
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  requestContext: {
    run: vi.fn((store: any, fn: Function) => fn()),
    getStore: vi.fn(() => ({})),
  },
}));

// Validation schema for test endpoint
const testBodySchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  description: z.string().optional(),
});

describe('Full Request Lifecycle Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimiterStore();

    app = createTestApp();
  });

  afterEach(() => {
    stopRateLimiterCleanup();
  });

  /**
   * Creates a test Express app with the full middleware chain wired in the correct order.
   * Simulates the real server.ts middleware setup.
   *
   * In the real server, the rate limiter runs before auth. The rate limiter checks
   * req.user to determine the key - if user is set (by a preceding auth middleware
   * on the route), it uses user ID; otherwise it falls back to IP.
   *
   * For testing per-user rate limiting, we place a lightweight user-extraction
   * middleware before the rate limiter (simulating how the real app's auth sets
   * req.user before the rate limiter can read it on subsequent middleware passes).
   */
  function createTestApp(options?: {
    rateLimitAuth?: number;
    rateLimitUnauth?: number;
    rateLimitWindow?: number;
  }) {
    const testApp = express();

    testApp.use(express.json());
    testApp.use(cookieParser());

    // Lightweight user extraction (sets req.user before rate limiter)
    // In the real app, the rate limiter reads req.user which may be set
    // by auth middleware on the same request cycle.
    testApp.use((req: any, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        if (token && token !== 'invalid-token') {
          req.user = {
            id: `user-${token}`,
            role: 'Admin',
            username: 'testuser',
            name: 'Test User',
            email: 'test@example.com',
          };
        }
      }
      next();
    });

    // 1. Rate Limiter (per-user sliding window)
    testApp.use(createRateLimiter({
      authenticatedLimit: options?.rateLimitAuth ?? 100,
      unauthenticatedLimit: options?.rateLimitUnauth ?? 50,
      windowSeconds: options?.rateLimitWindow ?? 60,
    }));

    // 2. Correlation ID Middleware for request tracing
    testApp.use(correlationIdMiddleware);

    // 3. Response Wrapper (unified envelope for all JSON responses)
    testApp.use(createResponseWrapper({ excludePaths: ['/health'] }));

    // 4. CSRF - skipped for API tests (exempt paths or GET requests)
    // In real app, CSRF is applied but we exempt test paths for simplicity

    // 5. Auth - mock authenticate middleware (full validation)
    const authenticate: express.RequestHandler = (req: any, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = authHeader.split(' ')[1];
      if (token === 'invalid-token') {
        return res.status(401).json({ error: 'Invalid token' });
      }
      // User already set by lightweight extraction above
      if (!req.user) {
        req.user = {
          id: `user-${token}`,
          role: 'Admin',
          username: 'testuser',
          name: 'Test User',
          email: 'test@example.com',
        };
      }
      next();
    };

    // 7. Idempotency - simplified in-memory implementation for testing
    const idempotencyStore = new Map<string, { status: number; body: any }>();
    const idempotencyMiddleware: express.RequestHandler = (req: any, res, next) => {
      if (req.method !== 'POST' && req.method !== 'PUT') return next();

      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      if (!idempotencyKey) return next();

      // Validate key length
      if (idempotencyKey.length === 0 || idempotencyKey.length > 256) {
        return res.status(400).json({
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'X-Idempotency-Key must be between 1 and 256 characters',
        });
      }

      const userId = req.user?.id;
      if (!userId) return next();

      const compositeKey = `${userId}:${idempotencyKey}`;

      // Check for stored response
      const stored = idempotencyStore.get(compositeKey);
      if (stored) {
        return res.status(stored.status).json(stored.body);
      }

      // Override res.json to capture and store the response
      const originalJson = res.json.bind(res);
      res.json = ((body: any) => {
        idempotencyStore.set(compositeKey, { status: res.statusCode, body });
        return originalJson(body);
      }) as any;

      next();
    };

    // 8. Request Logger
    testApp.use(createRequestLogger({ excludePaths: ['/health', '/uploads/*'] }));

    // ─── Routes ──────────────────────────────────────────────────────────────

    // Health check (excluded from response wrapper)
    testApp.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    // GET endpoint - authenticated, no validation needed
    testApp.get('/api/v1/items', authenticate, (req: any, res) => {
      res.json({
        data: [{ id: 1, title: 'Item 1' }, { id: 2, title: 'Item 2' }],
        pagination: {
          page: 1,
          pageSize: 20,
          total: 2,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    });

    // POST endpoint - authenticated + validated + idempotent
    testApp.post('/api/v1/items', authenticate, idempotencyMiddleware, validateBody(testBodySchema), (req: any, res) => {
      const item = { id: 99, ...req.body, createdBy: req.user.id };
      res.status(201).json(item);
    });

    // Endpoint that throws an error (for error flow testing)
    testApp.post('/api/v1/error-test', authenticate, validateBody(testBodySchema), (req: any, res) => {
      res.json({ created: true });
    });

    // Unauthenticated endpoint (for rate limiting testing)
    testApp.get('/api/v1/public', (req, res) => {
      res.json({ message: 'public data' });
    });

    // Error handler (must be last)
    testApp.use(globalErrorHandler);

    return testApp;
  }

  describe('Successful authenticated request → response envelope', () => {
    it('returns response wrapped in unified envelope with correct meta fields', async () => {
      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.requestId).toBeDefined();
      expect(res.body.meta.timestamp).toBeDefined();
      expect(res.body.meta.version).toBe('1.0.0');

      // Verify requestId is a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(res.body.meta.requestId).toMatch(uuidRegex);

      // Verify timestamp is valid ISO 8601
      expect(new Date(res.body.meta.timestamp).toISOString()).toBe(res.body.meta.timestamp);
    });

    it('moves pagination from body into meta.pagination', async () => {
      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123');

      expect(res.status).toBe(200);
      expect(res.body.meta.pagination).toBeDefined();
      expect(res.body.meta.pagination).toEqual({
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
      // Pagination should not be in data
      expect(res.body.data.pagination).toBeUndefined();
    });

    it('sets X-Request-Id and X-Response-Time response headers', async () => {
      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123');

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(res.headers['x-response-time']).toMatch(/^\d+ms$/);
    });

    it('uses provided X-Correlation-Id header as requestId when valid UUID', async () => {
      const correlationId = '12345678-1234-1234-1234-123456789abc';

      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Correlation-Id', correlationId);

      expect(res.body.meta.requestId).toBe(correlationId);
      expect(res.headers['x-request-id']).toBe(correlationId);
    });

    it('generates new UUID when X-Correlation-Id header is invalid', async () => {
      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Correlation-Id', 'not-a-valid-uuid');

      // Should generate a new valid UUID instead of using the invalid one
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(res.body.meta.requestId).toMatch(uuidRegex);
      expect(res.body.meta.requestId).not.toBe('not-a-valid-uuid');
    });

    it('includes rate limit headers in successful response', async () => {
      const res = await request(app)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123');

      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  describe('Error flow: invalid input → validation error → sanitized error response', () => {
    it('returns 400 with field-level validation errors in the envelope', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .send({ title: 'ab' }); // title too short (min 3 chars)

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeNull();
      expect(res.body.error).toBeDefined();

      // The validateBody middleware returns { success: false, error: { code, message, errors } }
      // The response wrapper wraps this as the error field in the envelope.
      // So the validation error details are nested inside res.body.error
      const errorPayload = res.body.error;
      // The error payload contains the validation error structure
      expect(errorPayload.error).toBeDefined();
      expect(errorPayload.error.code).toBe('VALIDATION_ERROR');
      expect(errorPayload.error.message).toBe('Validation failed');
      expect(errorPayload.error.errors).toBeDefined();
      expect(Array.isArray(errorPayload.error.errors)).toBe(true);
      expect(errorPayload.error.errors.length).toBeGreaterThan(0);

      // Verify field-level error structure
      const fieldError = errorPayload.error.errors[0];
      expect(fieldError.field).toBe('title');
      expect(fieldError.rule).toBeDefined();
      expect(fieldError.message).toBeDefined();
    });

    it('returns validation error wrapped in response envelope with meta', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .send({ title: '' }); // empty title

      expect(res.status).toBe(400);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.requestId).toBeDefined();
      expect(res.body.meta.timestamp).toBeDefined();
      expect(res.body.meta.version).toBe('1.0.0');
    });

    it('returns 401 when no auth token is provided', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .send({ title: 'Valid Title' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('strips unknown fields from request body before handler', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .send({
          title: 'Valid Title',
          description: 'A description',
          unknownField: 'should be stripped',
          anotherUnknown: 123,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Valid Title');
      expect(res.body.data.description).toBe('A description');
      expect(res.body.data.unknownField).toBeUndefined();
      expect(res.body.data.anotherUnknown).toBeUndefined();
    });
  });

  describe('Idempotency: duplicate POST → same response returned', () => {
    it('returns stored response on duplicate POST with same idempotency key', async () => {
      const idempotencyKey = 'unique-key-12345';

      // First request - should execute normally
      const res1 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Idempotency-Key', idempotencyKey)
        .send({ title: 'New Item' });

      expect(res1.status).toBe(201);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.title).toBe('New Item');
      expect(res1.body.data.id).toBe(99);

      // Second request with same key - should return stored response
      const res2 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Idempotency-Key', idempotencyKey)
        .send({ title: 'New Item' });

      expect(res2.status).toBe(201);
      expect(res2.body.success).toBe(true);
      expect(res2.body.data.title).toBe('New Item');
      expect(res2.body.data.id).toBe(99);
    });

    it('different idempotency keys produce independent responses', async () => {
      const res1 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Idempotency-Key', 'key-alpha')
        .send({ title: 'Item Alpha' });

      expect(res1.status).toBe(201);
      expect(res1.body.data.title).toBe('Item Alpha');

      const res2 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Idempotency-Key', 'key-beta')
        .send({ title: 'Item Beta' });

      expect(res2.status).toBe(201);
      expect(res2.body.data.title).toBe('Item Beta');
    });

    it('same idempotency key from different users produces independent responses', async () => {
      const sharedKey = 'shared-key-999';

      const res1 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer user-one')
        .set('X-Idempotency-Key', sharedKey)
        .send({ title: 'User One Item' });

      expect(res1.status).toBe(201);
      expect(res1.body.data.createdBy).toBe('user-user-one');

      const res2 = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer user-two')
        .set('X-Idempotency-Key', sharedKey)
        .send({ title: 'User Two Item' });

      expect(res2.status).toBe(201);
      expect(res2.body.data.createdBy).toBe('user-user-two');
    });

    it('rejects idempotency key exceeding 256 characters with 400', async () => {
      const longKey = 'x'.repeat(257);

      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', 'Bearer valid-token-123')
        .set('X-Idempotency-Key', longKey)
        .send({ title: 'Valid Title' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('Rate limiting: exceed limit → 429 response', () => {
    it('returns 429 when unauthenticated user exceeds rate limit', async () => {
      // Create app with very low rate limit for testing
      const limitedApp = createTestApp({
        rateLimitUnauth: 3,
        rateLimitWindow: 60,
      });

      // Send requests up to the limit
      for (let i = 0; i < 3; i++) {
        const res = await request(limitedApp).get('/api/v1/public');
        expect(res.status).toBe(200);
      }

      // Next request should be rate limited
      const res = await request(limitedApp).get('/api/v1/public');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(parseInt(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('returns 429 when authenticated user exceeds rate limit', async () => {
      // Create app with very low authenticated rate limit
      const limitedApp = createTestApp({
        rateLimitAuth: 3,
        rateLimitWindow: 60,
      });

      // Send requests up to the limit
      for (let i = 0; i < 3; i++) {
        const res = await request(limitedApp)
          .get('/api/v1/items')
          .set('Authorization', 'Bearer same-user-token');
        expect(res.status).toBe(200);
      }

      // Next request should be rate limited
      const res = await request(limitedApp)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer same-user-token');
      expect(res.status).toBe(429);
    });

    it('includes rate limit headers showing remaining quota', async () => {
      const limitedApp = createTestApp({
        rateLimitUnauth: 10,
        rateLimitWindow: 60,
      });

      const res = await request(limitedApp).get('/api/v1/public');

      expect(res.headers['x-ratelimit-limit']).toBe('10');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(parseInt(res.headers['x-ratelimit-remaining'])).toBeLessThan(10);
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('rate limits are per-user (one user exhausting limit does not affect another)', async () => {
      const limitedApp = createTestApp({
        rateLimitAuth: 2,
        rateLimitWindow: 60,
      });

      // User A exhausts their limit
      for (let i = 0; i < 2; i++) {
        await request(limitedApp)
          .get('/api/v1/items')
          .set('Authorization', 'Bearer user-a-token');
      }

      // User A is now rate limited
      const resA = await request(limitedApp)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer user-a-token');
      expect(resA.status).toBe(429);

      // User B should still have their full quota
      const resB = await request(limitedApp)
        .get('/api/v1/items')
        .set('Authorization', 'Bearer user-b-token');
      expect(resB.status).toBe(200);
    });

    it('429 response includes error message from rate limiter', async () => {
      const limitedApp = createTestApp({
        rateLimitUnauth: 1,
        rateLimitWindow: 60,
      });

      // Exhaust the limit
      await request(limitedApp).get('/api/v1/public');

      // This should be rate limited
      const res = await request(limitedApp).get('/api/v1/public');

      expect(res.status).toBe(429);
      // The rate limiter responds before the response wrapper middleware runs
      // (rate limiter is first in the chain), so the response is NOT wrapped
      // in the standard envelope. It contains the raw rate limiter error.
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('Too many requests');
    });
  });
});

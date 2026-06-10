// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 3: Graceful Redis Degradation
 *
 * For ANY request processed while Redis is unavailable (isAvailable = false),
 * the system must continue to authenticate users successfully by fetching
 * directly from the database, without throwing or returning an error due to
 * Redis being down. A warning must be logged when Redis operations fail.
 *
 * **Validates: Requirement 2.4**
 *
 * Strategy: We test two layers of graceful degradation:
 * 1. RedisManager operations (get/set/del) return null/false gracefully when unavailable
 * 2. Auth middleware's getCachedOrDb falls back to DB when Redis is unavailable,
 *    and the authenticate middleware never rejects due to Redis outage
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: (...args: any[]) => mockLoggerWarn(...args),
    info: (...args: any[]) => mockLoggerInfo(...args),
    error: (...args: any[]) => mockLoggerError(...args),
    debug: vi.fn(),
  },
}));

// Mock @alsaqi/shared to avoid tsconfig resolution issues
vi.mock('@alsaqi/shared', () => ({
  UserRole: {
    ADMIN: 'Admin',
    INTERNAL_AUDITOR: 'Internal Auditor',
    COMPLIANCE_OFFICER: 'Compliance Officer',
    RISK_OFFICER: 'Risk Officer',
    MANAGER: 'Manager',
    VIEWER: 'Viewer',
  },
}));

// Mock jsonwebtoken
const mockVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (...args: any[]) => mockVerify(...args),
    TokenExpiredError: class TokenExpiredError extends Error {
      constructor() { super('jwt expired'); this.name = 'TokenExpiredError'; }
    },
    JsonWebTokenError: class JsonWebTokenError extends Error {
      constructor() { super('jwt malformed'); this.name = 'JsonWebTokenError'; }
    },
  },
}));

// Mock express-rate-limit
vi.mock('express-rate-limit', () => ({
  rateLimit: () => (req: any, res: any, next: any) => next(),
}));

// Mock PermissionService
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn().mockResolvedValue(true),
  },
}));

// Mock ModuleRegistry
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn().mockReturnValue({ name: 'test' }),
  },
}));

// Mock the redisManager singleton used by auth middleware
const { mockRedisGet, mockRedisSet, mockRedisManagerInstance } = vi.hoisted(() => {
  const mockRedisGet = vi.fn();
  const mockRedisSet = vi.fn();
  const mockRedisManagerInstance = {
    isAvailable: false,
    get: mockRedisGet,
    set: mockRedisSet,
    getClient: () => null,
  };
  return { mockRedisGet, mockRedisSet, mockRedisManagerInstance };
});

vi.mock('../redisManager.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../redisManager.js')>();
  return {
    ...original,
    redisManager: mockRedisManagerInstance,
    default: mockRedisManagerInstance,
  };
});

import { RedisManager } from '../redisManager.js';
import { createAuthMiddlewares } from '../../middleware/auth.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates arbitrary user data that would be returned from a DB query.
 *  We fix requires_password_change to 0 since the password-change guard
 *  is unrelated to Redis degradation behavior. */
const arbUserData = () =>
  fc.record({
    id: fc.uuid(),
    role: fc.constantFrom('Admin', 'Internal Auditor', 'Manager', 'Viewer'),
    status: fc.constantFrom('Active'),
    username: fc.string({ minLength: 3, maxLength: 30 }).filter(s => /^[a-zA-Z0-9_]+$/.test(s)),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    email: fc.emailAddress(),
    session_version: fc.integer({ min: 1, max: 100 }),
    requires_password_change: fc.constant(0),
    department_id: fc.option(fc.uuid(), { nil: null }),
  });

/** Generates arbitrary cache keys */
const arbCacheKey = () =>
  fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);

/** Generates arbitrary cache values */
const arbCacheValue = () =>
  fc.string({ minLength: 1, maxLength: 500 });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 3: Graceful Redis Degradation', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
    mockVerify.mockReset();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    // Ensure redis is unavailable for auth tests
    mockRedisManagerInstance.isAvailable = false;
  });

  describe('RedisManager operations return gracefully when unavailable', () => {
    it('for ANY cache key, GET returns null when Redis is unavailable', async () => {
      await fc.assert(
        fc.asyncProperty(arbCacheKey(), async (key) => {
          // Create a RedisManager instance that's in disconnected state (no URL)
          const manager = new RedisManager({ url: '' });
          // Status is disconnected by default, isAvailable is false

          const result = await manager.get(key);

          // Must return null gracefully, never throw
          expect(result).toBeNull();
        }),
        { numRuns: 100 }
      );
    });

    it('for ANY key-value pair, SET returns false when Redis is unavailable', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbCacheKey(),
          arbCacheValue(),
          fc.integer({ min: 1, max: 3600 }),
          async (key, value, ttl) => {
            const manager = new RedisManager({ url: '' });

            const result = await manager.set(key, value, ttl);

            // Must return false gracefully, never throw
            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for ANY cache key, DEL returns false when Redis is unavailable', async () => {
      await fc.assert(
        fc.asyncProperty(arbCacheKey(), async (key) => {
          const manager = new RedisManager({ url: '' });

          const result = await manager.del(key);

          // Must return false gracefully, never throw
          expect(result).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('for ANY operation, ping returns false when Redis is unavailable', async () => {
      const manager = new RedisManager({ url: '' });

      const result = await manager.ping();

      expect(result).toBe(false);
    });
  });

  describe('Auth middleware authenticates successfully without Redis', () => {
    it('for ANY valid user, authenticate succeeds with DB fallback when Redis is unavailable', async () => {
      await fc.assert(
        fc.asyncProperty(arbUserData(), async (userData) => {
          mockLoggerWarn.mockClear();
          mockVerify.mockReset();

          // Mock JWT verification to return valid token data
          mockVerify.mockReturnValue({
            id: userData.id,
            session_version: userData.session_version,
          });

          // Mock DB that returns the user
          const mockDb = {
            prepare: () => ({
              get: vi.fn().mockResolvedValue(userData),
            }),
          };

          // Redis is unavailable (set in beforeEach)
          mockRedisManagerInstance.isAvailable = false;

          const { authenticate } = createAuthMiddlewares(
            mockDb,
            'test-secret',
            'test-public-key'
          );

          // Create mock request with token
          const req: any = {
            cookies: { token: 'valid-jwt-token' },
            headers: {},
            originalUrl: '/api/v1/users',
          };
          const res: any = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
          };
          const next = vi.fn();

          await authenticate(req, res, next);

          // Auth must succeed: next() called, no error response
          expect(next).toHaveBeenCalled();
          expect(res.status).not.toHaveBeenCalled();

          // User data must be populated on req.user
          expect(req.user).toBeDefined();
          expect(req.user.id).toBe(userData.id);
        }),
        { numRuns: 50 }
      );
    }, 30_000);
  });

  describe('Warnings are logged during Redis degradation', () => {
    it('for ANY Redis operation that encounters an error, a warning is logged', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbCacheKey(),
          arbCacheValue(),
          fc.constantFrom('get', 'set', 'del') as fc.Arbitrary<'get' | 'set' | 'del'>,
          async (key, value, operation) => {
            mockLoggerWarn.mockClear();

            // Create a manager and force it into a connected state with a broken client
            const manager = new RedisManager({ url: 'redis://localhost:6379' });

            const mockClient = {
              get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
              set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
              del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            };

            // Simulate connected state with broken client
            (manager as any)._status = 'connected';
            (manager as any).client = mockClient;

            let result: any;
            switch (operation) {
              case 'get':
                result = await manager.get(key);
                expect(result).toBeNull();
                break;
              case 'set':
                result = await manager.set(key, value, 300);
                expect(result).toBe(false);
                break;
              case 'del':
                result = await manager.del(key);
                expect(result).toBe(false);
                break;
            }

            // A warning must be logged about the Redis failure
            expect(mockLoggerWarn).toHaveBeenCalled();
            const warnMessage = mockLoggerWarn.mock.calls[0][0];
            expect(warnMessage).toContain('[Redis]');
            expect(warnMessage).toContain(operation.toUpperCase());
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Auth middleware never throws due to Redis being down', () => {
    it('for ANY request scenario during Redis outage, authenticate does not throw', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbUserData(),
          // Whether the token comes from cookie or bearer header
          fc.boolean(),
          async (userData, useBearerHeader) => {
            mockVerify.mockReset();
            mockLoggerWarn.mockClear();

            mockVerify.mockReturnValue({
              id: userData.id,
              session_version: userData.session_version,
            });

            const mockDb = {
              prepare: () => ({
                get: vi.fn().mockResolvedValue(userData),
              }),
            };

            // Redis is unavailable
            mockRedisManagerInstance.isAvailable = false;

            const { authenticate } = createAuthMiddlewares(
              mockDb,
              'test-secret',
              'test-public-key'
            );

            const req: any = {
              cookies: useBearerHeader ? {} : { token: 'valid-jwt-token' },
              headers: useBearerHeader
                ? { authorization: 'Bearer valid-jwt-token' }
                : {},
              originalUrl: '/api/v1/data',
            };
            const res: any = {
              status: vi.fn().mockReturnThis(),
              json: vi.fn().mockReturnThis(),
            };
            const next = vi.fn();

            // Must never throw, regardless of Redis state
            await expect(
              authenticate(req, res, next)
            ).resolves.not.toThrow();

            // Auth succeeds: next() called
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 50 }
      );
    }, 30_000);
  });
});

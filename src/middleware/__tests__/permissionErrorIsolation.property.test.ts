// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

/**
 * Property Test: Permission Service Error Isolation (Property 19)
 *
 * **Validates: Requirements 17.3**
 *
 * For any internal error thrown by the PermissionService during a permission check,
 * the checkPermission middleware SHALL respond with HTTP 500 without including
 * the internal error message, stack trace, or service name in the response body.
 */

// Mock jsonwebtoken to control token verification
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
    TokenExpiredError: class TokenExpiredError extends Error {
      constructor() {
        super('jwt expired');
        this.name = 'TokenExpiredError';
      }
    },
    JsonWebTokenError: class JsonWebTokenError extends Error {
      constructor() {
        super('invalid token');
        this.name = 'JsonWebTokenError';
      }
    },
  },
}));

// Mock the Redis manager to avoid real Redis dependency
vi.mock('../../cache/redisManager.js', () => ({
  redisManager: {
    isAvailable: false,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(false),
    getClient: vi.fn().mockReturnValue(null),
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock PermissionService - will be controlled per test
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn(),
  },
}));

// Mock ModuleRegistry to always return a valid module
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn().mockReturnValue({ name: 'TestModule', actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'] }),
  },
}));

import jwt from 'jsonwebtoken';
import { PermissionService } from '../../services/PermissionService';
import { createAuthMiddlewares } from '../auth';

describe('Property 19: Permission Service Error Isolation', () => {
  // Arbitraries for generating diverse internal error messages
  const internalErrorMessageArb = fc.oneof(
    // Database-related errors
    fc.constantFrom(
      'ECONNREFUSED 127.0.0.1:5432',
      'connection to server at "postgres" (172.18.0.2), port 5432 failed',
      'FATAL: password authentication failed for user "alsaqi"',
      'relation "permissions" does not exist',
      'ERROR: canceling statement due to statement timeout',
      'too many clients already',
      'SSL connection has been closed unexpectedly',
      'could not serialize access due to concurrent update'
    ),
    // Generic internal errors
    fc.constantFrom(
      'Cannot read properties of undefined (reading \'role_id\')',
      'PermissionService.resolvePermission failed',
      'TypeError: Cannot destructure property \'is_allowed\' of undefined',
      'Redis timeout after 5000ms',
      'PermissionCache.get threw: ENOMEM',
      'Internal service error in PermissionService',
      'SQLITE_ERROR: no such table: user_permissions'
    ),
    // Random strings that could be internal error messages
    fc.string({ minLength: 1, maxLength: 200 }),
    // Strings containing file paths
    fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ minLength: 1, maxLength: 20 })).map(
      ([a, b]) => `Error at /app/src/services/${a}.ts:${b}`
    ),
    // Strings containing stack traces
    fc.string({ minLength: 1, maxLength: 50 }).map(
      (s) => `at PermissionService.hasPermission (/app/src/services/PermissionService.ts:42:11)\n    at async ${s}`
    )
  );

  // Service names that should never appear in response
  const serviceNames = [
    'PermissionService',
    'PermissionCache',
    'ModuleRegistry',
    'RedisManager',
    'redisManager',
  ];

  // Non-Admin roles (Admin bypasses permission check)
  const nonAdminRoleArb = fc.constantFrom('Auditor', 'Manager', 'Viewer', 'User');
  const userIdArb = fc.uuid();
  const sessionVersionArb = fc.integer({ min: 1, max: 1000 });

  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(userRecord: any) {
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(userRecord),
      }),
    };

    const { authenticate, checkPermission } = createAuthMiddlewares(
      mockDb,
      'test-jwt-secret-that-is-long-enough-for-validation-purposes-64chars!',
      'test-public-key'
    );

    const app = express();
    app.use(cookieParser());
    app.use(authenticate);
    app.use(checkPermission('TestModule', 'View'));

    // A handler that should never be reached when PermissionService throws
    app.get('/api/test', (_req: any, res: any) => {
      res.json({ success: true });
    });
    app.post('/api/test', (_req: any, res: any) => {
      res.json({ success: true });
    });

    return app;
  }

  it('responds with 500 and does NOT expose internal error message in response body', async () => {
    await fc.assert(
      fc.asyncProperty(
        internalErrorMessageArb,
        nonAdminRoleArb,
        userIdArb,
        sessionVersionArb,
        async (errorMessage, role, userId, sessionVersion) => {
          // Configure PermissionService to throw with the generated error message
          (PermissionService.hasPermission as any).mockRejectedValue(new Error(errorMessage));

          // Mock JWT verify to return a decoded token
          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status: 'Active',
            username: 'testuser',
            name: 'Test User',
            email: 'test@test.com',
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await request(app)
            .get('/api/test')
            .set('Cookie', 'token=valid-jwt-token');

          // Must respond with 500
          expect(res.status).toBe(500);

          // Response body as string for searching
          const responseBodyStr = JSON.stringify(res.body);

          // The internal error message must NOT appear in the response body
          // (Only check for non-trivial messages to avoid false positives with very short strings)
          if (errorMessage.length > 5) {
            expect(responseBodyStr).not.toContain(errorMessage);
          }

          // Stack trace patterns must NOT appear
          expect(responseBodyStr).not.toMatch(/at\s+\S+\s+\(/);
          expect(responseBodyStr).not.toMatch(/\/app\/src\//);
          expect(responseBodyStr).not.toMatch(/\.ts:\d+:\d+/);

          // Service names must NOT appear
          for (const serviceName of serviceNames) {
            expect(responseBodyStr).not.toContain(serviceName);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('responds with 500 and does NOT expose stack traces when Error has a stack', async () => {
    await fc.assert(
      fc.asyncProperty(
        internalErrorMessageArb,
        nonAdminRoleArb,
        userIdArb,
        sessionVersionArb,
        async (errorMessage, role, userId, sessionVersion) => {
          // Create an error with a realistic stack trace
          const error = new Error(errorMessage);
          error.stack = `Error: ${errorMessage}\n    at PermissionService.hasPermission (/app/src/services/PermissionService.ts:42:11)\n    at async checkPermission (/app/src/middleware/auth.ts:180:25)\n    at async Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)`;

          (PermissionService.hasPermission as any).mockRejectedValue(error);

          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status: 'Active',
            username: 'testuser',
            name: 'Test User',
            email: 'test@test.com',
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await request(app)
            .get('/api/test')
            .set('Cookie', 'token=valid-jwt-token');

          // Must respond with 500
          expect(res.status).toBe(500);

          const responseBodyStr = JSON.stringify(res.body);

          // Stack trace must NOT appear in response
          expect(responseBodyStr).not.toContain('PermissionService.hasPermission');
          expect(responseBodyStr).not.toContain('/app/src/services/');
          expect(responseBodyStr).not.toContain('/app/src/middleware/');
          expect(responseBodyStr).not.toContain('/app/node_modules/');
          expect(responseBodyStr).not.toMatch(/\.ts:\d+:\d+/);
          expect(responseBodyStr).not.toMatch(/\.js:\d+:\d+/);

          // Service names must NOT appear
          for (const serviceName of serviceNames) {
            expect(responseBodyStr).not.toContain(serviceName);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a generic error message regardless of internal error type', async () => {
    // Test various error types (not just Error instances)
    const errorTypeArb = fc.oneof(
      internalErrorMessageArb.map((msg) => new Error(msg)),
      internalErrorMessageArb.map((msg) => new TypeError(msg)),
      internalErrorMessageArb.map((msg) => new RangeError(msg)),
      fc.constantFrom(
        { code: 'ECONNREFUSED', message: 'Connection refused' },
        'raw string error',
        null,
        undefined
      )
    );

    await fc.assert(
      fc.asyncProperty(
        errorTypeArb,
        nonAdminRoleArb,
        userIdArb,
        sessionVersionArb,
        async (errorValue, role, userId, sessionVersion) => {
          (PermissionService.hasPermission as any).mockRejectedValue(errorValue);

          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status: 'Active',
            username: 'testuser',
            name: 'Test User',
            email: 'test@test.com',
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await request(app)
            .get('/api/test')
            .set('Cookie', 'token=valid-jwt-token');

          // Must always respond with 500
          expect(res.status).toBe(500);

          // Response must contain a generic error message
          expect(res.body).toHaveProperty('error');
          expect(typeof res.body.error).toBe('string');
          expect(res.body.error.length).toBeGreaterThan(0);

          // The error field should NOT contain service internals
          const responseBodyStr = JSON.stringify(res.body);
          for (const serviceName of serviceNames) {
            expect(responseBodyStr).not.toContain(serviceName);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

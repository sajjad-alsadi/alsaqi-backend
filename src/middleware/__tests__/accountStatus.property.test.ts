// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

/**
 * Property Test: Account Status Enforcement (Property 5)
 *
 * **Validates: Requirements 1.6**
 *
 * For any user with status in {Suspended, Disabled, Archived}, all
 * authenticated requests SHALL be rejected with HTTP 403, regardless
 * of role or permissions.
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

// Mock PermissionService
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn().mockResolvedValue(true),
  },
}));

// Mock ModuleRegistry
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn().mockReturnValue({ name: 'test', actions: ['read', 'write'] }),
  },
}));

import jwt from 'jsonwebtoken';
import { createAuthMiddlewares } from '../auth';

describe('Property 5: Account Status Enforcement', () => {
  // Forbidden statuses that should always result in 403
  const forbiddenStatuses = ['Suspended', 'Disabled', 'Archived'] as const;

  // Active statuses that should be allowed through
  const activeStatuses = ['Active'] as const;

  // Roles that exist in the system
  const roles = ['Admin', 'Auditor', 'Manager', 'Viewer', 'User'] as const;

  // HTTP methods to test
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch'] as const;

  // Arbitraries
  const forbiddenStatusArb = fc.constantFrom(...forbiddenStatuses);
  const roleArb = fc.constantFrom(...roles);
  const httpMethodArb = fc.constantFrom(...httpMethods);
  const userIdArb = fc.uuid();
  const sessionVersionArb = fc.integer({ min: 1, max: 1000 });
  const usernameArb = fc.stringMatching(/^[a-z]{3,12}$/);
  const emailArb = fc.emailAddress();
  const nameArb = fc.stringMatching(/^[A-Z][a-z]{2,10} [A-Z][a-z]{2,10}$/);

  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(userRecord: any) {
    // Create a mock DB that returns the given user record
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(userRecord),
      }),
    };

    const { authenticate } = createAuthMiddlewares(
      mockDb,
      'test-jwt-secret-that-is-long-enough-for-validation-purposes-64chars!',
      'test-public-key'
    );

    const app = express();
    app.use(cookieParser());
    app.use(authenticate);

    // Register routes for all methods
    const handler = (_req: any, res: any) => {
      res.json({ success: true });
    };
    app.get('/api/test', handler);
    app.post('/api/test', handler);
    app.put('/api/test', handler);
    app.delete('/api/test', handler);
    app.patch('/api/test', handler);

    return app;
  }

  it('rejects all requests with 403 for users with Suspended, Disabled, or Archived status', async () => {
    await fc.assert(
      fc.asyncProperty(
        forbiddenStatusArb,
        roleArb,
        httpMethodArb,
        userIdArb,
        sessionVersionArb,
        usernameArb,
        emailArb,
        nameArb,
        async (status, role, method, userId, sessionVersion, username, email, name) => {
          // Mock JWT verify to return a decoded token
          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status,
            username,
            name,
            email,
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await (request(app) as any)[method]('/api/test')
            .set('Cookie', 'token=valid-jwt-token')
            .send({});

          // All requests for users with forbidden status must get 403
          expect(res.status).toBe(403);
          expect(res.body.error).toContain('suspended');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('allows requests through for users with Active status (control test)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...activeStatuses),
        roleArb,
        httpMethodArb,
        userIdArb,
        sessionVersionArb,
        usernameArb,
        emailArb,
        nameArb,
        async (status, role, method, userId, sessionVersion, username, email, name) => {
          // Mock JWT verify to return a decoded token
          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status,
            username,
            name,
            email,
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await (request(app) as any)[method]('/api/test')
            .set('Cookie', 'token=valid-jwt-token')
            .send({});

          // Active users should NOT get 403 for account status
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('rejects regardless of HTTP method for all forbidden statuses', async () => {
    // This tests the full cross-product: every method × every forbidden status
    await fc.assert(
      fc.asyncProperty(
        forbiddenStatusArb,
        httpMethodArb,
        userIdArb,
        sessionVersionArb,
        async (status, method, userId, sessionVersion) => {
          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role: 'Admin', // Even Admin role should be rejected
            status,
            username: 'testuser',
            name: 'Test User',
            email: 'test@test.com',
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord);

          const res = await (request(app) as any)[method]('/api/test')
            .set('Cookie', 'token=valid-jwt-token')
            .send({});

          expect(res.status).toBe(403);
        }
      ),
      { numRuns: 100 }
    );
  });
});

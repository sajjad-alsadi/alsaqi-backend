// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

/**
 * Property 18: Permission Denial Response Structure
 *
 * **Validates: Requirements 17.1, 17.2**
 *
 * For any non-Admin user lacking the required permission for a module+action pair,
 * the checkPermission middleware SHALL respond with HTTP 403 and include the
 * `module` and `action` fields in the response body.
 *
 * Strategy:
 * - Generate non-Admin users (various roles) with valid module+action combinations
 * - Mock PermissionService.hasPermission to return false (permission denied)
 * - Verify the response is HTTP 403 with `module` and `action` fields in the body
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

// Mock PermissionService - deny all permissions for our tests
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn().mockResolvedValue(false),
  },
}));

// Mock ModuleRegistry - pretend all modules are registered with all actions
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn().mockImplementation((name: string) => ({
      name,
      actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
      label: { en: name, ar: name },
      defaults: {},
    })),
  },
}));

import jwt from 'jsonwebtoken';
import { createAuthMiddlewares } from '../auth';

describe('Property 18: Permission Denial Response Structure', () => {
  // Non-Admin roles that should go through the permission check
  const nonAdminRoles = [
    'Internal Auditor',
    'Compliance Officer',
    'Risk Officer',
    'Manager',
    'Viewer',
  ] as const;

  // Valid PermissionAction values
  const permissionActions = ['View', 'Create', 'Edit', 'Delete', 'Approve'] as const;

  // PascalCase module names (matching the registry pattern)
  const moduleNames = [
    'AuditPlans',
    'Findings',
    'Recommendations',
    'RiskRegister',
    'Correspondence',
    'Tasks',
    'Users',
    'Departments',
    'Reports',
    'Settings',
  ] as const;

  // Arbitraries
  const nonAdminRoleArb = fc.constantFrom(...nonAdminRoles);
  const permissionActionArb = fc.constantFrom(...permissionActions);
  const moduleNameArb = fc.constantFrom(...moduleNames);
  const userIdArb = fc.uuid();
  const sessionVersionArb = fc.integer({ min: 1, max: 1000 });
  const usernameArb = fc.stringMatching(/^[a-z]{3,12}$/);
  const emailArb = fc.emailAddress();
  const nameArb = fc.stringMatching(/^[A-Z][a-z]{2,10} [A-Z][a-z]{2,10}$/);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(
    userRecord: any,
    module: string,
    action: string
  ) {
    const mockDb = {
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
    app.use(checkPermission(module, action as any));

    app.get('/api/test', (_req: any, res: any) => {
      res.json({ success: true });
    });
    app.post('/api/test', (_req: any, res: any) => {
      res.json({ success: true });
    });

    return app;
  }

  it('responds with HTTP 403 and includes module and action fields for any non-Admin user without permission', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        moduleNameArb,
        permissionActionArb,
        userIdArb,
        sessionVersionArb,
        usernameArb,
        emailArb,
        nameArb,
        async (role, module, action, userId, sessionVersion, username, email, name) => {
          // Mock JWT verify to return a decoded token
          (jwt.verify as any).mockReturnValue({
            id: userId,
            session_version: sessionVersion,
          });

          const userRecord = {
            id: userId,
            role,
            status: 'Active',
            username,
            name,
            email,
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          };

          const app = createTestApp(userRecord, module, action);

          const res = await request(app)
            .get('/api/test')
            .set('Cookie', 'token=valid-jwt-token');

          // MUST respond with HTTP 403
          expect(res.status).toBe(403);

          // MUST include `module` field matching the requested module
          expect(res.body).toHaveProperty('module');
          expect(res.body.module).toBe(module);

          // MUST include `action` field matching the requested action
          expect(res.body).toHaveProperty('action');
          expect(res.body.action).toBe(action);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('includes PERMISSION_DENIED error code in the 403 response', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminRoleArb,
        moduleNameArb,
        permissionActionArb,
        userIdArb,
        sessionVersionArb,
        async (role, module, action, userId, sessionVersion) => {
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

          const app = createTestApp(userRecord, module, action);

          const res = await request(app)
            .get('/api/test')
            .set('Cookie', 'token=valid-jwt-token');

          expect(res.status).toBe(403);
          expect(res.body).toHaveProperty('code', 'PERMISSION_DENIED');
          expect(res.body).toHaveProperty('module', module);
          expect(res.body).toHaveProperty('action', action);
        }
      ),
      { numRuns: 100 }
    );
  });
});

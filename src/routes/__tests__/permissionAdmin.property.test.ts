// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';

/**
 * Property Tests for Permission Admin API
 *
 * Property 14: Custom Role Lifecycle Safety
 * Property 15: Role Name Validation
 * Property 16: Permission Matrix Update with Cache Invalidation
 * Property 18: Override Validation
 *
 * **Validates: Requirements 7.2, 7.3, 7.5, 7.6, 7.7, 7.8, 8.2, 9.2, 9.3**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the database module (for audit logging that uses module-level db import)
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
  });
  return {
    db: { prepare: mockPrepare, transaction: vi.fn(async (fn: any) => fn()) },
    default: { prepare: mockPrepare, transaction: vi.fn(async (fn: any) => fn()) },
  };
});

// Mock PermissionService
const updateRolePermissionsMock = vi.fn();
const invalidateCacheMock = vi.fn();
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    updateRolePermissions: (...args: any[]) => updateRolePermissionsMock(...args),
    invalidateCache: (...args: any[]) => invalidateCacheMock(...args),
    getRolePermissions: vi.fn().mockResolvedValue({ permissions: {} }),
    getUserPermissions: vi.fn().mockResolvedValue({
      userId: '', role: '', roleId: '', isCustomRole: false,
      permissions: {}, overrides: [],
    }),
  },
}));

// Mock ModuleRegistry
const getModuleMock = vi.fn();
const getAllModulesMock = vi.fn().mockReturnValue([]);
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: (...args: any[]) => getModuleMock(...args),
    getAllModules: (...args: any[]) => getAllModulesMock(...args),
    getModuleNames: vi.fn().mockReturnValue([]),
  },
}));

import { createPermissionAdminRoutes } from '../permissionAdmin';
import { PermissionAction } from '../../permissions/types';

// ─── Custom Arbitraries ──────────────────────────────────────────────────────

/** Generates a valid role name (2-100 printable ASCII chars) */
const validRoleNameArb = fc
  .string({ minLength: 2, maxLength: 100 })
  .filter(s => s.trim().length >= 2 && /^[\x20-\x7E]+$/.test(s));

/** Generates a valid UUID */
const uuidArb = fc.uuid();

/** Generates a valid module name from a realistic set */
const moduleNameArb = fc.constantFrom(
  'Dashboard', 'AuditCharter', 'AuditPlans', 'AuditFindings',
  'Policies', 'RiskRegister', 'Analytics', 'Compliance',
  'Correspondence', 'Fraud', 'Integrity', 'Recommendations',
  'Regulatory', 'UserManagement', 'Settings'
);

/** Generates a valid permission action */
const validActionArb = fc.constantFrom(
  'View', 'Create', 'Edit', 'Delete', 'Approve'
) as fc.Arbitrary<PermissionAction>;

/** Generates an invalid action not in the supported set */
const invalidActionArb = fc.constantFrom(
  'Read', 'Write', 'Execute', 'Manage', 'Admin', 'Update', 'Remove'
);

/** Generates a number of assigned users (0 or more) */
const assignedUsersCountArb = fc.nat({ max: 10 });

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Creates a test Express app with the permission admin router mounted.
 * Uses a mock db object that can be configured per test.
 */
function createTestApp(mockDb: any) {
  const app = express();
  app.use(express.json());

  const mockAuthenticate = (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-user-id', role: 'Admin' };
    next();
  };
  const mockCheckPermission = () => (_req: any, _res: any, next: any) => next();
  const mockLogError = vi.fn();

  const router = createPermissionAdminRoutes(
    mockDb,
    mockAuthenticate,
    mockCheckPermission,
    mockLogError
  );

  app.use(router);
  return app;
}

/**
 * Creates a mock DB object with configurable prepare responses.
 */
function createMockDb(handlers: Record<string, any> = {}) {
  const prepareFn = vi.fn().mockImplementation((sql: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (sql.includes(pattern)) {
        return handler;
      }
    }
    return {
      get: vi.fn().mockResolvedValue(undefined),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    };
  });

  const transactionFn = vi.fn().mockImplementation(async (fn: any) => fn());

  return { prepare: prepareFn, transaction: transactionFn };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 14: Custom Role Lifecycle Safety', () => {
  /**
   * Deletion succeeds only with zero assigned users;
   * built-in roles cannot be deleted or modified.
   *
   * **Validates: Requirements 7.5, 7.6, 7.7, 7.8**
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletion of a custom role succeeds only when zero users are assigned', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        assignedUsersCountArb,
        async (roleId, assignedCount) => {
          const users = Array.from({ length: assignedCount }, (_, i) => ({
            id: `user-${i}`,
          }));

          const mockDb = createMockDb({
            'SELECT id, name': {
              get: vi.fn().mockResolvedValue({
                id: roleId, name: 'TestCustomRole', is_custom: true,
              }),
            },
            'SELECT id FROM users WHERE role_id': {
              all: vi.fn().mockResolvedValue(users),
            },
            'SELECT COUNT': {
              get: vi.fn().mockResolvedValue({ total: assignedCount }),
            },
            'DELETE FROM role_permissions': {
              run: vi.fn().mockResolvedValue(undefined),
            },
            'DELETE FROM roles': {
              run: vi.fn().mockResolvedValue(undefined),
            },
            'permission_audit_logs': {
              get: vi.fn().mockResolvedValue({ id: 'log-id' }),
              run: vi.fn().mockResolvedValue(undefined),
            },
          });

          const app = createTestApp(mockDb);
          const res = await request(app).delete(`/roles/${roleId}`);

          if (assignedCount === 0) {
            expect(res.status).toBe(200);
          } else {
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CONFLICT');
            expect(res.body.affectedUserIds).toBeDefined();
          }
        }
      ),
      { numRuns: 50 }
    );
  }, 60000);

  it('built-in roles cannot be deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.constantFrom(
          'Admin', 'Manager', 'Internal Auditor',
          'Compliance Officer', 'Risk Officer', 'Viewer'
        ),
        async (roleId, roleName) => {
          const mockDb = createMockDb({
            'SELECT id, name': {
              get: vi.fn().mockResolvedValue({
                id: roleId, name: roleName, is_custom: false,
              }),
            },
          });

          const app = createTestApp(mockDb);
          const res = await request(app).delete(`/roles/${roleId}`);

          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      ),
      { numRuns: 30 }
    );
  }, 60000);

  it('built-in roles cannot be modified (PUT returns 403)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.constantFrom(
          'Admin', 'Manager', 'Internal Auditor',
          'Compliance Officer', 'Risk Officer', 'Viewer'
        ),
        validRoleNameArb,
        async (roleId, roleName, newName) => {
          const mockDb = createMockDb({
            'SELECT id, name, description, is_custom, created_at FROM roles': {
              get: vi.fn().mockResolvedValue({
                id: roleId, name: roleName, description: '',
                is_custom: false, created_at: new Date().toISOString(),
              }),
            },
          });

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/roles/${roleId}`)
            .send({ name: newName });

          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      ),
      { numRuns: 30 }
    );
  }, 60000);
});


describe('Property 15: Role Name Validation', () => {
  /**
   * Name accepted iff 2-100 chars and no case-insensitive conflict.
   *
   * **Validates: Requirements 7.2, 7.3**
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('role creation succeeds when name is 2-100 chars and no conflict', async () => {
    await fc.assert(
      fc.asyncProperty(validRoleNameArb, async (name) => {
        const mockDb = createMockDb({
          'LOWER(name) = LOWER': {
            get: vi.fn().mockResolvedValue(undefined), // No conflict
          },
          'INSERT INTO roles': {
            get: vi.fn().mockResolvedValue({
              id: 'new-role-id', name, description: '',
              is_custom: true, created_at: new Date().toISOString(),
            }),
          },
          'permission_audit_logs': {
            get: vi.fn().mockResolvedValue({ id: 'log-id' }),
            run: vi.fn().mockResolvedValue(undefined),
          },
        });

        const app = createTestApp(mockDb);
        const res = await request(app)
          .post('/roles')
          .send({ name, description: '' });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe(name);
        expect(res.body.isCustom).toBe(true);
      }),
      { numRuns: 50 }
    );
  }, 60000);

  it('role creation fails with 400 when name is too short or too long', async () => {
    const invalidNames = ['', 'a', ' ', 'A'.repeat(101)];

    for (const name of invalidNames) {
      const mockDb = createMockDb({});
      const app = createTestApp(mockDb);
      const res = await request(app)
        .post('/roles')
        .send({ name, description: '' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  }, 30000);

  it('role creation fails with 409 when name conflicts case-insensitively', async () => {
    await fc.assert(
      fc.asyncProperty(validRoleNameArb, uuidArb, async (name, existingId) => {
        const mockDb = createMockDb({
          'LOWER(name) = LOWER': {
            get: vi.fn().mockResolvedValue({ id: existingId }), // Conflict!
          },
        });

        const app = createTestApp(mockDb);
        const res = await request(app)
          .post('/roles')
          .send({ name, description: '' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CONFLICT');
      }),
      { numRuns: 50 }
    );
  }, 60000);
});


describe('Property 16: Permission Matrix Update with Cache Invalidation', () => {
  /**
   * Update persists and invalidates cache for all affected users.
   *
   * **Validates: Requirements 8.2**
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('permission matrix update on custom role calls updateRolePermissions', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.array(
          fc.record({
            module: moduleNameArb,
            action: validActionArb,
            granted: fc.boolean(),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (roleId, permissions) => {
          vi.clearAllMocks();

          const mockDb = createMockDb({
            'SELECT id, name': {
              get: vi.fn().mockResolvedValue({
                id: roleId, name: 'CustomRole', is_custom: true,
              }),
            },
            'permission_audit_logs': {
              get: vi.fn().mockResolvedValue({ id: 'log-id' }),
              run: vi.fn().mockResolvedValue(undefined),
            },
          });

          // All modules are registered with all actions
          getModuleMock.mockImplementation((name: string) => ({
            name,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: name, ar: name },
            defaults: {},
          }));

          updateRolePermissionsMock.mockResolvedValue(undefined);

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/roles/${roleId}/permissions`)
            .send({ permissions });

          expect(res.status).toBe(200);
          expect(res.body.message).toContain('updated successfully');
          expect(res.body.roleId).toBe(roleId);
          expect(updateRolePermissionsMock).toHaveBeenCalledWith(
            roleId, permissions
          );
        }
      ),
      { numRuns: 50 }
    );
  }, 60000);

  it('permission matrix update on built-in role is rejected with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.constantFrom(
          'Admin', 'Manager', 'Internal Auditor',
          'Compliance Officer', 'Risk Officer', 'Viewer'
        ),
        async (roleId, roleName) => {
          vi.clearAllMocks();

          const mockDb = createMockDb({
            'SELECT id, name': {
              get: vi.fn().mockResolvedValue({
                id: roleId, name: roleName, is_custom: false,
              }),
            },
          });

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/roles/${roleId}/permissions`)
            .send({ permissions: [{ module: 'Dashboard', action: 'View', granted: true }] });

          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
          expect(updateRolePermissionsMock).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 30 }
    );
  }, 60000);
});


describe('Property 18: Override Validation', () => {
  /**
   * Override accepted iff action is in module's supported actions.
   *
   * **Validates: Requirements 9.2, 9.3**
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('override is accepted when action is in the module supported actions', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.array(
          fc.record({
            module: moduleNameArb,
            action: validActionArb,
            isAllowed: fc.boolean(),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (userId, overrides) => {
          vi.clearAllMocks();

          const mockDb = createMockDb({
            'SELECT id FROM users WHERE id': {
              get: vi.fn().mockResolvedValue({ id: userId }),
            },
            'DELETE FROM user_permissions': {
              run: vi.fn().mockResolvedValue(undefined),
            },
            'SELECT id FROM permissions WHERE module': {
              get: vi.fn().mockResolvedValue({ id: 'perm-id' }),
            },
            'INSERT INTO user_permissions': {
              run: vi.fn().mockResolvedValue(undefined),
            },
            'permission_audit_logs': {
              get: vi.fn().mockResolvedValue({ id: 'log-id' }),
              run: vi.fn().mockResolvedValue(undefined),
            },
            'SELECT p.module': {
              all: vi.fn().mockResolvedValue([]),
            },
          });
          mockDb.transaction.mockImplementation(async (fn: any) => fn());

          // All modules registered with all valid actions
          getModuleMock.mockImplementation((name: string) => ({
            name,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: name, ar: name },
            defaults: {},
          }));

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/users/${userId}/permissions`)
            .send({ overrides });

          expect(res.status).toBe(200);
          expect(res.body.message).toContain('updated successfully');
          expect(res.body.userId).toBe(userId);
          expect(invalidateCacheMock).toHaveBeenCalledWith(userId);
        }
      ),
      { numRuns: 50 }
    );
  }, 60000);

  it('override is rejected when action is NOT in module supported actions', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        moduleNameArb,
        invalidActionArb,
        fc.boolean(),
        async (userId, moduleName, invalidAction, isAllowed) => {
          vi.clearAllMocks();

          const mockDb = createMockDb({
            'SELECT id FROM users WHERE id': {
              get: vi.fn().mockResolvedValue({ id: userId }),
            },
            'SELECT p.module': {
              all: vi.fn().mockResolvedValue([]),
            },
          });

          // Module is registered but the action is not supported
          getModuleMock.mockImplementation((name: string) => ({
            name,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: name, ar: name },
            defaults: {},
          }));

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/users/${userId}/permissions`)
            .send({
              overrides: [{ module: moduleName, action: invalidAction, isAllowed }],
            });

          expect(res.status).toBe(400);
          expect(res.body.code).toBe('VALIDATION_ERROR');
          expect(invalidateCacheMock).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 50 }
    );
  }, 60000);

  it('override is rejected when module is not registered', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        fc.constantFrom('UnknownModule', 'FakeModule', 'NotReal'),
        validActionArb,
        fc.boolean(),
        async (userId, unregisteredModule, action, isAllowed) => {
          vi.clearAllMocks();

          const mockDb = createMockDb({
            'SELECT id FROM users WHERE id': {
              get: vi.fn().mockResolvedValue({ id: userId }),
            },
            'SELECT p.module': {
              all: vi.fn().mockResolvedValue([]),
            },
          });

          // Module is NOT registered
          getModuleMock.mockReturnValue(undefined);

          const app = createTestApp(mockDb);
          const res = await request(app)
            .put(`/users/${userId}/permissions`)
            .send({
              overrides: [{ module: unregisteredModule, action, isAllowed }],
            });

          expect(res.status).toBe(400);
          expect(res.body.code).toBe('VALIDATION_ERROR');
          expect(invalidateCacheMock).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 30 }
    );
  }, 60000);
});

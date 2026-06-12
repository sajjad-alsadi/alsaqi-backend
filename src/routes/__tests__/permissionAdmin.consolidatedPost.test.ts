import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Behavior tests — consolidated `POST /roles/:id/permissions` handler (FIX-BE-4)
 *
 * After consolidation (task 5.1) the matrix-update write op lives solely in
 * `permissionAdmin.ts` as `POST /roles/:id/permissions`, preserving the
 * `ModuleRegistry` validation, `PermissionService` persistence, and
 * `PermissionAuditService` audit-logging path that existed before.
 *
 * These tests mount the real router behind the production `responseWrapper`
 * middleware so every response is the unified API_Envelope (`{ success, data,
 * meta }`). They assert:
 *   - valid id + valid payload → persists + success envelope (Req 4.5),
 *     exercising the preserved matrix/audit logic path (Req 4.4)
 *   - non-existent role id → not-found error envelope, no mutation (Req 4.6)
 *   - invalid/malformed payload → validation error envelope, no mutation (Req 4.7)
 *
 * Validates: Requirements 4.4, 4.5, 4.6, 4.7
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Stub the db module (audit logging imports it at module load).
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

// PermissionService — the persistence collaborator on the matrix path.
const getRolePermissionsMock = vi.fn();
const updateRolePermissionsMock = vi.fn();
const invalidateCacheMock = vi.fn();
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    getRolePermissions: (...args: any[]) => getRolePermissionsMock(...args),
    updateRolePermissions: (...args: any[]) => updateRolePermissionsMock(...args),
    invalidateCache: (...args: any[]) => invalidateCacheMock(...args),
    getUserPermissions: vi.fn(),
  },
}));

// PermissionAuditService — the audit-logging collaborator on the matrix path.
const logPermissionChangeMock = vi.fn();
vi.mock('../../services/PermissionAuditService', () => ({
  PermissionAuditService: {
    logPermissionChange: (...args: any[]) => logPermissionChangeMock(...args),
  },
}));

// ModuleRegistry — validates each permission update.
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
import { createResponseWrapper } from '../../middleware/responseWrapper';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a test app that mounts the permission-admin router behind the
 * production response wrapper, so responses are wrapped in the API_Envelope.
 */
function createTestApp(mockDb: any) {
  const app = express();
  app.use(express.json());
  app.use(createResponseWrapper());

  const authenticate = (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-user-id', role: 'Admin' };
    next();
  };
  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const logError = vi.fn();

  app.use(createPermissionAdminRoutes(mockDb, authenticate, checkPermission, logError));
  return app;
}

/** Mock DB whose `prepare(sql)` dispatches by a substring match on the SQL. */
function createMockDb(handlers: Record<string, any> = {}) {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (sql.includes(pattern)) return handler;
    }
    return {
      get: vi.fn().mockResolvedValue(undefined),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    };
  });
  const transaction = vi.fn().mockImplementation(async (fn: any) => fn());
  return { prepare, transaction };
}

const ROLE_ID = '11111111-1111-1111-1111-111111111111';

/** Registers every module name used in tests with the standard action set. */
function registerAllModules() {
  getModuleMock.mockImplementation((name: string) => ({
    name,
    actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    label: { en: name, ar: name },
    defaults: {},
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /roles/:id/permissions — consolidated behavior (FIX-BE-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllModulesMock.mockReturnValue([]);
  });

  describe('Requirement 4.5 / 4.4: valid role id + valid payload', () => {
    it('persists the update, returns a success envelope, and exercises the matrix/audit path', async () => {
      registerAllModules();
      getRolePermissionsMock.mockResolvedValue({ permissions: { Dashboard: ['View'] } });
      updateRolePermissionsMock.mockResolvedValue(undefined);
      logPermissionChangeMock.mockResolvedValue(undefined);

      const mockDb = createMockDb({
        'SELECT id, name, is_custom FROM roles': {
          get: vi.fn().mockResolvedValue({ id: ROLE_ID, name: 'CustomRole', is_custom: true }),
        },
      });

      const permissions = [
        { module: 'Dashboard', action: 'Edit', granted: true },
        { module: 'RiskRegister', action: 'View', granted: false },
      ];

      const res = await request(createTestApp(mockDb))
        .post(`/roles/${ROLE_ID}/permissions`)
        .send({ permissions });

      // Success envelope (Req 4.5)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        roleId: ROLE_ID,
        roleName: 'CustomRole',
        updatedCount: permissions.length,
      });
      expect(res.body.data.message).toContain('updated successfully');
      expect(res.body.meta).toBeDefined();

      // Preserved matrix/audit logic path executed (Req 4.4)
      expect(getRolePermissionsMock).toHaveBeenCalledWith(ROLE_ID);
      expect(updateRolePermissionsMock).toHaveBeenCalledWith(ROLE_ID, permissions);
      expect(logPermissionChangeMock).toHaveBeenCalledTimes(1);
      expect(logPermissionChangeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'role_permission_change',
          targetRoleId: ROLE_ID,
        })
      );
    });
  });

  describe('Requirement 4.6: non-existent role id', () => {
    it('returns a not-found error envelope and does not mutate stored permissions', async () => {
      registerAllModules();

      const mockDb = createMockDb({
        'SELECT id, name, is_custom FROM roles': {
          get: vi.fn().mockResolvedValue(undefined), // role does not exist
        },
      });

      const res = await request(createTestApp(mockDb))
        .post(`/roles/${ROLE_ID}/permissions`)
        .send({ permissions: [{ module: 'Dashboard', action: 'View', granted: true }] });

      // Not-found error envelope (Req 4.6)
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeNull();
      expect(res.body.error.code).toBe('NOT_FOUND');

      // No mutation occurred
      expect(updateRolePermissionsMock).not.toHaveBeenCalled();
      expect(logPermissionChangeMock).not.toHaveBeenCalled();
    });
  });

  describe('Requirement 4.7: invalid/malformed payload', () => {
    it('returns a validation error envelope and retains existing permissions (schema mismatch)', async () => {
      registerAllModules();

      const mockDb = createMockDb({
        'SELECT id, name, is_custom FROM roles': {
          get: vi.fn().mockResolvedValue({ id: ROLE_ID, name: 'CustomRole', is_custom: true }),
        },
      });

      // Malformed: `granted` missing and not a boolean — fails the Zod schema.
      const res = await request(createTestApp(mockDb))
        .post(`/roles/${ROLE_ID}/permissions`)
        .send({ permissions: [{ module: 'Dashboard', action: 'View' }] });

      // Validation error envelope (Req 4.7)
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      // Existing permissions unchanged — no read/write/audit performed
      expect(getRolePermissionsMock).not.toHaveBeenCalled();
      expect(updateRolePermissionsMock).not.toHaveBeenCalled();
      expect(logPermissionChangeMock).not.toHaveBeenCalled();
    });

    it('returns a validation error envelope when a permission targets an unregistered module', async () => {
      // Module is not registered → matrix validation rejects it.
      getModuleMock.mockReturnValue(undefined);

      const mockDb = createMockDb({
        'SELECT id, name, is_custom FROM roles': {
          get: vi.fn().mockResolvedValue({ id: ROLE_ID, name: 'CustomRole', is_custom: true }),
        },
      });

      const res = await request(createTestApp(mockDb))
        .post(`/roles/${ROLE_ID}/permissions`)
        .send({ permissions: [{ module: 'NotAModule', action: 'View', granted: true }] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      // No persistence/audit on the rejected matrix update
      expect(updateRolePermissionsMock).not.toHaveBeenCalled();
      expect(logPermissionChangeMock).not.toHaveBeenCalled();
    });
  });
});

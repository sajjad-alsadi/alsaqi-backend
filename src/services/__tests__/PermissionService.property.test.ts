// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for PermissionService
 *
 * Property 5: Admin Supremacy
 * Property 6: Permission Resolution with Override Precedence
 *
 * **Validates: Requirements 4.2, 4.3, 4.4, 4.5**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock the database module
vi.mock('../../db/index', () => {
  const prepareMock = vi.fn();
  return {
    db: { prepare: prepareMock },
    default: { prepare: prepareMock },
  };
});

// Mock the PermissionCache module
vi.mock('../PermissionCache', () => {
  const getMock = vi.fn().mockReturnValue(undefined);
  const setMock = vi.fn();
  const invalidateUserMock = vi.fn();
  const invalidateAllMock = vi.fn();
  return {
    permissionCache: {
      get: getMock,
      set: setMock,
      invalidateUser: invalidateUserMock,
      invalidateAll: invalidateAllMock,
    },
  };
});

// Mock the ModuleRegistry
vi.mock('../../permissions/registry', () => {
  const getModuleMock = vi.fn();
  const getAllModulesMock = vi.fn().mockReturnValue([]);
  const getModuleNamesMock = vi.fn().mockReturnValue([]);
  return {
    ModuleRegistry: {
      getModule: getModuleMock,
      getAllModules: getAllModulesMock,
      getModuleNames: getModuleNamesMock,
    },
    ModuleRegistryImpl: vi.fn(),
  };
});

import { PermissionService } from '../PermissionService';
import { db } from '../../db/index';
import { permissionCache } from '../PermissionCache';
import { ModuleRegistry } from '../../permissions/registry';
import { UserRole } from '@alsaqi/shared';

// ─── Custom Arbitraries ──────────────────────────────────────────────────────

/** Generates a valid UUID */
const userIdArb = fc.uuid();

/** Generates a valid module name (PascalCase) */
const moduleNameArb = fc.constantFrom(
  'Dashboard',
  'AuditCharter',
  'AuditPlans',
  'AuditFindings',
  'Policies',
  'RiskRegister',
  'Analytics',
  'Compliance',
  'Correspondence',
  'Fraud',
  'Integrity',
  'Recommendations',
  'Regulatory',
  'UserManagement',
  'Settings'
);

/** Generates a valid permission action */
const actionArb = fc.constantFrom('View', 'Create', 'Edit', 'Delete', 'Approve');

/** Generates a non-Admin role */
const nonAdminRoleArb = fc.constantFrom(
  UserRole.INTERNAL_AUDITOR,
  UserRole.COMPLIANCE_OFFICER,
  UserRole.RISK_OFFICER,
  UserRole.MANAGER,
  UserRole.VIEWER
);

/** Generates a role ID (UUID) */
const roleIdArb = fc.uuid();

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Sets up the DB mock to return a user with the given role and role_id.
 */
function setupUserMock(userId: string, role: string, roleId: string) {
  (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
    if (sql.includes('SELECT id, role, role_id FROM users')) {
      return { get: vi.fn().mockResolvedValue({ id: userId, role, role_id: roleId }) };
    }
    // Default: return empty for other queries
    return { get: vi.fn().mockResolvedValue(undefined), all: vi.fn().mockResolvedValue([]) };
  });
}

/**
 * Sets up the DB mock for a full permission resolution scenario.
 */
function setupPermissionResolutionMock(config: {
  userId: string;
  role: string;
  roleId: string;
  userOverride?: { is_allowed: number } | undefined;
  rolePermissionExists: boolean;
}) {
  (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
    // User lookup
    if (sql.includes('SELECT id, role, role_id FROM users')) {
      return {
        get: vi.fn().mockResolvedValue({
          id: config.userId,
          role: config.role,
          role_id: config.roleId,
        }),
      };
    }
    // User override check
    if (sql.includes('user_permissions') && sql.includes('is_allowed')) {
      return {
        get: vi.fn().mockResolvedValue(config.userOverride),
      };
    }
    // Role permission check
    if (sql.includes('role_permissions') && sql.includes('permissions')) {
      return {
        get: vi.fn().mockResolvedValue(config.rolePermissionExists ? { '1': 1 } : undefined),
      };
    }
    // Default fallback
    return { get: vi.fn().mockResolvedValue(undefined), all: vi.fn().mockResolvedValue([]) };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 5: Admin Supremacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Always return undefined from cache to force resolution logic
    (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('for any module M registered in the registry and any action A, if user has Admin role, hasPermission returns true', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        roleIdArb,
        async (userId, module, action, roleId) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: user has Admin role
          setupUserMock(userId, UserRole.ADMIN, roleId);

          // Setup: module is registered with the given action
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          const result = await PermissionService.hasPermission(userId, module, action);

          // Admin always gets true
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  it('Admin supremacy holds regardless of whether role_permissions or user_permissions exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        roleIdArb,
        fc.boolean(), // whether role permission exists
        fc.option(fc.constantFrom(0, 1), { nil: undefined }), // user override
        async (userId, module, action, roleId, _rolePermExists, _userOverride) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: user has Admin role - DB state shouldn't matter
          setupUserMock(userId, UserRole.ADMIN, roleId);

          // Setup: module is registered
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          const result = await PermissionService.hasPermission(userId, module, action);

          // Admin always gets true regardless of DB state
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);
});

describe('Property 6: Permission Resolution with Override Precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Always return undefined from cache to force resolution logic
    (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('if user_permissions has (U, M, A, is_allowed=true), hasPermission returns true regardless of role_permissions', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        nonAdminRoleArb,
        roleIdArb,
        fc.boolean(), // whether role permission exists (should not matter)
        async (userId, module, action, role, roleId, rolePermExists) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: module is registered with the given action
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          // Setup: user has non-Admin role with user override granting permission
          setupPermissionResolutionMock({
            userId,
            role,
            roleId,
            userOverride: { is_allowed: 1 }, // User override grants
            rolePermissionExists: rolePermExists, // Doesn't matter
          });

          const result = await PermissionService.hasPermission(userId, module, action);

          // User override with is_allowed=true always grants
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  it('if user_permissions has (U, M, A, is_allowed=false), hasPermission returns false regardless of role_permissions', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        nonAdminRoleArb,
        roleIdArb,
        fc.boolean(), // whether role permission exists (should not matter)
        async (userId, module, action, role, roleId, rolePermExists) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: module is registered with the given action
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          // Setup: user has non-Admin role with user override denying permission
          setupPermissionResolutionMock({
            userId,
            role,
            roleId,
            userOverride: { is_allowed: 0 }, // User override denies
            rolePermissionExists: rolePermExists, // Doesn't matter
          });

          const result = await PermissionService.hasPermission(userId, module, action);

          // User override with is_allowed=false always denies
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  it('if no user override exists, hasPermission returns the role_permissions result', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        nonAdminRoleArb,
        roleIdArb,
        fc.boolean(), // whether role permission exists
        async (userId, module, action, role, roleId, rolePermExists) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: module is registered with the given action
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          // Setup: user has non-Admin role with NO user override
          setupPermissionResolutionMock({
            userId,
            role,
            roleId,
            userOverride: undefined, // No override
            rolePermissionExists: rolePermExists,
          });

          const result = await PermissionService.hasPermission(userId, module, action);

          // Without override, result matches role permission
          expect(result).toBe(rolePermExists);
        }
      ),
      { numRuns: 100 }
    );
  }, 30000);

  it('override precedence is consistent: grant override > role deny, deny override > role grant', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        moduleNameArb,
        actionArb,
        nonAdminRoleArb,
        roleIdArb,
        async (userId, module, action, role, roleId) => {
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

          // Setup: module is registered
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          // Case 1: Grant override overrides role denial
          setupPermissionResolutionMock({
            userId,
            role,
            roleId,
            userOverride: { is_allowed: 1 },
            rolePermissionExists: false, // Role denies
          });

          const grantOverrideDeny = await PermissionService.hasPermission(userId, module, action);
          expect(grantOverrideDeny).toBe(true);

          // Case 2: Deny override overrides role grant
          vi.clearAllMocks();
          (permissionCache.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
          (ModuleRegistry.getModule as ReturnType<typeof vi.fn>).mockReturnValue({
            name: module,
            actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
            label: { en: module, ar: module },
            defaults: {},
          });

          setupPermissionResolutionMock({
            userId,
            role,
            roleId,
            userOverride: { is_allowed: 0 },
            rolePermissionExists: true, // Role grants
          });

          const denyOverrideGrant = await PermissionService.hasPermission(userId, module, action);
          expect(denyOverrideGrant).toBe(false);
        }
      ),
      { numRuns: 50 }
    );
  }, 30000);
});

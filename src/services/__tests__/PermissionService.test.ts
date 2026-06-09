// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserRole } from '@alsaqi/shared';
import { ModuleRegistry } from '../../permissions/registry';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn),
    },
    default: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn),
    },
  };
});

// Mock the PermissionCache module
vi.mock('../PermissionCache', () => {
  const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    invalidateUser: vi.fn(),
    invalidateAll: vi.fn(),
    _reset: vi.fn(),
    size: 0,
  };
  return {
    permissionCache: mockCache,
    PermissionCache: vi.fn(() => mockCache),
  };
});

import { PermissionService } from '../PermissionService';
import { db } from '../../db/index';
import { permissionCache } from '../PermissionCache';

describe('PermissionService', () => {
  const mockDb = db as any;
  const mockCache = permissionCache as any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Register test modules in the registry
    ModuleRegistry._reset();
    ModuleRegistry.register({
      name: 'Analytics',
      label: { en: 'Analytics', ar: 'التحليلات' },
      actions: ['View'],
      defaults: {
        [UserRole.ADMIN]: ['View'],
        [UserRole.MANAGER]: ['View'],
      },
    });
    ModuleRegistry.register({
      name: 'Policies',
      label: { en: 'Policies', ar: 'السياسات' },
      actions: ['View', 'Create', 'Edit', 'Delete'],
      defaults: {
        [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
        [UserRole.COMPLIANCE_OFFICER]: ['View', 'Create', 'Edit'],
        [UserRole.VIEWER]: ['View'],
      },
    });

    // Default cache behavior: miss
    mockCache.get.mockReturnValue(undefined);
  });

  afterEach(() => {
    ModuleRegistry._reset();
  });

  // Helper to set up db.prepare mock for sequential calls
  function setupDbMock(responses: Array<{ get?: any; all?: any; run?: any }>) {
    let callIndex = 0;
    mockDb.prepare.mockImplementation(() => {
      const response = responses[callIndex] || {};
      callIndex++;
      return {
        get: vi.fn().mockResolvedValue(response.get),
        all: vi.fn().mockResolvedValue(response.all || []),
        run: vi.fn().mockResolvedValue(response.run || { changes: 0 }),
      };
    });
  }

  describe('hasPermission', () => {
    it('should return true for Admin role without querying permissions (Admin bypass)', async () => {
      // User lookup returns Admin
      setupDbMock([
        { get: { id: 'user1', role: UserRole.ADMIN, role_id: 'role-admin' } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Analytics', 'View');

      expect(result).toBe(true);
      // Should only call prepare once (for user lookup), not for permission resolution
      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
      // Cache should not be consulted for Admin
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('should return true for role-based grant (role_permissions has the permission)', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.COMPLIANCE_OFFICER, role_id: 'role-co' } },
        // User override check - no override
        { get: undefined },
        // Role permission check - permission exists
        { get: { '1': 1 } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'View');

      expect(result).toBe(true);
      // Should cache the result
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Policies_View', true);
    });

    it('should return false for role-based denial (role_permissions lacks the permission)', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.VIEWER, role_id: 'role-viewer' } },
        // User override check - no override
        { get: undefined },
        // Role permission check - no permission
        { get: undefined },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'Create');

      expect(result).toBe(false);
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Policies_Create', false);
    });

    it('should return true for user override grant (is_allowed=true overrides role denial)', async () => {
      setupDbMock([
        // User lookup - Viewer role (normally can't Create)
        { get: { id: 'user1', role: UserRole.VIEWER, role_id: 'role-viewer' } },
        // User override check - override grants
        { get: { is_allowed: 1 } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'Create');

      expect(result).toBe(true);
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Policies_Create', true);
    });

    it('should return false for user override denial (is_allowed=false overrides role grant)', async () => {
      setupDbMock([
        // User lookup - Compliance Officer (normally can View)
        { get: { id: 'user1', role: UserRole.COMPLIANCE_OFFICER, role_id: 'role-co' } },
        // User override check - override denies
        { get: { is_allowed: 0 } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'View');

      expect(result).toBe(false);
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Policies_View', false);
    });

    it('should return false for unregistered module', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.MANAGER, role_id: 'role-mgr' } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'NonExistentModule', 'View');

      expect(result).toBe(false);
      // Should not query DB for permissions when module is not registered
      expect(mockDb.prepare).toHaveBeenCalledTimes(1); // Only user lookup
    });

    it('should return false for unregistered action on a valid module', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.MANAGER, role_id: 'role-mgr' } },
      ]);

      // Analytics only supports 'View', not 'Delete'
      const result = await PermissionService.hasPermission('user1', 'Analytics', 'Delete');

      expect(result).toBe(false);
      expect(mockDb.prepare).toHaveBeenCalledTimes(1); // Only user lookup
    });

    it('should return false when user does not exist', async () => {
      setupDbMock([
        // User lookup - not found
        { get: undefined },
      ]);

      const result = await PermissionService.hasPermission('nonexistent', 'Analytics', 'View');

      expect(result).toBe(false);
    });

    it('should return false when user has no role assigned and no override', async () => {
      setupDbMock([
        // User lookup - no role_id
        { get: { id: 'user1', role: UserRole.VIEWER, role_id: null } },
        // User override check - no override
        { get: undefined },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'View');

      expect(result).toBe(false);
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Policies_View', false);
    });
  });

  describe('cache behavior', () => {
    it('should return cached result without DB permission query (cache hit)', async () => {
      // Cache returns a hit
      mockCache.get.mockReturnValue(true);

      setupDbMock([
        // User lookup (still needed to check Admin role)
        { get: { id: 'user1', role: UserRole.MANAGER, role_id: 'role-mgr' } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Analytics', 'View');

      expect(result).toBe(true);
      expect(mockCache.get).toHaveBeenCalledWith('perm_user1_Analytics_View');
      // Should NOT query DB for permission resolution (only user lookup)
      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
      // Should NOT set cache again
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('should query DB on cache miss and store result', async () => {
      // Cache miss
      mockCache.get.mockReturnValue(undefined);

      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.MANAGER, role_id: 'role-mgr' } },
        // User override check
        { get: undefined },
        // Role permission check
        { get: { '1': 1 } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Analytics', 'View');

      expect(result).toBe(true);
      // Should have queried DB for permission resolution
      expect(mockDb.prepare).toHaveBeenCalledTimes(3);
      // Should cache the result
      expect(mockCache.set).toHaveBeenCalledWith('perm_user1_Analytics_View', true);
    });

    it('should return false from cache without DB query', async () => {
      mockCache.get.mockReturnValue(false);

      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.VIEWER, role_id: 'role-viewer' } },
      ]);

      const result = await PermissionService.hasPermission('user1', 'Policies', 'Delete');

      expect(result).toBe(false);
      expect(mockDb.prepare).toHaveBeenCalledTimes(1); // Only user lookup
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('should call invalidateUser when userId is provided', () => {
      PermissionService.invalidateCache('user1');

      expect(mockCache.invalidateUser).toHaveBeenCalledWith('user1');
      expect(mockCache.invalidateAll).not.toHaveBeenCalled();
    });

    it('should call invalidateAll when no userId is provided', () => {
      PermissionService.invalidateCache();

      expect(mockCache.invalidateAll).toHaveBeenCalled();
      expect(mockCache.invalidateUser).not.toHaveBeenCalled();
    });

    it('should call invalidateAll when userId is undefined', () => {
      PermissionService.invalidateCache(undefined);

      expect(mockCache.invalidateAll).toHaveBeenCalled();
    });
  });

  describe('getUserPermissions', () => {
    it('should return correct UserPermissionSet with merged permissions', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: UserRole.COMPLIANCE_OFFICER, role_id: 'role-co' } },
        // Role lookup
        { get: { id: 'role-co', name: 'Compliance Officer', is_custom: 0 } },
        // Role permissions
        {
          all: [
            { module: 'Policies', action: 'View' },
            { module: 'Policies', action: 'Create' },
            { module: 'Policies', action: 'Edit' },
            { module: 'Analytics', action: 'View' },
          ],
        },
        // User overrides
        {
          all: [
            { module: 'Policies', action: 'Delete', is_allowed: 1 },
            { module: 'Policies', action: 'Edit', is_allowed: 0 },
          ],
        },
      ]);

      const result = await PermissionService.getUserPermissions('user1');

      expect(result.userId).toBe('user1');
      expect(result.role).toBe('Compliance Officer');
      expect(result.roleId).toBe('role-co');
      expect(result.isCustomRole).toBe(false);
      // Policies: View, Create from role + Delete granted by override - Edit denied by override
      expect(result.permissions['Policies']).toContain('View');
      expect(result.permissions['Policies']).toContain('Create');
      expect(result.permissions['Policies']).toContain('Delete');
      expect(result.permissions['Policies']).not.toContain('Edit');
      // Analytics: View from role
      expect(result.permissions['Analytics']).toContain('View');
      // Overrides array
      expect(result.overrides).toHaveLength(2);
      expect(result.overrides).toContainEqual({
        module: 'Policies',
        action: 'Delete',
        isAllowed: true,
      });
      expect(result.overrides).toContainEqual({
        module: 'Policies',
        action: 'Edit',
        isAllowed: false,
      });
    });

    it('should throw error when user does not exist', async () => {
      setupDbMock([{ get: undefined }]);

      await expect(PermissionService.getUserPermissions('nonexistent')).rejects.toThrow(
        'User nonexistent not found'
      );
    });

    it('should return isCustomRole=true for custom roles', async () => {
      setupDbMock([
        // User lookup
        { get: { id: 'user1', role: 'CustomRole', role_id: 'role-custom' } },
        // Role lookup
        { get: { id: 'role-custom', name: 'CustomRole', is_custom: 1 } },
        // Role permissions
        { all: [{ module: 'Analytics', action: 'View' }] },
        // User overrides
        { all: [] },
      ]);

      const result = await PermissionService.getUserPermissions('user1');

      expect(result.isCustomRole).toBe(true);
    });
  });

  describe('getRolePermissions', () => {
    it('should return correct RolePermissionSet', async () => {
      setupDbMock([
        // Role lookup
        { get: { id: 'role-co', name: 'Compliance Officer', is_custom: 0 } },
        // Role permissions
        {
          all: [
            { module: 'Policies', action: 'View' },
            { module: 'Policies', action: 'Create' },
            { module: 'Policies', action: 'Edit' },
            { module: 'Analytics', action: 'View' },
          ],
        },
      ]);

      const result = await PermissionService.getRolePermissions('role-co');

      expect(result.roleId).toBe('role-co');
      expect(result.roleName).toBe('Compliance Officer');
      expect(result.isCustom).toBe(false);
      expect(result.permissions['Policies']).toEqual(
        expect.arrayContaining(['View', 'Create', 'Edit'])
      );
      expect(result.permissions['Analytics']).toEqual(['View']);
    });

    it('should throw error when role does not exist', async () => {
      setupDbMock([{ get: undefined }]);

      await expect(PermissionService.getRolePermissions('nonexistent')).rejects.toThrow(
        'Role nonexistent not found'
      );
    });

    it('should return isCustom=true for custom roles', async () => {
      setupDbMock([
        { get: { id: 'role-custom', name: 'Custom Auditor', is_custom: 1 } },
        { all: [] },
      ]);

      const result = await PermissionService.getRolePermissions('role-custom');

      expect(result.isCustom).toBe(true);
      expect(result.permissions).toEqual({});
    });
  });
});

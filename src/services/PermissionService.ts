import { db } from '../db/index';
import { ModuleRegistry } from '../permissions/registry';
import { permissionCache } from './PermissionCache';
import {
  PermissionAction,
  PermissionUpdate,
  UserPermissionSet,
  RolePermissionSet,
} from '../permissions/types';
import { UserRole } from '@alsaqi/shared';

/**
 * PermissionService - Centralized service for all permission queries and mutations.
 *
 * Implements the permission resolution logic:
 * 1. Admin role → always true (no DB query)
 * 2. Module/action not in registry → always false
 * 3. Check cache → return if hit
 * 4. Check user_permissions (override) → if exists, use is_allowed
 * 5. Fall back to role_permissions → return whether a matching record exists
 * 6. Cache the result
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class PermissionService {
  private static cache = permissionCache;

  /**
   * Check if a user has a specific permission.
   *
   * Resolution order:
   * - Admin role → true immediately (Req 4.5)
   * - Module/action not registered → false (Req 4.6)
   * - Cache hit → return cached value (Req 5.2)
   * - User override exists → use is_allowed (Req 4.2, 4.3)
   * - Role permission exists → true (Req 4.4)
   * - Otherwise → false (Req 4.7)
   */
  static async hasPermission(
    userId: string,
    module: string,
    action: string
  ): Promise<boolean> {
    // Req 4.5: Admin always has permission
    const user = await this.getUser(userId);
    if (!user) return false;
    if (user.role === UserRole.ADMIN) return true;

    // Req 4.6: Deny if module/action not registered
    const moduleDef = ModuleRegistry.getModule(module);
    if (!moduleDef) return false;
    if (!moduleDef.actions.includes(action as PermissionAction)) return false;

    // Req 5.2: Check cache first
    const cacheKey = `perm_${userId}_${module}_${action}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    // Req 4.1-4.4: Check user override first, then role permissions
    const result = await this.resolvePermission(userId, module, action, user.role_id);

    // Req 5.1: Cache the result
    this.cache.set(cacheKey, result);

    return result;
  }

  /**
   * Get all effective permissions for a user.
   * Combines role-level permissions with user-specific overrides.
   */
  static async getUserPermissions(userId: string): Promise<UserPermissionSet> {
    const user = await this.getUser(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const role = await this.getRole(user.role_id);
    const roleName = role?.name || user.role || 'Unknown';
    const roleId = user.role_id || '';
    const isCustomRole = role?.is_custom === 1 || role?.is_custom === true;

    // Get all role permissions
    const rolePermissions = user.role_id
      ? await db
          .prepare(
            `SELECT p.module, p.action
             FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             WHERE rp.role_id = ?`
          )
          .all(user.role_id)
      : [];

    // Get all user overrides
    const userOverrides = (await db
      .prepare(
        `SELECT p.module, p.action, up.is_allowed
         FROM permissions p
         JOIN user_permissions up ON p.id = up.permission_id
         WHERE up.user_id = ?`
      )
      .all(userId)) as Array<{ module: string; action: string; is_allowed: number | boolean }>;

    // Build effective permissions map
    const permissions: Record<string, PermissionAction[]> = {};

    // Start with role permissions
    for (const rp of rolePermissions as Array<{ module: string; action: string }>) {
      if (!permissions[rp.module]) {
        permissions[rp.module] = [];
      }
      if (!permissions[rp.module].includes(rp.action as PermissionAction)) {
        permissions[rp.module].push(rp.action as PermissionAction);
      }
    }

    // Apply user overrides
    for (const override of userOverrides) {
      if (!permissions[override.module]) {
        permissions[override.module] = [];
      }

      if (override.is_allowed === 1 || override.is_allowed === true) {
        // Grant: add action if not already present
        if (!permissions[override.module].includes(override.action as PermissionAction)) {
          permissions[override.module].push(override.action as PermissionAction);
        }
      } else {
        // Deny: remove action if present
        permissions[override.module] = permissions[override.module].filter(
          (a) => a !== override.action
        );
      }
    }

    // Clean up empty arrays
    for (const mod of Object.keys(permissions)) {
      if (permissions[mod].length === 0) {
        delete permissions[mod];
      }
    }

    // Build overrides array
    const overrides = userOverrides.map((o) => ({
      module: o.module,
      action: o.action as PermissionAction,
      isAllowed: o.is_allowed === 1 || o.is_allowed === true,
    }));

    return {
      userId,
      role: roleName,
      roleId: roleId,
      isCustomRole,
      permissions,
      overrides,
    };
  }

  /**
   * Get the permission matrix for a role.
   */
  static async getRolePermissions(roleId: string): Promise<RolePermissionSet> {
    const role = await this.getRole(roleId);
    if (!role) {
      throw new Error(`Role ${roleId} not found`);
    }

    const rolePerms = (await db
      .prepare(
        `SELECT p.module, p.action
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`
      )
      .all(roleId)) as Array<{ module: string; action: string }>;

    const permissions: Record<string, PermissionAction[]> = {};
    for (const rp of rolePerms) {
      if (!permissions[rp.module]) {
        permissions[rp.module] = [];
      }
      if (!permissions[rp.module].includes(rp.action as PermissionAction)) {
        permissions[rp.module].push(rp.action as PermissionAction);
      }
    }

    return {
      roleId,
      roleName: role.name,
      isCustom: role.is_custom === 1 || role.is_custom === true,
      permissions,
    };
  }

  /**
   * Update a role's permissions.
   * Applies the given permission updates and invalidates cache for all affected users.
   */
  static async updateRolePermissions(
    roleId: string,
    permissions: PermissionUpdate[]
  ): Promise<void> {
    await db.transaction(async () => {
      for (const perm of permissions) {
        // Get the permission record ID
        const permRecord = (await db
          .prepare(
            'SELECT id FROM permissions WHERE module = ? AND action = ?'
          )
          .get(perm.module, perm.action)) as { id: string } | undefined;

        if (!permRecord) continue;

        if (perm.granted) {
          // Grant: insert role_permission if not exists
          await db
            .prepare(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES (?::uuid, ?::uuid) ON CONFLICT DO NOTHING'
            )
            .run(roleId, permRecord.id);
        } else {
          // Revoke: delete role_permission
          await db
            .prepare(
              'DELETE FROM role_permissions WHERE role_id = ?::uuid AND permission_id = ?::uuid'
            )
            .run(roleId, permRecord.id);
        }
      }
    });

    // Invalidate cache for all users with this role
    await this.invalidateCacheForRole(roleId);
  }

  /**
   * Set a user-specific permission override.
   * Upserts the user_permissions record and invalidates the user's cache.
   */
  static async setUserPermissionOverride(
    userId: string,
    module: string,
    action: string,
    allowed: boolean
  ): Promise<void> {
    // Get the permission record ID
    const permRecord = (await db
      .prepare('SELECT id FROM permissions WHERE module = ? AND action = ?')
      .get(module, action)) as { id: string } | undefined;

    if (!permRecord) {
      throw new Error(
        `Permission record not found for module '${module}' action '${action}'`
      );
    }

    const isAllowed = allowed ? 1 : 0;

    // Upsert: try to update first, insert if not exists
    const existing = await db
      .prepare(
        'SELECT 1 FROM user_permissions WHERE user_id = ?::uuid AND permission_id = ?::uuid'
      )
      .get(userId, permRecord.id);

    if (existing) {
      await db
        .prepare(
          'UPDATE user_permissions SET is_allowed = ? WHERE user_id = ?::uuid AND permission_id = ?::uuid'
        )
        .run(isAllowed, userId, permRecord.id);
    } else {
      await db
        .prepare(
          'INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES (?::uuid, ?::uuid, ?)'
        )
        .run(userId, permRecord.id, isAllowed);
    }

    // Invalidate cache for this user
    this.invalidateCache(userId);
  }

  /**
   * Invalidate permission cache.
   * - If userId provided: remove all entries for that user (prefix `perm_{userId}_`)
   * - If no userId: remove all permission cache entries (prefix `perm_`)
   *
   * Req 5.3, 5.4
   */
  static invalidateCache(userId?: string): void {
    if (userId) {
      this.cache.invalidateUser(userId);
    } else {
      this.cache.invalidateAll();
    }
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Resolve a permission by checking user overrides first, then role permissions.
   */
  private static async resolvePermission(
    userId: string,
    module: string,
    action: string,
    roleId: string | null
  ): Promise<boolean> {
    // Check user-level override first (Req 4.1, 4.2, 4.3)
    const userOverride = (await db
      .prepare(
        `SELECT up.is_allowed
         FROM user_permissions up
         JOIN permissions p ON up.permission_id = p.id
         WHERE up.user_id = ? AND p.module = ? AND p.action = ?`
      )
      .get(userId, module, action)) as { is_allowed: number } | undefined;

    if (userOverride !== undefined) {
      // User override exists - use it regardless of role permission
      return userOverride.is_allowed === 1 || (userOverride.is_allowed as any) === true;
    }

    // No user override - fall back to role permissions (Req 4.4)
    if (!roleId) return false; // Req 4.7: no role assigned → deny

    const rolePermission = await db
      .prepare(
        `SELECT 1
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ? AND p.module = ? AND p.action = ?`
      )
      .get(roleId, module, action);

    return !!rolePermission;
  }

  /**
   * Get user record from DB (with basic fields needed for permission checks).
   */
  private static async getUser(
    userId: string
  ): Promise<{ id: string; role: string; role_id: string } | undefined> {
    return (await db
      .prepare('SELECT id, role, role_id FROM users WHERE id = ?')
      .get(userId)) as { id: string; role: string; role_id: string } | undefined;
  }

  /**
   * Get role record from DB.
   */
  private static async getRole(
    roleId: string | null
  ): Promise<{ id: string; name: string; is_custom: number | boolean } | undefined> {
    if (!roleId) return undefined;
    return (await db
      .prepare('SELECT id, name, is_custom FROM roles WHERE id = ?')
      .get(roleId)) as { id: string; name: string; is_custom: number | boolean } | undefined;
  }

  /**
   * Invalidate cache for all users assigned to a specific role.
   * Req 5.5: When a role's permissions change, invalidate all affected users.
   */
  private static async invalidateCacheForRole(roleId: string): Promise<void> {
    const users = (await db
      .prepare('SELECT id FROM users WHERE role_id = ?')
      .all(roleId)) as Array<{ id: string }>;

    for (const user of users) {
      this.cache.invalidateUser(user.id);
    }
  }
}

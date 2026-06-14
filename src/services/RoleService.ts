import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';
import { AuthCacheInvalidator } from './AuthCacheInvalidator';

export class RoleService {
  static async getAllRoles() {
    const roles = await db.prepare("SELECT * FROM roles ORDER BY name ASC").all() as any[];
    
    const roleIds = roles.map(r => r.id);
    let allPermissions: any[] = [];
    
    if (roleIds.length > 0) {
      const placeholders = roleIds.map(() => '?').join(',');
      allPermissions = await db.prepare(`
        SELECT rp.role_id, p.id, p.module, p.action
        FROM permissions p
        JOIN role_permissions rp ON p.id = rp.permission_id
        WHERE rp.role_id IN (${placeholders})
      `).all(...roleIds);
    }
    
    const rolesWithPermissions = roles.map(role => ({
      ...role,
      permissions: allPermissions
        .filter(p => p.role_id === role.id)
        .map(p => ({ id: p.id, module: p.module, action: p.action }))
    }));

    return rolesWithPermissions;
  }

  static async getRolePermissions(roleId: string | number) {
    const perms = await db.prepare(`
      SELECT p.* 
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = ?
    `).all(roleId);
    return perms;
  }

  static async updateRolePermissions(roleId: string | number, permissionIds: (string | number)[]) {
    const uniquePermissionIds = Array.isArray(permissionIds) ? [...new Set(permissionIds)] : [];
    
    await db.transaction(async () => {
      await db.prepare("DELETE FROM role_permissions WHERE role_id = ?::uuid").run(roleId);
      for (const pid of uniquePermissionIds) {
        await db.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?::uuid, ?::uuid) ON CONFLICT DO NOTHING").run(roleId, pid);
      }
    });

    // A role's permission set changed, so every user assigned to this role may now
    // have stale cached authorization. Resolve the affected users and route each
    // through the canonical AuthCacheInvalidator so both the in-process permission
    // cache and the distributed Redis auth cache are cleared with retry semantics
    // (Req 2.8).
    const affectedUsers = await db
      .prepare("SELECT id FROM users WHERE role_id = ?")
      .all(roleId) as Array<{ id: string }>;
    for (const user of affectedUsers) {
      await AuthCacheInvalidator.invalidate(user.id);
    }

    return true;
  }

  static async getAllPermissions() {
    return await db.prepare("SELECT * FROM permissions ORDER BY module ASC, action ASC").all();
  }
}

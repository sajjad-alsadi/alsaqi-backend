import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';

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
    return true;
  }

  static async getAllPermissions() {
    return await db.prepare("SELECT * FROM permissions ORDER BY module ASC, action ASC").all();
  }
}

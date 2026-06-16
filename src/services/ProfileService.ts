import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';
import { AuditChainService } from './AuditChainService';

export class ProfileService {
  static async getProfile(userId: string | number) {
    const user = await db.prepare(`
      SELECT u.id, u.employee_id, u.username, u.name, u.email, u.department, u.role, u.profile_picture, u.last_login, u.language, u.dashboard_layout, u.notifications_enabled, u.theme, j.name as job_title 
      FROM users u 
      LEFT JOIN job_titles j ON u.job_title_id = j.id 
      WHERE u.id = ?
    `).get(userId) as any;
    
    if (!user) throw new NotFoundError("User profile not found");

    // Fetch user permissions from DB (role_permissions + user_permissions)
    let permissions: Array<{ module: string; action: string }> = [];
    try {
      permissions = await db.prepare(`
        SELECT p.module, p.action FROM permissions p
        JOIN role_permissions rp ON p.id = rp.permission_id
        WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?)
        UNION
        SELECT p.module, p.action FROM permissions p
        JOIN user_permissions up ON p.id = up.permission_id
        WHERE up.user_id = ? AND up.is_allowed = 1
      `).all(userId, userId) as Array<{ module: string; action: string }>;
    } catch (e) {
      // If permissions query fails, return empty array (frontend will use fallback)
    }

    return { ...user, permissions };
  }

  static async updateProfile(userId: string | number, data: any, username: string) {
    const { name, email, department, profile_picture } = data;
    await db.prepare("UPDATE users SET name = ?, email = ?, department = ?, profile_picture = ? WHERE id = ?")
      .run(name, email, department, profile_picture, userId);
    
    await AuditChainService.append({
      user: username,
      action: 'Update Profile',
      module: 'Settings',
      details: 'User updated personal profile',
    });
      
    return true;
  }

  static async updatePreferences(userId: string | number, data: any, username: string) {
    const { language, dashboard_layout, notifications_enabled, theme } = data;
    await db.prepare("UPDATE users SET language = ?, dashboard_layout = ?, notifications_enabled = ?, theme = ? WHERE id = ?")
      .run(language, dashboard_layout, notifications_enabled ? 1 : 0, theme || 'light', userId);
    
    await AuditChainService.append({
      user: username,
      action: 'Update Preferences',
      module: 'Settings',
      details: 'User updated preferences',
    });
      
    return true;
  }
}

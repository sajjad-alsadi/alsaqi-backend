import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index';
import { NotFoundError, ConflictError } from '../utils/errors';
import { N8nService } from '../utils/n8nService';
import { UserRole } from '@alsaqi/shared';
import { validatePasswordPolicy } from './passwordPolicy';

/**
 * Maps requested status values that are NOT permitted by the
 * `users.status CHECK (status IN ('Active','Inactive','Suspended'))` constraint
 * onto an equivalent permitted value (Requirement 2.1). Archiving (and the
 * legacy `'Disabled'`) persists as `'Inactive'` — a non-active status that, per
 * the shared blocked-status rule, is blocked from authenticating. This resolves
 * the `'Archived'` write that previously failed with a constraint violation
 * (defect 1.1).
 */
const STATUS_PERSIST_MAP: Record<string, string> = {
  Archived: 'Inactive',
  Disabled: 'Inactive',
};

export class UserService {
  static async getUsers(query: any) {
    const page = parseInt(query.page as string) || 1;
    const pageSize = parseInt(query.pageSize as string) || 10;
    const offset = (page - 1) * pageSize;
    const { search, department, role } = query;

    let whereClause = "";
    const params: any[] = [];

    if (search) {
      whereClause += whereClause ? " AND (u.name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)" : " WHERE (u.name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (department) {
      whereClause += whereClause ? " AND u.department = ?" : " WHERE u.department = ?";
      params.push(department);
    }
    if (role) {
      whereClause += whereClause ? " AND u.role = ?" : " WHERE u.role = ?";
      params.push(role);
    }

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM users u${whereClause}`).get(...params);
    const total = countRes?.total || 0;

    const users = await db.prepare(`
      SELECT u.id, u.username, u.name, u.email, u.department, u.role, u.status, u.last_login, u.employee_id,
             j.name as job_title, r.name as role_name
      FROM users u
      LEFT JOIN job_titles j ON u.job_title_id = j.id
      LEFT JOIN roles r ON u.role_id = r.id
      ${whereClause}
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    return {
      data: users,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  static async getUserSummary() {
    const total = await db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
    const active = await db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'Active'").get() as any;
    const suspended = await db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'Suspended'").get() as any;
    // Archived users persist as 'Inactive' (see STATUS_PERSIST_MAP / setStatus): the
    // users.status CHECK constraint permits only Active/Inactive/Suspended, so an
    // archive request is stored as 'Inactive'. Counting 'Archived' (a value never
    // persisted) always returned 0 (defect 1.21); count the actual persisted
    // status instead (2.21).
    const archived = await db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'Inactive'").get() as any;
    const admins = await db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = ?`).get(UserRole.ADMIN) as any;
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const inactive = await db.prepare("SELECT COUNT(*) as count FROM users WHERE last_login < ? OR last_login IS NULL").get(thirtyDaysAgo.toISOString()) as any;

    return {
      total: total.count,
      active: active.count,
      suspended: suspended.count,
      archived: archived.count,
      admins: admins.count,
      inactive: inactive.count
    };
  }

  static async getUserById(id: string) {
    const user = await db.prepare(`
      SELECT u.id, u.username, u.name, u.email, u.department, u.role, u.status, u.last_login, u.employee_id,
             u.job_title_id, u.role_id, u.unit, u.reporting_manager_id, u.access_scope, u.phone_number, u.notes,
             j.name as job_title, r.name as role_name
      FROM users u
      LEFT JOIN job_titles j ON u.job_title_id = j.id
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = ?
    `).get(id) as any;
    
    if (!user) return null;
    
    const permissions = await db.prepare(`
      SELECT p.module, p.action
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = ?
      UNION
      SELECT p.module, p.action
      FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = ? AND up.is_allowed = 1
      EXCEPT
      SELECT p.module, p.action
      FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = ? AND up.is_allowed = 0
    `).all(user.role_id, user.id, user.id);

    return { ...user, permissions };
  }

  static async createUser(userData: any) {
    const { username, password, name, email, department, job_title_id, role, unit, reporting_manager_id, access_scope, phone_number, notes } = userData;

    // Captured inside the transaction for the post-commit webhook dispatch.
    let createdUserId: any = null;
    let createdEmployeeId: string = '';

    const created = await db.transaction(async () => {
      // Duplicate detection lives in the single creation path (UserService) so both
      // POST /users and POST /auth/register surface the same explicit conflict error
      // identifying the duplicate field (Req 8.6). The message names the field so the
      // Error_Envelope produced by globalErrorHandler tells the client which input clashed.
      const existingUser = await db.prepare("SELECT id FROM users WHERE username = ?").get(username);
      if (existingUser) {
        throw new ConflictError("A user with this username already exists");
      }

      // `email` carries no UNIQUE DB constraint (see database/schema.sql), so an explicit
      // check is required here to reject a duplicate email and identify the field (Req 8.6).
      // Only enforced when an email is provided, and matched case-insensitively since email
      // addresses are case-insensitive in practice.
      if (email) {
        const existingEmail = await db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email);
        if (existingEmail) {
          throw new ConflictError("A user with this email already exists");
        }
      }

      const hashedPassword = bcrypt.hashSync(password, 12);
      const role_id = (await db.prepare("SELECT id FROM roles WHERE name = ?").get(role) as any)?.id;

      let deptCode = 'EMP';
      if (department) {
        try {
          const dept = await db.prepare("SELECT entity_code FROM org_entities WHERE name_ar = ? OR name_en = ?").get(department, department) as any;
          if (dept && dept.entity_code) {
            deptCode = dept.entity_code;
          }
        } catch (e) { }
      }
      
      const latestEmp = await db.prepare("SELECT employee_id FROM users WHERE employee_id LIKE ?").all(`${deptCode}-%`) as Array<{ employee_id: string }>;
      let nextNum = 1001;
      // Compute the next sequential number in JS rather than via a SQL integer
      // cast over a substring of employee_id, which threw an invalid-integer
      // error under Postgres/PGlite once a new-format id like `EMP-1001-A1B2C3`
      // existed (the substring `1001-A1B2C3` cannot cast to an integer) — defect
      // 1.21 → 2.21. The leading segment after the `${deptCode}-` prefix is the
      // sequence number regardless of id format.
      for (const row of latestEmp) {
        if (!row || !row.employee_id) continue;
        const seqPart = row.employee_id.slice(deptCode.length + 1).split('-')[0];
        const lastNum = parseInt(seqPart, 10);
        if (!isNaN(lastNum) && lastNum + 1 > nextNum) nextNum = lastNum + 1;
      }

      // Generate a unique employee_id that incorporates entropy so two concurrent creations
      // reading the SAME stale latest cannot collide on the sequential number (Req 2.18). The
      // `${deptCode}-` prefix and a leading sequential number are preserved; a short random
      // disambiguator is appended after the number.
      const makeEmployeeId = () =>
        `${deptCode}-${nextNum}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      // Require 2FA setup for sensitive roles (Admin, Manager/Audit Manager) per Req 5.9
      const ROLES_REQUIRING_2FA = ['Admin', 'Manager'];
      const requires2faSetup = ROLES_REQUIRING_2FA.includes(role);

      // Insert with retry-on-conflict: `employee_id` is declared UNIQUE, so on the rare chance
      // the generated value collides, regenerate the disambiguator and retry a few times
      // before surfacing the error (Req 2.18).
      let employee_id = makeEmployeeId();
      let result: any;
      const MAX_EMP_ID_ATTEMPTS = 5;
      for (let attempt = 1; ; attempt++) {
        try {
          // Read the new id portably via an explicit `RETURNING id` (not the
          // SQLite-only insert-rowid metadata) so it is defined under
          // Postgres/PGlite (Finding 1.3 → 2.3).
          result = await db.prepare(`
            INSERT INTO users (username, password, name, email, department, job_title_id, role, unit, reporting_manager_id, access_scope, phone_number, notes, role_id, status, created_at, requires_password_change, employee_id, requires_2fa_setup)
            VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::uuid, ?::text, ?::text, ?::uuid, ?::text, ?::text, ?::text, ?::uuid, 'Active', CURRENT_TIMESTAMP, 1, ?::text, ?::boolean) RETURNING id
          `).get(username, hashedPassword, name, email, department || null, job_title_id || null, role, unit || null, reporting_manager_id || null, access_scope || null, phone_number || null, notes || null, role_id, employee_id, requires2faSetup);
          break;
        } catch (insertErr: any) {
          const message = String(insertErr?.message || insertErr || '');
          const isEmployeeIdConflict =
            /employee_id/i.test(message) &&
            /(unique|duplicate|constraint)/i.test(message);
          if (isEmployeeIdConflict && attempt < MAX_EMP_ID_ATTEMPTS) {
            employee_id = makeEmployeeId();
            continue;
          }
          throw insertErr;
        }
      }
      
      createdUserId = result?.id;
      createdEmployeeId = employee_id;

      return { id: result?.id, username, name, email, department, job_title_id, role, status: 'Active', employee_id };
    });

    // --- AUTOMATION: Send event to n8n (after commit, outside transaction) ---
    // External webhooks must never run inside the DB transaction, and a webhook
    // failure must not roll back the already-committed insert (finding 1.14 → 2.14).
    try {
      await N8nService.sendEvent('user.created', {
        userId: createdUserId,
        username,
        name,
        email,
        department,
        role,
        employee_id: createdEmployeeId
      });
    } catch (err) {
      console.error('[Automation Error] Failed to dispatch user.created event:', err);
    }

    return created;
  }

  static async updateUser(id: string, userData: any) {
    const result = await db.transaction(async () => {
      const oldUser = await db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
      if (!oldUser) throw new NotFoundError("User not found");

      const { name, email, department, job_title_id, role, unit, reporting_manager_id, access_scope, phone_number, notes, status, password } = userData;
      const role_id = (await db.prepare("SELECT id FROM roles WHERE name = ?").get(role) as any)?.id;

      if (password) {
        // Enforce the shared, configurable password policy on admin-set passwords so
        // they cannot be weaker than self-service ones (Requirement 2.11).
        await validatePasswordPolicy(password);
        const hashedPassword = bcrypt.hashSync(password, 12);
        await db.prepare(`
          UPDATE users 
          SET name = ?::text, email = ?::text, department = ?::text, job_title_id = ?::uuid, role = ?::text, unit = ?::text, reporting_manager_id = ?::uuid, access_scope = ?::text, phone_number = ?::text, notes = ?::text, role_id = ?::uuid, status = ?::text, password = ?::text, requires_password_change = 1, session_version = session_version + 1
          WHERE id = ?::uuid
        `).run(name, email, department || null, job_title_id || null, role, unit || null, reporting_manager_id || null, access_scope || null, phone_number || null, notes || null, role_id, status || oldUser.status, hashedPassword, id);
      } else {
        await db.prepare(`
          UPDATE users 
          SET name = ?::text, email = ?::text, department = ?::text, job_title_id = ?::uuid, role = ?::text, unit = ?::text, reporting_manager_id = ?::uuid, access_scope = ?::text, phone_number = ?::text, notes = ?::text, role_id = ?::uuid, status = ?::text
          WHERE id = ?::uuid
        `).run(name, email, department || null, job_title_id || null, role, unit || null, reporting_manager_id || null, access_scope || null, phone_number || null, notes || null, role_id, status || oldUser.status, id);
      }

      return { oldUser, role_id };
    });

    // --- AUTOMATION: Send event to n8n (after commit, outside transaction) ---
    // External webhooks must never run inside the DB transaction, and a webhook
    // failure must not roll back the already-committed update (finding 1.14 → 2.14).
    try {
      await N8nService.sendEvent('user.updated', {
        userId: id,
        updates: userData
      });
    } catch (err) {
      console.error('[Automation Error] Failed to dispatch user.updated event:', err);
    }

    return result;
  }

  static async setStatus(id: string, status: string) {
    return await db.transaction(async () => {
      const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
      if (!user) throw new NotFoundError("User not found");
      // Persist a status permitted by the users.status CHECK constraint. A request to
      // archive (or disable) is stored as 'Inactive', which is blocked from authenticating
      // (Requirement 2.1).
      const persistedStatus = STATUS_PERSIST_MAP[status] ?? status;
      await db.prepare(`UPDATE users SET status = ?::text WHERE id = ?::uuid`).run(persistedStatus, id);

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent('user.status_changed', {
        userId: id,
        username: user.username,
        newStatus: persistedStatus
      });

      return user.username;
    });
  }

  static async deleteUser(id: string) {
    return await db.transaction(async () => {
      const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
      if (!user) throw new NotFoundError("User not found");
      
      // Cleanup tokens
      await db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);
      
      await db.prepare(`DELETE FROM users WHERE id = ?`).run(id);

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent('user.deleted', {
        userId: id,
        username: user.username
      });

      return user.username;
    });
  }

  static async unlockUser(id: string) {
    const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
    if (!user) throw new NotFoundError("User not found");
    await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?::uuid").run(id);
    return user.username;
  }

  static async resetPassword(id: string, newPassword: string) {
    const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
    if (!user) throw new NotFoundError("User not found");
    // Enforce the shared, configurable password policy on admin resets (Requirement 2.11).
    await validatePasswordPolicy(newPassword);
    const hashed = bcrypt.hashSync(newPassword, 12);
    await db.prepare(`UPDATE users SET password = ?::text, requires_password_change = 1, session_version = session_version + 1 WHERE id = ?::uuid`).run(hashed, id);
    // Revoke outstanding refresh credentials and active sessions so prior refresh tokens can no
    // longer be exchanged for new access tokens after an admin reset (Req 2.6).
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(id);
    } catch (e) {
      // Ignore if table/columns are unavailable in this environment
    }
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(id);
    return user.username;
  }

  static async getActiveUsers() {
    return await db.prepare(`
      SELECT id, name, username, department, role
      FROM users
      WHERE status = 'Active'
    `).all();
  }

  static async logPermissionChange(targetUserId: string, changedById: string, oldRole: string, newRole: string, reason: string) {
    await db.prepare("INSERT INTO permission_change_logs (target_user_id, changed_by_id, old_role, new_role, reason) VALUES (?::uuid, ?::uuid, ?::text, ?::text, ?::text)")
      .run(targetUserId, changedById, oldRole, newRole, reason);
  }

  static async getStatus(id: string) {
    const user = await db.prepare("SELECT status FROM users WHERE id = ?").get(id) as any;
    if (!user) throw new NotFoundError("User not found");
    return user.status;
  }

  static async activateUser(id: string) {
    const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
    if (!user) throw new NotFoundError("User not found");
    await db.prepare("UPDATE users SET status = 'Active', failed_attempts = 0, locked_until = NULL WHERE id = ?::uuid").run(id);
    return user.username;
  }

  static async getInitData() {
    const summary = await this.getUserSummary();
    
    // Roles
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

    // Permissions
    const permissions = await db.prepare("SELECT * FROM permissions ORDER BY module, action").all();

    // Sessions
    // Project only non-sensitive display columns and exclude sensitive token columns
    // (refresh_token, session_token) so init data never leaks credentials (Req 2.25).
    const sessions = await db.prepare(`
      SELECT s.id, s.user_id, s.login_time, s.last_activity, s.status, s.ip_address, s.device, s.browser,
             u.name as user_name, u.username
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.status = 'Active'
      ORDER BY s.last_activity DESC
    `).all();

    // Settings
    const settings = await db.prepare("SELECT * FROM user_management_settings WHERE id = 1").get();

    // Login History (page 1) initialized as empty (Lazy Loaded later)
    const loginHistoryCountRes = await db.prepare(`SELECT COUNT(*) as total FROM login_history`).get();
    const loginHistoryTotal = loginHistoryCountRes?.total || 0;
    const loginHistory: any[] = [];

    // Audit Trail (page 1) initialized as empty (Lazy Loaded later)
    const auditTrailCountRes = await db.prepare(`SELECT COUNT(*) as total FROM audit_trail`).get();
    const auditTrailTotal = auditTrailCountRes?.total || 0;
    const auditTrail: any[] = [];

    // Reset Requests
    const resetRequests = await db.prepare(`
      SELECT * FROM password_reset_requests WHERE status = 'Pending' ORDER BY request_date DESC
    `).all();

    // Departments
    const departments = await db.prepare(`SELECT * FROM departments`).all();

    // Job Titles
    const jobTitles = await db.prepare(`SELECT * FROM job_titles`).all();

    // Users (page 1)
    const usersResult = await this.getUsers({ page: 1, pageSize: 10 });

    return {
      summary,
      roles: rolesWithPermissions,
      permissions,
      sessions,
      settings,
      loginHistory: {
        data: loginHistory,
        pagination: { page: 1, pageSize: 50, total: loginHistoryTotal, totalPages: Math.ceil(loginHistoryTotal / 50) }
      },
      auditTrail: {
        data: auditTrail,
        pagination: { page: 1, pageSize: 50, total: auditTrailTotal, totalPages: Math.ceil(auditTrailTotal / 50) }
      },
      resetRequests,
      departments,
      jobTitles,
      users: usersResult
    };
  }
}

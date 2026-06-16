import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/index';
import { NotFoundError, ValidationError, AuthError } from '../utils/errors';
import { invalidateUserCache } from '../middleware/auth';
import { UserRole } from '@alsaqi/shared';
import { validatePasswordPolicy } from './passwordPolicy';

export class PasswordService {
  static async requestReset(username: string) {
    const user = await db.prepare("SELECT id, username, name, department FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)").get(username, username) as any;
    
    if (!user) {
      return { success: true, message: "If the username exists, a request has been sent to the administrator." };
    }

    const existing = await db.prepare("SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'Pending'").get(user.id);
    if (existing) {
      return { success: true, message: "A request is already pending." };
    }

    await db.prepare(`INSERT INTO password_reset_requests (user_id, username, name, department) VALUES (?::uuid, ?::text, ?::text, ?::text)`)
      .run(user.id, user.username, user.name, user.department);
    
    const admins = await db.prepare(`SELECT id FROM users WHERE role = ?`).all(UserRole.ADMIN) as {id: number}[];
    const alertMsg = `Password Reset Request\nUsername: ${user.username}\nName: ${user.name}\nDepartment: ${user.department || 'N/A'}`;
    
    return {
      success: true,
      user,
      admins,
      alertMsg
    };
  }

  static async getResetStatus(username: string) {
    const user = await db.prepare("SELECT id, requires_password_change FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)").get(username, username) as any;
    if (!user) return 'None';

    // Use a robust truthiness check: `requires_password_change` may be stored as a boolean
    // (false) or a number (0). A strict `=== 0` comparison misses the boolean case, so treat
    // any falsy value as "no password change required".
    if (!user.requires_password_change) return 'None';

    const request = await db.prepare("SELECT status FROM password_reset_requests WHERE user_id = ? ORDER BY request_date DESC LIMIT 1").get(user.id) as any;
    if (!request) return 'None';

    return request.status;
  }

  static async approveReset(requestId: string, adminId: string) {
    const request = await db.prepare("SELECT * FROM password_reset_requests WHERE id = ?").get(requestId) as any;
    
    if (!request) {
      throw new NotFoundError("Request not found");
    }

    const tempPass = crypto.randomBytes(18).toString('base64url') + "!";
    const hashedTemp = await bcrypt.hash(tempPass, 12);

    await db.prepare("UPDATE users SET password = ?::text, requires_password_change = 1, failed_attempts = 0, locked_until = NULL, session_version = session_version + 1 WHERE id = ?::uuid")
      .run(hashedTemp, request.user_id);

    // Revoke outstanding refresh credentials and active sessions so prior refresh tokens can no
    // longer be exchanged for new access tokens after an admin reset (Req 2.6).
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(request.user_id);
    } catch (e) {
      // Ignore if table/columns are unavailable in this environment
    }
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(request.user_id);

    await db.prepare("UPDATE password_reset_requests SET status = 'Approved', resolved_date = CURRENT_TIMESTAMP, resolved_by = ?::uuid WHERE id = ?::uuid")
      .run(adminId, requestId);

    return {
      tempPassword: tempPass,
      username: request.username,
      userId: request.user_id
    };
  }

  static async changePassword(userId: string, newPassword: string) {
    const user = await db.prepare("SELECT id, password, session_version, username, role FROM users WHERE id = ?").get(userId) as any;

    if (!user) throw new NotFoundError("User not found");

    // Validate password against policy settings (shared, centralized policy)
    await validatePasswordPolicy(newPassword);

    if (await bcrypt.compare(newPassword, user.password)) {
      throw new ValidationError("New password cannot be the same as the current password");
    }

    const history = await db.prepare("SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(user.id) as { password_hash: string }[];
    
    for (const record of history) {
      if (await bcrypt.compare(newPassword, record.password_hash)) {
        throw new ValidationError("Password has been used previously. Please choose a different one.");
      }
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    
    await db.transaction(async () => {
      await db.prepare("INSERT INTO password_history (user_id, password_hash) VALUES (?::uuid, ?::text)").run(user.id, user.password);
      await db.prepare("UPDATE users SET password = ?::text, password_last_changed = CURRENT_TIMESTAMP, requires_password_change = 0, session_version = session_version + 1 WHERE id = ?::uuid").run(hashed, user.id);
    });
    
    // Revoke outstanding refresh credentials and terminate active sessions so prior refresh
    // tokens can no longer be exchanged for new access tokens after a password change. Mirrors
    // approveReset; bumping session_version alone is not enough for full session lifecycle (Req 2.4).
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(user.id);
    } catch (e) {
      // Ignore if table/columns are unavailable in this environment
    }
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(user.id);
    
    // Invalidate cached user data so middleware picks up new session_version
    await invalidateUserCache(user.id);
    
    const updatedUser = await db.prepare("SELECT id, username, role, session_version FROM users WHERE id = ?").get(user.id) as any;
    return updatedUser;
  }

  static async updatePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await db.prepare("SELECT id, password, username, role FROM users WHERE id = ?").get(userId) as any;
    
    if (!user) throw new NotFoundError("User not found");

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new AuthError("Incorrect current password");
    }

    if (currentPassword === newPassword) {
      throw new ValidationError("New password cannot be the same as the current password");
    }

    // Validate password against policy settings (shared, centralized policy)
    await validatePasswordPolicy(newPassword);

    const history = await db.prepare("SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(user.id) as { password_hash: string }[];
    
    for (const record of history) {
      if (await bcrypt.compare(newPassword, record.password_hash)) {
        throw new ValidationError("Password has been used previously. Please choose a different one.");
      }
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    
    await db.transaction(async () => {
      await db.prepare("INSERT INTO password_history (user_id, password_hash) VALUES (?::uuid, ?::text)").run(user.id, user.password);
      await db.prepare("UPDATE users SET password = ?::text, password_last_changed = CURRENT_TIMESTAMP, requires_password_change = 0, session_version = session_version + 1 WHERE id = ?::uuid").run(hashed, user.id);
    });
    
    // Revoke outstanding refresh credentials and terminate active sessions so prior refresh
    // tokens can no longer be exchanged for new access tokens after a password change. Mirrors
    // approveReset; bumping session_version alone is not enough for full session lifecycle (Req 2.4).
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(user.id);
    } catch (e) {
      // Ignore if table/columns are unavailable in this environment
    }
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(user.id);
    
    // Invalidate cached user data so middleware picks up new session_version
    await invalidateUserCache(user.id);
    
    const updatedUser = await db.prepare("SELECT id, username, role, session_version FROM users WHERE id = ?").get(user.id) as any;
    return updatedUser;
  }

  static async getResetRequests() {
    return await db.prepare("SELECT * FROM password_reset_requests WHERE status = 'Pending' ORDER BY request_date DESC").all();
  }
}

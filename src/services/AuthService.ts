import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/index';
import { AuthError, ForbiddenError } from '../utils/errors';
import { UserRole } from '@alsaqi/shared';

export class AuthService {
  static async login(usernameOrEmail: string, password: string, jwtSecret: string, JWT_PRIVATE_KEY: string, ipAddress?: string, userAgent?: string, rememberMe?: boolean) {
    return await db.transaction(async () => {
      // Support login by username or email, case-insensitive
      const user = await db.prepare(`
        SELECT * FROM users 
        WHERE LOWER(username) = LOWER(?::text) OR LOWER(email) = LOWER(?::text)
      `).get(usernameOrEmail, usernameOrEmail) as any;
      
      if (!user) {
        console.warn(`[AuthService] Login failed: User not found for "${usernameOrEmail}"`);
        throw new AuthError("Invalid credentials");
      }

      if (user.status === 'Suspended') {
        console.warn(`[AuthService] Login failed: Account suspended for "${user.username}"`);
        throw new ForbiddenError("Account suspended");
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        console.warn(`[AuthService] Login failed: Account locked for "${user.username}"`);
        throw new ForbiddenError("Account locked");
      }

      if (!bcrypt.compareSync(password, user.password)) {
        console.warn(`[AuthService] Login failed: Invalid password for "${user.username}"`);
        await db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?::uuid").run(user.id);
        
        // Read threshold from settings (default 5 if not configured)
        let lockThreshold = 5;
        try {
          const settings = await db.prepare("SELECT failed_login_threshold FROM user_management_settings WHERE id = 1").get() as any;
          if (settings?.failed_login_threshold) lockThreshold = settings.failed_login_threshold;
        } catch (e) { /* use default */ }
        
        if (user.failed_attempts + 1 >= lockThreshold) {
          await db.prepare("UPDATE users SET locked_until = ?::timestamp WHERE id = ?::uuid").run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), user.id);
          
          // Notify all admins about the locked account
          try {
            const admins = await db.prepare(`SELECT id FROM users WHERE role = '${UserRole.ADMIN}' AND status = 'active'`).all() as any[];
            for (const admin of admins) {
              await db.prepare("INSERT INTO notifications (user_id, event_type, description, related_module, link, status, actor_id, entity_type) VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Unread', ?::uuid, 'user')")
                .run(admin.id, 'account_locked', `Account "${user.username}" locked after 5 failed login attempts (IP: ${ipAddress || 'Unknown'})`, 'Security', '/users', user.id);
            }
          } catch (notifErr) {
            console.error("[AuthService] Failed to send lockout notification:", notifErr);
          }
        }
        throw new AuthError("Invalid credentials");
      }

      await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = CURRENT_TIMESTAMP WHERE id = ?::uuid").run(user.id);

      // Check password expiry
      let requiresPasswordChange = !!user.requires_password_change;
      if (!requiresPasswordChange && user.password_last_changed) {
        try {
          const settings = await db.prepare("SELECT password_expiry_days FROM user_management_settings WHERE id = 1").get() as any;
          const expiryDays = settings?.password_expiry_days || 90;
          if (expiryDays > 0) {
            const lastChanged = new Date(user.password_last_changed);
            const daysSinceChange = Math.floor((Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24));
            if (daysSinceChange >= expiryDays) {
              requiresPasswordChange = true;
              // Mark in DB so middleware also blocks
              await db.prepare("UPDATE users SET requires_password_change = 1 WHERE id = ?::uuid").run(user.id);
            }
          }
        } catch (e) {
          // If settings table doesn't exist or query fails, skip expiry check
          console.error("[AuthService] Password expiry check failed:", e);
        }
      }

      // Log login history
      try {
        await db.prepare("INSERT INTO login_history (user_id, ip_address, user_agent, status) VALUES (?::uuid, ?::text, ?::text, 'Success')")
          .run(user.id, ipAddress || 'Unknown', userAgent || 'Unknown');
      } catch (e) {
        console.error("[AuthService] Failed to log login history", e);
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '15m' }
      );

      const refreshToken = jwt.sign(
        { id: user.id, username: user.username, role: user.role, session_version: user.session_version, rememberMe: !!rememberMe },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: rememberMe ? '30d' : '8h' }
      );
      const sessionToken = crypto.randomBytes(64).toString('hex');
      
      const refreshExpiry = rememberMe ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : new Date(Date.now() + 8 * 60 * 60 * 1000); // 30 days or 8 hours
      // Insert into refresh_tokens for compatibility
      await db.prepare("INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?::text, ?::uuid, ?::timestamp)").run(refreshToken, user.id, refreshExpiry.toISOString());
      
      // Insert into user_sessions for session management
      try {
        await db.prepare(`
          INSERT INTO user_sessions (user_id, session_token, refresh_token, ip_address, browser, status)
          VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Active')
        `).run(user.id, sessionToken, refreshToken, ipAddress || 'Unknown', userAgent || 'Unknown');
      } catch (e) {
        console.error("[AuthService] Failed to create user session", e);
      }

      // Fetch user permissions from DB (role_permissions + user_permissions)
      let permissions: Array<{ module: string; action: string }> = [];
      try {
        permissions = await db.prepare(`
          SELECT p.module, p.action FROM permissions p
          JOIN role_permissions rp ON p.id = rp.permission_id
          WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?::uuid)
          UNION
          SELECT p.module, p.action FROM permissions p
          JOIN user_permissions up ON p.id = up.permission_id
          WHERE up.user_id = ?::uuid AND up.is_allowed = 1
        `).all(user.id, user.id) as Array<{ module: string; action: string }>;
      } catch (e) {
        console.error("[AuthService] Failed to fetch permissions during login:", e);
      }

      return {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          name: user.name,
          requires_password_change: requiresPasswordChange,
          permissions
        },
        token,
        refreshToken
      };
    });
  }

  static async logAudit(username: string, action: string, module: string, details: string) {
    const timestamp = new Date().toISOString();
    
    // Hash chaining for tamper-evident audit trail
    let previousHash = '0';
    try {
      const lastRecord = await db.prepare("SELECT hash FROM audit_trail WHERE hash IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get() as any;
      if (lastRecord?.hash) {
        previousHash = lastRecord.hash;
      }
    } catch (e) {
      // If hash column doesn't exist yet, continue without it
    }
    
    const recordData = `${previousHash}|${username}|${action}|${module}|${details}|${timestamp}`;
    const hash = crypto.createHash('sha256').update(recordData).digest('hex');
    
    await db.prepare("INSERT INTO audit_trail (\"user\", action, module, details, hash, previous_hash, timestamp) VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::timestamp)")
      .run(username, action, module, details, hash, previousHash, timestamp);
  }
}

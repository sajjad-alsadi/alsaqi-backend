import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/index';
import { InvalidCredentialsError } from '../utils/errors';
import { UserRole } from '@alsaqi/shared';
import { AuditChainService } from './AuditChainService';
import { verifyPassword, DUMMY_HASH } from './passwordVerifier';
import { hashRefreshToken } from './refreshTokenHash';

export class AuthService {
  static async login(usernameOrEmail: string, password: string, jwtSecret: string, JWT_PRIVATE_KEY: string, ipAddress?: string, userAgent?: string, rememberMe?: boolean) {
    // Carries a wrong-password user out of the login transaction so the lockout
    // side-effects (failed-attempt counter, lockout state, admin notifications) can be
    // applied AFTER the transaction has rolled back. The login transaction always rolls
    // back on the generic failure throw, so performing these writes inside it would discard
    // the lockout state. Applying them outside the rolled-back transaction preserves the
    // lockout state independently (Req 8.5).
    let pendingFailedLogin: { user: any } | null = null;

    try {
      return await db.transaction(async () => {
      // Support login by username or email, case-insensitive
      const user = await db.prepare(`
        SELECT * FROM users 
        WHERE LOWER(username) = LOWER(?::text) OR LOWER(email) = LOWER(?::text)
      `).get(usernameOrEmail, usernameOrEmail) as any;

      // Anti-enumeration / non-blocking verification (Req 14.1, 14.2, 15.1):
      // ALWAYS run one asynchronous bcrypt comparison, even for unknown accounts.
      // Unknown accounts are compared against DUMMY_HASH (same cost factor) so the work
      // performed — and therefore the response timing — matches a real verification and
      // does not reveal whether the account exists.
      let passwordMatches = false;
      try {
        passwordMatches = await verifyPassword(password, user ? user.password : DUMMY_HASH);
      } catch (verifyErr) {
        // The asynchronous bcrypt comparison rejected/threw (Req 14.5, 15.5):
        // surface the same generic failure without revealing account existence and
        // without crashing the process. Throwing here causes the enclosing
        // db.transaction to ROLLBACK so no partial changes are persisted.
        console.error('[AuthService] Password verification failed:', verifyErr);
        throw new InvalidCredentialsError();
      }

      // Unknown account: a dummy comparison has already run above for timing safety.
      // Return the single generic failure response (Req 15.2, 15.3).
      if (!user) {
        console.warn(`[AuthService] Login failed: User not found for "${usernameOrEmail}"`);
        throw new InvalidCredentialsError();
      }

      if (user.status === 'Suspended') {
        console.warn(`[AuthService] Login failed: Account suspended for "${user.username}"`);
        throw new InvalidCredentialsError();
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        console.warn(`[AuthService] Login failed: Account locked for "${user.username}"`);
        throw new InvalidCredentialsError();
      }

      if (!passwordMatches) {
        console.warn(`[AuthService] Login failed: Invalid password for "${user.username}"`);
        // Defer the server-side lockout side-effects (failed-attempt counter, lockout state,
        // admin notifications) until AFTER this transaction rolls back, so the lockout state
        // is preserved independently of the generic-failure rollback (Req 8.5). None of these
        // change the client-visible response, which remains the single generic failure
        // (Req 15.2, 15.3).
        pendingFailedLogin = { user };
        throw new InvalidCredentialsError();
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

      // Refresh-token hashing at rest (Req 17.1, 17.5): persist only the SHA-256 hash of the
      // refresh token, never the plaintext. Compute the hash BEFORE any persistence so that a
      // hashing failure aborts persistence (the throw rolls back this transaction) without ever
      // storing the plaintext token.
      const refreshTokenHash = hashRefreshToken(refreshToken);

      // Insert into refresh_tokens for compatibility (hash only)
      await db.prepare("INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?::text, ?::uuid, ?::timestamp)").run(refreshTokenHash, user.id, refreshExpiry.toISOString());
      
      // Insert into user_sessions for session management (hash only)
      try {
        await db.prepare(`
          INSERT INTO user_sessions (user_id, session_token, refresh_token, ip_address, browser, status)
          VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Active')
        `).run(user.id, sessionToken, refreshTokenHash, ipAddress || 'Unknown', userAgent || 'Unknown');
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
    } catch (err) {
      // The login transaction has now rolled back. If the failure was a wrong password,
      // apply the lockout side-effects OUTSIDE the rolled-back transaction so the lockout
      // state persists (Req 8.5). The generic failure is then re-thrown unchanged so the
      // client-visible response is identical across all failure conditions (Req 15.2, 15.3).
      if (pendingFailedLogin) {
        await AuthService.handleFailedLogin(pendingFailedLogin.user, ipAddress);
      }
      throw err;
    }
  }

  /**
   * Records a failed-login attempt and, when the configured threshold is reached, locks the
   * account and notifies administrators. This runs OUTSIDE the login transaction (which has
   * already rolled back) so its writes are durable. The lockout state (`locked_until`) is
   * committed before any notification write is attempted, so a later notification failure
   * cannot discard the lockout (Req 8.5).
   */
  private static async handleFailedLogin(user: any, ipAddress?: string): Promise<void> {
    // Count the failed attempt (standalone, auto-committed statement).
    await db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?::uuid").run(user.id);

    // Read threshold from settings (default 5 if not configured).
    let lockThreshold = 5;
    try {
      const settings = await db.prepare("SELECT failed_login_threshold FROM user_management_settings WHERE id = 1").get() as any;
      if (settings?.failed_login_threshold) lockThreshold = settings.failed_login_threshold;
    } catch (e) { /* use default */ }

    if (user.failed_attempts + 1 >= lockThreshold) {
      // Commit the lockout state first and independently, so it is preserved even if the
      // subsequent notification transaction fails and rolls back (Req 8.5).
      await db.prepare("UPDATE users SET locked_until = ?::timestamp WHERE id = ?::uuid")
        .run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), user.id);

      await AuthService.notifyAdminsOfLockout(user, ipAddress);
    }
  }

  /**
   * Creates exactly one notification row for each active administrator about a locked account
   * (Req 8.1, 8.3). The administrator role is supplied as a bound query parameter rather than
   * by string interpolation (Req 8.2). All notification inserts for one lockout event run in a
   * single transaction so that, if any insert fails, ALL notification rows for that event are
   * rolled back; the previously committed lockout state is left intact and an error identifying
   * the lockout event is recorded (Req 8.5). When no active administrator exists, zero rows are
   * persisted and the operation completes without raising an error (Req 8.4).
   */
  private static async notifyAdminsOfLockout(user: any, ipAddress?: string): Promise<void> {
    try {
      await db.transaction(async () => {
        const admins = await db.prepare(
          "SELECT id FROM users WHERE role = ?::text AND status = 'Active'"
        ).all(UserRole.ADMIN) as Array<{ id: string }>;

        for (const admin of admins) {
          await db.prepare(
            "INSERT INTO notifications (user_id, event_type, description, related_module, link, status, actor_id, entity_type) VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, 'Unread', ?::uuid, 'user')"
          ).run(
            admin.id,
            'account_locked',
            `Account "${user.username}" locked after ${user.failed_attempts + 1} failed login attempts (IP: ${ipAddress || 'Unknown'})`,
            'Security',
            '/users',
            user.id
          );
        }
      });
    } catch (notifErr) {
      // Persisting one or more notification rows failed: the transaction above rolled back ALL
      // notification rows for this lockout event, while the lockout state committed earlier in
      // handleFailedLogin is preserved. Record an error identifying the affected lockout event
      // (Req 8.5).
      console.error(
        `[AuthService] Failed to persist lockout notifications for locked account ${user.id} ("${user.username}"); all notification rows for this lockout event were rolled back, lockout state preserved:`,
        notifErr
      );
    }
  }

  /**
   * Appends an audit-trail entry. Delegates to the single canonical hash-chain
   * writer, {@link AuditChainService.append} (Requirement 7.1, 27.1, 27.4) —
   * the duplicated inline hash-chain writer that previously lived here has been
   * removed so exactly one audit-append implementation remains. The original
   * caller-facing behavior (a write failure propagates to the caller) is
   * preserved by not swallowing the error here.
   */
  static async logAudit(username: string, action: string, module: string, details: string) {
    await AuditChainService.append({ user: username, action, module, details });
  }
}

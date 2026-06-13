import { db } from '../db/index';
import { AuthError } from '../utils/errors';
import jwt from 'jsonwebtoken';
import { hashRefreshToken, hashPresentedRefreshToken } from './refreshTokenHash';

export class SessionService {
  static async getActiveSessions() {
    return await db.prepare(`
      SELECT s.*, u.name as user_name, u.username
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.status = 'Active'
      ORDER BY s.last_activity DESC
    `).all();
  }

  static async terminateSession(id: string | number) {
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE id = ?").run(id);
    return true;
  }

  static async refresh(refreshToken: string, JWT_SECRET: string, JWT_PRIVATE_KEY: string) {
    // Reject absent/empty/over-length presented tokens WITHOUT hashing (Req 17.4).
    const presentedHash = hashPresentedRefreshToken(refreshToken);
    if (presentedHash === null) {
      throw new AuthError("Invalid session");
    }

    // Validation hashes the presented token and looks up by the stored hash for an exact,
    // full-length match (Req 17.2). A non-matching hash leaves session state unchanged and
    // rejects the refresh without issuing new tokens (Req 17.3).
    const session = await db.prepare("SELECT * FROM user_sessions WHERE refresh_token = ? AND status = 'Active'").get(presentedHash) as any;
    if (!session) throw new AuthError("Invalid session");

    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as any;
    if (!user) throw new AuthError("User not found");

    let decodedToken: any = {};
    try {
      decodedToken = jwt.decode(refreshToken) || {};
    } catch (e) {}

    const rememberMe = !!decodedToken.rememberMe;

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, session_version: user.session_version }, JWT_PRIVATE_KEY, { algorithm: 'RS256', expiresIn: '15m' });
    const newRefreshToken = jwt.sign({ id: user.id, rememberMe }, JWT_PRIVATE_KEY, { algorithm: 'RS256', expiresIn: rememberMe ? '30d' : '8h' });

    // Persist only the hash of the rotated refresh token at rest (Req 17.1, 17.5). Compute the
    // hash before any write so a hashing failure aborts persistence without storing plaintext.
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

    // Update both tables for compatibility (hash only)
    await db.prepare("UPDATE user_sessions SET refresh_token = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?").run(newRefreshTokenHash, session.id);
    
    const refreshExpiry = rememberMe ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : new Date(Date.now() + 8 * 60 * 60 * 1000); // 30 days or 8 hours
    
    try {
      await db.prepare("UPDATE refresh_tokens SET token = ?, expires_at = ? WHERE token = ?").run(
        newRefreshTokenHash, 
        refreshExpiry.toISOString(),
        presentedHash
      );
    } catch (e) {
      // Ignore
    }

    return {
      token,
      refreshToken: newRefreshToken,
      user,
      expiresAt: refreshExpiry,
      rememberMe
    };
  }

  static async logout(refreshToken: string) {
    // Look up by hash, not plaintext (Req 17.1, 17.2). Absent/empty/over-length tokens are
    // rejected without hashing (Req 17.4) and simply result in no session being found.
    const presentedHash = hashPresentedRefreshToken(refreshToken);
    if (presentedHash === null) {
      return null;
    }

    const session = await db.prepare("SELECT user_id FROM user_sessions WHERE refresh_token = ?").get(presentedHash) as any;
    
    // Also revoke in refresh_tokens table for compatibility
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE token = ?").run(presentedHash);
    } catch (e) {
      // Ignore if table doesn't exist or other issues
    }

    if (session) {
      const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(session.user_id) as any;
      await db.prepare("UPDATE user_sessions SET status = 'LoggedOut' WHERE refresh_token = ?").run(presentedHash);
      return user?.username;
    }
    return null;
  }

  static async logoutAll(userId: string | number) {
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(userId);
    return true;
  }
}

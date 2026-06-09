import { db } from '../db/index';
import { AuthError } from '../utils/errors';
import jwt from 'jsonwebtoken';

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
    const session = await db.prepare("SELECT * FROM user_sessions WHERE refresh_token = ? AND status = 'Active'").get(refreshToken) as any;
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

    // Update both tables for compatibility
    await db.prepare("UPDATE user_sessions SET refresh_token = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?").run(newRefreshToken, session.id);
    
    const refreshExpiry = rememberMe ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : new Date(Date.now() + 8 * 60 * 60 * 1000); // 30 days or 8 hours
    
    try {
      await db.prepare("UPDATE refresh_tokens SET token = ?, expires_at = ? WHERE token = ?").run(
        newRefreshToken, 
        refreshExpiry.toISOString(),
        refreshToken
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
    const session = await db.prepare("SELECT user_id FROM user_sessions WHERE refresh_token = ?").get(refreshToken) as any;
    
    // Also revoke in refresh_tokens table for compatibility
    try {
      await db.prepare("UPDATE refresh_tokens SET is_revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE token = ?").run(refreshToken);
    } catch (e) {
      // Ignore if table doesn't exist or other issues
    }

    if (session) {
      const user = await db.prepare("SELECT username FROM users WHERE id = ?").get(session.user_id) as any;
      await db.prepare("UPDATE user_sessions SET status = 'LoggedOut' WHERE refresh_token = ?").run(refreshToken);
      return user?.username;
    }
    return null;
  }

  static async logoutAll(userId: string | number) {
    await db.prepare("UPDATE user_sessions SET status = 'Terminated' WHERE user_id = ? AND status = 'Active'").run(userId);
    return true;
  }
}

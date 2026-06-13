// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock references that can be used in vi.mock factories
const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
}));

const { mockSign, mockDecode, mockVerify } = vi.hoisted(() => ({
  mockSign: vi.fn(),
  mockDecode: vi.fn(),
  mockVerify: vi.fn(),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
  },
}));

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (...args: any[]) => mockSign(...args),
    decode: (...args: any[]) => mockDecode(...args),
    verify: (...args: any[]) => mockVerify(...args),
  },
}));

import { SessionService } from '../SessionService';
import { AuthError } from '../../utils/errors';
import { hashRefreshToken } from '../refreshTokenHash';

describe('SessionService', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;
  let mockRun: ReturnType<typeof vi.fn>;

  const JWT_SECRET = 'test-jwt-secret';
  const JWT_PRIVATE_KEY = 'test-private-key';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn();
    mockAll = vi.fn();
    mockRun = vi.fn();
    mockPrepare.mockReturnValue({
      get: mockGet,
      all: mockAll,
      run: mockRun,
    });
  });

  // ─── refresh ─────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    const mockSession = {
      id: 'session-1',
      user_id: 'user-1',
      refresh_token: 'old-refresh-token',
      status: 'Active',
    };

    const mockUser = {
      id: 'user-1',
      username: 'testuser',
      role: 'Auditor',
      session_version: 1,
    };

    it('returns new token and refreshToken when valid refresh token is provided', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession) // session lookup
        .mockResolvedValueOnce(mockUser); // user lookup
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue({ rememberMe: false });
      mockSign
        .mockReturnValueOnce('new-access-token') // access token
        .mockReturnValueOnce('new-refresh-token'); // refresh token

      const result = await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      expect(result.token).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.user).toEqual(mockUser);
    });

    it('rotates the old refresh token (updates session with new token)', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockUser);
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue({ rememberMe: false });
      mockSign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');

      await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      // Should update user_sessions with new refresh token (hash stored at rest, Req 17.1)
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_sessions SET refresh_token')
      );
      expect(mockRun).toHaveBeenCalledWith(hashRefreshToken('new-refresh-token'), mockSession.id);

      // Should update refresh_tokens table with new token
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE refresh_tokens SET token')
      );
    });

    it('throws AuthError when refresh token is not found in DB (invalid session)', async () => {
      mockGet.mockResolvedValueOnce(null); // no session found

      await expect(
        SessionService.refresh('nonexistent-token', JWT_SECRET, JWT_PRIVATE_KEY)
      ).rejects.toThrow(AuthError);

      await expect(
        SessionService.refresh('nonexistent-token', JWT_SECRET, JWT_PRIVATE_KEY)
      ).rejects.toThrow('Invalid session');
    });

    it('throws AuthError when user is not found', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession) // session found
        .mockResolvedValueOnce(null); // user not found

      await expect(
        SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY)
      ).rejects.toThrow(AuthError);

      // Reset mocks for second assertion
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(null);

      await expect(
        SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY)
      ).rejects.toThrow('User not found');
    });

    it('preserves rememberMe=true setting from original token (30d expiry)', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockUser);
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue({ rememberMe: true });
      mockSign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');

      const result = await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      expect(result.rememberMe).toBe(true);
      // Refresh token should be signed with 30d expiry
      expect(mockSign).toHaveBeenCalledWith(
        { id: mockUser.id, rememberMe: true },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '30d' }
      );
    });

    it('preserves rememberMe=false setting from original token (8h expiry)', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockUser);
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue({ rememberMe: false });
      mockSign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');

      const result = await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      expect(result.rememberMe).toBe(false);
      // Refresh token should be signed with 8h expiry
      expect(mockSign).toHaveBeenCalledWith(
        { id: mockUser.id, rememberMe: false },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '8h' }
      );
    });

    it('signs access token with user id, username, role, and session_version', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockUser);
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue({ rememberMe: false });
      mockSign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');

      await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      expect(mockSign).toHaveBeenCalledWith(
        {
          id: mockUser.id,
          username: mockUser.username,
          role: mockUser.role,
          session_version: mockUser.session_version,
        },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '15m' }
      );
    });

    it('handles decode returning null gracefully (defaults rememberMe to false)', async () => {
      mockGet
        .mockResolvedValueOnce(mockSession)
        .mockResolvedValueOnce(mockUser);
      mockRun.mockResolvedValue({ changes: 1 });
      mockDecode.mockReturnValue(null); // decode returns null
      mockSign
        .mockReturnValueOnce('new-access-token')
        .mockReturnValueOnce('new-refresh-token');

      const result = await SessionService.refresh('old-refresh-token', JWT_SECRET, JWT_PRIVATE_KEY);

      expect(result.rememberMe).toBe(false);
      // Should use 8h expiry (non-rememberMe)
      expect(mockSign).toHaveBeenCalledWith(
        { id: mockUser.id, rememberMe: false },
        JWT_PRIVATE_KEY,
        { algorithm: 'RS256', expiresIn: '8h' }
      );
    });
  });

  // ─── logout ──────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('revokes the refresh token and returns the username', async () => {
      const mockSessionRow = { user_id: 'user-1' };
      const mockUserRow = { username: 'testuser' };

      mockGet
        .mockResolvedValueOnce(mockSessionRow) // session lookup
        .mockResolvedValueOnce(mockUserRow); // user lookup
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.logout('valid-refresh-token');

      expect(result).toBe('testuser');
      // Should update user_sessions status to LoggedOut
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'LoggedOut'")
      );
      // Lookup/update use the token HASH, never the plaintext (Req 17.1, 17.2)
      expect(mockRun).toHaveBeenCalledWith(hashRefreshToken('valid-refresh-token'));
    });

    it('revokes the token in refresh_tokens table for compatibility', async () => {
      const mockSessionRow = { user_id: 'user-1' };
      const mockUserRow = { username: 'testuser' };

      mockGet
        .mockResolvedValueOnce(mockSessionRow)
        .mockResolvedValueOnce(mockUserRow);
      mockRun.mockResolvedValue({ changes: 1 });

      await SessionService.logout('valid-refresh-token');

      // Should also revoke in refresh_tokens table
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE refresh_tokens SET is_revoked = 1')
      );
    });

    it('returns null when no session is found for the refresh token', async () => {
      mockGet.mockResolvedValueOnce(null); // no session found
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.logout('unknown-token');

      expect(result).toBeNull();
    });

    it('returns null when session exists but user is not found', async () => {
      const mockSessionRow = { user_id: 'user-1' };

      mockGet
        .mockResolvedValueOnce(mockSessionRow) // session found
        .mockResolvedValueOnce(null); // user not found
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.logout('valid-refresh-token');

      // user?.username returns undefined, which is falsy
      expect(result).toBeUndefined();
    });
  });

  // ─── logoutAll ───────────────────────────────────────────────────────────────

  describe('logoutAll', () => {
    it('terminates all active user sessions', async () => {
      mockRun.mockResolvedValue({ changes: 3 });

      const result = await SessionService.logoutAll('user-1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE user_sessions SET status = 'Terminated'")
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE user_id = ? AND status = 'Active'")
      );
      expect(mockRun).toHaveBeenCalledWith('user-1');
    });

    it('returns true even when no active sessions exist', async () => {
      mockRun.mockResolvedValue({ changes: 0 });

      const result = await SessionService.logoutAll('user-no-sessions');

      expect(result).toBe(true);
    });

    it('works with numeric userId', async () => {
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.logoutAll(42);

      expect(result).toBe(true);
      expect(mockRun).toHaveBeenCalledWith(42);
    });
  });

  // ─── getActiveSessions ───────────────────────────────────────────────────────

  describe('getActiveSessions', () => {
    it('returns all active sessions with user info', async () => {
      const mockSessions = [
        { id: 's1', user_id: 'u1', user_name: 'User 1', username: 'user1', status: 'Active' },
        { id: 's2', user_id: 'u2', user_name: 'User 2', username: 'user2', status: 'Active' },
      ];
      mockAll.mockResolvedValueOnce(mockSessions);

      const result = await SessionService.getActiveSessions();

      expect(result).toEqual(mockSessions);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE s.status = 'Active'")
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY s.last_activity DESC')
      );
    });
  });

  // ─── terminateSession ────────────────────────────────────────────────────────

  describe('terminateSession', () => {
    it('terminates a specific session by id', async () => {
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.terminateSession('session-123');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE user_sessions SET status = 'Terminated' WHERE id = ?")
      );
      expect(mockRun).toHaveBeenCalledWith('session-123');
    });

    it('works with numeric session id', async () => {
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await SessionService.terminateSession(5);

      expect(result).toBe(true);
      expect(mockRun).toHaveBeenCalledWith(5);
    });
  });
});

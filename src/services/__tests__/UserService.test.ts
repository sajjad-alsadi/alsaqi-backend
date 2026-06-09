// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock references that can be used in vi.mock factories
const { mockPrepare, mockTransaction } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockTransaction: vi.fn(),
}));

const { mockHashSync } = vi.hoisted(() => ({
  mockHashSync: vi.fn(),
}));

const { mockSendEvent } = vi.hoisted(() => ({
  mockSendEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    transaction: mockTransaction,
  },
}));

// Mock bcryptjs
vi.mock('bcryptjs', () => ({
  default: {
    hashSync: (...args: any[]) => mockHashSync(...args),
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: mockSendEvent,
  },
}));

import { UserService } from '../UserService';
import { NotFoundError } from '../../utils/errors';

describe('UserService', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;
  let mockRun: ReturnType<typeof vi.fn>;

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

  // ─── createUser ────────────────────────────────────────────────────────────

  describe('createUser', () => {
    const userData = {
      username: 'newuser',
      password: 'plaintext123',
      name: 'New User',
      email: 'new@example.com',
      department: 'IT',
      job_title_id: 'jt-1',
      role: 'Auditor',
      unit: null,
      reporting_manager_id: null,
      access_scope: null,
      phone_number: null,
      notes: null,
    };

    beforeEach(() => {
      // Setup transaction mock to execute the callback immediately
      mockTransaction.mockImplementation(async (fn: Function) => fn());
    });

    it('hashes the password before storing', async () => {
      mockGet
        .mockResolvedValueOnce(null) // no existing user
        .mockResolvedValueOnce({ id: 'role-1' }) // role lookup
        .mockResolvedValueOnce({ entity_code: 'IT' }) // dept lookup
        .mockResolvedValueOnce(null); // latest employee_id
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 'user-new-id' });
      mockHashSync.mockReturnValue('hashed_password_123');

      await UserService.createUser(userData);

      expect(mockHashSync).toHaveBeenCalledWith('plaintext123', 12);
      // Verify the hashed password is passed to the INSERT statement
      expect(mockRun).toHaveBeenCalledWith(
        'newuser',
        'hashed_password_123',
        'New User',
        'new@example.com',
        'IT',
        'jt-1',
        'Auditor',
        null,
        null,
        null,
        null,
        null,
        'role-1',
        'IT-1001'
      );
    });

    it('returns created user without password field', async () => {
      mockGet
        .mockResolvedValueOnce(null) // no existing user
        .mockResolvedValueOnce({ id: 'role-1' }) // role lookup
        .mockResolvedValueOnce({ entity_code: 'ENG' }) // dept lookup
        .mockResolvedValueOnce(null); // latest employee_id
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 'user-new-id' });
      mockHashSync.mockReturnValue('hashed_pw');

      const result = await UserService.createUser(userData);

      expect(result).toEqual({
        id: 'user-new-id',
        username: 'newuser',
        name: 'New User',
        email: 'new@example.com',
        department: 'IT',
        job_title_id: 'jt-1',
        role: 'Auditor',
        status: 'Active',
        employee_id: 'ENG-1001',
      });
      // Ensure password is NOT in the returned object
      expect(result).not.toHaveProperty('password');
    });

    it('assigns role_id based on role name', async () => {
      mockGet
        .mockResolvedValueOnce(null) // no existing user
        .mockResolvedValueOnce({ id: 'role-uuid-abc' }) // role lookup returns id
        .mockResolvedValueOnce(null) // dept lookup fails
        .mockResolvedValueOnce(null); // latest employee_id
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 'user-id' });
      mockHashSync.mockReturnValue('hashed');

      await UserService.createUser(userData);

      // The role lookup query should search by role name
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM roles WHERE name = ?')
      );
      // The role_id (13th argument) should be the one from the role lookup
      const insertCall = mockRun.mock.calls[0];
      expect(insertCall[12]).toBe('role-uuid-abc');
    });
  });

  // ─── updateUser ────────────────────────────────────────────────────────────

  describe('updateUser', () => {
    const existingUser = {
      id: 'user-1',
      username: 'existinguser',
      name: 'Old Name',
      email: 'old@example.com',
      role: 'Viewer',
      status: 'Active',
      access_scope: 'department',
    };

    const updateData = {
      name: 'Updated Name',
      email: 'updated@example.com',
      department: 'Finance',
      job_title_id: 'jt-2',
      role: 'Auditor',
      unit: null,
      reporting_manager_id: null,
      access_scope: 'all',
      phone_number: '1234567890',
      notes: 'Updated notes',
      status: 'Active',
    };

    beforeEach(() => {
      mockTransaction.mockImplementation(async (fn: Function) => fn());
    });

    it('returns oldUser for comparison (to detect role/status changes)', async () => {
      mockGet
        .mockResolvedValueOnce(existingUser) // old user lookup
        .mockResolvedValueOnce({ id: 'role-2' }); // role lookup
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await UserService.updateUser('user-1', updateData);

      expect(result.oldUser).toEqual(existingUser);
      expect(result.oldUser.role).toBe('Viewer');
      expect(result.oldUser.status).toBe('Active');
    });

    it('updates user fields correctly', async () => {
      mockGet
        .mockResolvedValueOnce(existingUser) // old user lookup
        .mockResolvedValueOnce({ id: 'role-2' }); // role lookup
      mockRun.mockResolvedValueOnce({ changes: 1 });

      await UserService.updateUser('user-1', updateData);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users')
      );
      expect(mockRun).toHaveBeenCalledWith(
        'Updated Name',
        'updated@example.com',
        'Finance',
        'jt-2',
        'Auditor',
        null,
        null,
        'all',
        '1234567890',
        'Updated notes',
        'role-2',
        'Active',
        'user-1'
      );
    });
  });

  // ─── setStatus ─────────────────────────────────────────────────────────────

  describe('setStatus', () => {
    beforeEach(() => {
      mockTransaction.mockImplementation(async (fn: Function) => fn());
    });

    it('updates user status and returns username', async () => {
      mockGet.mockResolvedValueOnce({ username: 'johndoe' });
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await UserService.setStatus('user-1', 'Suspended');

      expect(result).toBe('johndoe');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET status')
      );
      expect(mockRun).toHaveBeenCalledWith('Suspended', 'user-1');
    });

    it('works for Suspended, Active, Archived statuses', async () => {
      const statuses = ['Suspended', 'Active', 'Archived'];

      for (const status of statuses) {
        vi.clearAllMocks();
        mockPrepare.mockReturnValue({ get: mockGet, all: mockAll, run: mockRun });
        mockTransaction.mockImplementation(async (fn: Function) => fn());
        mockGet.mockResolvedValueOnce({ username: 'testuser' });
        mockRun.mockResolvedValueOnce({ changes: 1 });

        const result = await UserService.setStatus('user-1', status);

        expect(result).toBe('testuser');
        expect(mockRun).toHaveBeenCalledWith(status, 'user-1');
      }
    });
  });

  // ─── unlockUser ────────────────────────────────────────────────────────────

  describe('unlockUser', () => {
    it('resets failed_attempts to 0 and locked_until to NULL', async () => {
      mockGet.mockResolvedValueOnce({ username: 'lockeduser' });
      mockRun.mockResolvedValueOnce({ changes: 1 });

      await UserService.unlockUser('user-locked');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET failed_attempts = 0, locked_until = NULL')
      );
      expect(mockRun).toHaveBeenCalledWith('user-locked');
    });

    it('returns the username of the unlocked user', async () => {
      mockGet.mockResolvedValueOnce({ username: 'unlockeduser' });
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await UserService.unlockUser('user-2');

      expect(result).toBe('unlockeduser');
    });
  });

  // ─── resetPassword ─────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('hashes the new password', async () => {
      mockGet.mockResolvedValueOnce({ username: 'resetuser' });
      mockRun.mockResolvedValueOnce({ changes: 1 });
      mockHashSync.mockReturnValue('new_hashed_password');

      await UserService.resetPassword('user-3', 'newPassword123');

      expect(mockHashSync).toHaveBeenCalledWith('newPassword123', 12);
      expect(mockRun).toHaveBeenCalledWith('new_hashed_password', 'user-3');
    });

    it('sets requires_password_change to true', async () => {
      mockGet.mockResolvedValueOnce({ username: 'resetuser' });
      mockRun.mockResolvedValueOnce({ changes: 1 });
      mockHashSync.mockReturnValue('hashed');

      await UserService.resetPassword('user-3', 'newPass');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('requires_password_change = 1')
      );
    });

    it('returns the username', async () => {
      mockGet.mockResolvedValueOnce({ username: 'targetuser' });
      mockRun.mockResolvedValueOnce({ changes: 1 });
      mockHashSync.mockReturnValue('hashed');

      const result = await UserService.resetPassword('user-3', 'newPass');

      expect(result).toBe('targetuser');
    });
  });

  // ─── deleteUser ────────────────────────────────────────────────────────────

  describe('deleteUser', () => {
    beforeEach(() => {
      mockTransaction.mockImplementation(async (fn: Function) => fn());
    });

    it('deletes the user and returns username', async () => {
      mockGet.mockResolvedValueOnce({ username: 'deleteduser' });
      mockRun
        .mockResolvedValueOnce({ changes: 1 }) // delete refresh_tokens
        .mockResolvedValueOnce({ changes: 1 }); // delete user

      const result = await UserService.deleteUser('user-del');

      expect(result).toBe('deleteduser');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM refresh_tokens WHERE user_id = ?')
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM users WHERE id = ?')
      );
    });
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock references that can be used in vi.mock factories
const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    // Pass-through transaction: invoke the callback inline so the per-recipient
    // write fan-out runs against the mocked prepare (finding 1.13 → 2.13).
    transaction: vi.fn((fn: Function) => fn()),
  },
}));

import { NotificationService } from '../NotificationService';

describe('NotificationService', () => {
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

  // ─── getNotifications ──────────────────────────────────────────────────────

  describe('getNotifications', () => {
    it('returns paginated notifications ordered by date DESC', async () => {
      const mockNotifications = [
        { id: 'n1', event_type: 'task_assigned', description: 'Task assigned', date: '2024-01-02' },
        { id: 'n2', event_type: 'comment_added', description: 'New comment', date: '2024-01-01' },
      ];
      // First call: count query
      mockGet.mockResolvedValueOnce({ total: 2 });
      // Second call: data query
      mockAll.mockResolvedValueOnce(mockNotifications);

      const result = await NotificationService.getNotifications('user-1', 1, 20);

      expect(result.data).toEqual(mockNotifications);
      expect(result.pagination).toEqual({
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY n.date DESC')
      );
    });

    it('uses correct LIMIT and OFFSET based on page/pageSize', async () => {
      // First call: count query
      mockGet.mockResolvedValueOnce({ total: 30 });
      // Second call: data query
      mockAll.mockResolvedValueOnce([]);

      await NotificationService.getNotifications('user-1', 3, 10);

      // page 3, pageSize 10 → offset = (3-1)*10 = 20
      expect(mockAll).toHaveBeenCalledWith('user-1', 10, 20);
    });

    it('falls back to legacy table if notification_recipients fails', async () => {
      // First call (count on new table) throws
      mockGet.mockRejectedValueOnce(new Error('table not found'));
      // Fallback: count query on legacy table
      mockGet.mockResolvedValueOnce({ total: 1 });
      // Fallback: data query on legacy table
      const legacyResults = [
        { id: 'n1', event_type: 'task_assigned', description: 'Legacy notification', date: '2024-01-01' },
      ];
      mockAll.mockResolvedValueOnce(legacyResults);

      const result = await NotificationService.getNotifications('user-1', 1, 20);

      expect(result.data).toEqual(legacyResults);
      expect(result.pagination.total).toBe(1);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('FROM notifications WHERE user_id')
      );
    });
  });

  // ─── getUnreadCount ────────────────────────────────────────────────────────

  describe('getUnreadCount', () => {
    it('returns correct unread count for a user', async () => {
      mockGet.mockResolvedValueOnce({ count: 5 });

      const result = await NotificationService.getUnreadCount('user-1');

      expect(result).toEqual({ count: 5 });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('notification_recipients')
      );
    });

    it('returns { count: 0 } when no unread notifications', async () => {
      mockGet.mockResolvedValueOnce(null);

      const result = await NotificationService.getUnreadCount('user-1');

      expect(result).toEqual({ count: 0 });
    });
  });

  // ─── markAsRead ────────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('updates is_read to true and sets read_at timestamp', async () => {
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await NotificationService.markAsRead('notif-1', 'user-1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SET is_read = true, read_at = CURRENT_TIMESTAMP')
      );
      expect(mockRun).toHaveBeenCalledWith('notif-1', 'user-1');
    });

    it('falls back to legacy status update', async () => {
      // First call (new table) throws
      mockRun.mockRejectedValueOnce(new Error('table not found'));
      // Second call (legacy) succeeds
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await NotificationService.markAsRead('notif-1', 'user-1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledTimes(2);
      expect(mockPrepare).toHaveBeenLastCalledWith(
        expect.stringContaining("SET status = 'Read'")
      );
    });
  });

  // ─── markAllRead ───────────────────────────────────────────────────────────

  describe('markAllRead', () => {
    it('updates all unread notifications for the user and returns the affected count as a number', async () => {
      // Primary db result shape uses `changes` (RunResult), per the design.
      mockRun.mockResolvedValueOnce({ changes: 3 });

      const result = await NotificationService.markAllRead('user-1');

      // markAllRead now returns the count of notifications transitioned to read
      // (Requirement 9.4) rather than a boolean.
      expect(typeof result).toBe('number');
      expect(result).toBe(3);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SET is_read = true, read_at = CURRENT_TIMESTAMP')
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('is_read = false')
      );
      expect(mockRun).toHaveBeenCalledWith('user-1');
    });

    // ─── affectedCount helper behavior (verified indirectly via markAllRead) ──
    // The helper normalizes the affected-row count across driver result shapes:
    // primary `changes` (RunResult), `rowCount` (pg), and fallback `affectedRows`
    // (PGlite) — Requirement 9.6.

    it('reads the count from the `rowCount` result shape', async () => {
      mockRun.mockResolvedValueOnce({ rowCount: 5 });

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(5);
    });

    it('reads the count from the `affectedRows` result shape', async () => {
      mockRun.mockResolvedValueOnce({ affectedRows: 7 });

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(7);
    });

    it('prefers `changes` over `rowCount`/`affectedRows` when multiple are present', async () => {
      mockRun.mockResolvedValueOnce({ changes: 2, rowCount: 9, affectedRows: 4 });

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(2);
    });

    it('returns 0 when the db result has no recognizable count field', async () => {
      mockRun.mockResolvedValueOnce({});

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(0);
    });

    it('returns 0 when the db result is null/undefined', async () => {
      mockRun.mockResolvedValueOnce(undefined);

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(0);
    });

    it('returns the affected count via the legacy fallback path when the primary update fails', async () => {
      // Primary (two-table) update throws → fallback to legacy single-table.
      mockRun.mockRejectedValueOnce(new Error('table not found'));
      mockRun.mockResolvedValueOnce({ changes: 4 });

      const result = await NotificationService.markAllRead('user-1');

      expect(result).toBe(4);
      expect(mockPrepare).toHaveBeenLastCalledWith(
        expect.stringContaining("SET status = 'Read'")
      );
    });
  });

  // ─── dismiss ───────────────────────────────────────────────────────────────

  describe('dismiss', () => {
    it('sets is_dismissed to true without deleting the record', async () => {
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await NotificationService.dismiss('notif-1', 'user-1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SET is_dismissed = true')
      );
      expect(mockPrepare).not.toHaveBeenCalledWith(
        expect.stringContaining('DELETE')
      );
    });

    it('falls back to DELETE in legacy mode', async () => {
      // First call (new table) throws
      mockRun.mockRejectedValueOnce(new Error('table not found'));
      // Second call (legacy DELETE) succeeds
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await NotificationService.dismiss('notif-1', 'user-1');

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenLastCalledWith(
        expect.stringContaining('DELETE FROM notifications')
      );
    });
  });

  // ─── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates notification with single recipient', async () => {
      mockGet.mockResolvedValueOnce({ id: 'new-notif-id', date: '2024-01-01T00:00:00Z' });
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await NotificationService.create(
        'user-1',
        'task_assigned',
        'You have a new task',
        'audit',
        '/audit/tasks/1'
      );

      expect(result).toBe(true);
      // Should insert into notifications table
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notifications')
      );
      // Should insert into notification_recipients table
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notification_recipients')
      );
    });

    it('creates notification with multiple recipients', async () => {
      mockGet.mockResolvedValueOnce({ id: 'new-notif-id', date: '2024-01-01T00:00:00Z' });
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await NotificationService.create(
        ['user-1', 'user-2', 'user-3'],
        'plan_started',
        'Audit plan started',
        'audit',
        '/audit/plans/1'
      );

      expect(result).toBe(true);
      // Should insert recipient rows for each user
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notification_recipients')
      );
    });

    it('creates notification with "all" recipients (queries all active users)', async () => {
      // First call: query all active users
      mockAll.mockResolvedValueOnce([
        { id: 'user-1' },
        { id: 'user-2' },
        { id: 'user-3' },
      ]);
      // Insert notification
      mockGet.mockResolvedValueOnce({ id: 'new-notif-id', date: '2024-01-01T00:00:00Z' });
      mockRun.mockResolvedValue({ changes: 1 });

      const result = await NotificationService.create(
        'all',
        'policy_review_required',
        'Policy review required',
        'compliance',
        '/compliance/policies'
      );

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id FROM users WHERE status = 'Active'")
      );
    });

    it('excludes the actor from recipients', async () => {
      mockGet.mockResolvedValueOnce({ id: 'new-notif-id', date: '2024-01-01T00:00:00Z' });
      mockRun.mockResolvedValue({ changes: 1 });

      await NotificationService.create(
        ['user-1', 'user-2', 'actor-user'],
        'comment_added',
        'New comment',
        'audit',
        '/audit/tasks/1',
        { actorId: 'actor-user' }
      );

      // The notification_recipients insert should NOT include actor-user
      // We verify by checking that run was called with user-1 and user-2 but not actor-user
      const recipientInsertCalls = mockRun.mock.calls.filter(
        (call) => call.length === 2 && call[0] === 'new-notif-id'
      );
      const recipientIds = recipientInsertCalls.map((call) => call[1]);
      expect(recipientIds).not.toContain('actor-user');
    });

    it('sends WebSocket message to connected authenticated users', async () => {
      mockGet.mockResolvedValueOnce({ id: 'new-notif-id', date: '2024-01-01T00:00:00Z' });
      mockRun.mockResolvedValue({ changes: 1 });

      const mockClient1 = { readyState: 1, authenticated: true, userId: 'user-1', send: vi.fn() };
      const mockClient2 = { readyState: 1, authenticated: true, userId: 'user-2', send: vi.fn() };
      const mockClient3 = { readyState: 1, authenticated: false, userId: 'user-3', send: vi.fn() };
      const mockWss = {
        clients: new Set([mockClient1, mockClient2, mockClient3]),
      };

      await NotificationService.create(
        ['user-1', 'user-2'],
        'task_assigned',
        'New task',
        'audit',
        '/audit/tasks/1',
        { wss: mockWss }
      );

      // Authenticated clients in recipient list should receive the message
      expect(mockClient1.send).toHaveBeenCalledWith(
        expect.stringContaining('NEW_NOTIFICATION')
      );
      expect(mockClient2.send).toHaveBeenCalledWith(
        expect.stringContaining('NEW_NOTIFICATION')
      );
      // Non-authenticated client should NOT receive
      expect(mockClient3.send).not.toHaveBeenCalled();
    });

    it('falls back to legacy single-table insert on error', async () => {
      // First insert (new table) throws
      mockGet.mockRejectedValueOnce(new Error('notification_recipients does not exist'));
      // Legacy fallback inserts succeed
      mockRun.mockResolvedValue({ changes: 1 });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await NotificationService.create(
        ['user-1', 'user-2'],
        'task_assigned',
        'New task',
        'audit',
        '/audit/tasks/1'
      );

      expect(result).toBe(true);
      // Should log the error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[NotificationService]'),
        expect.any(String)
      );
      // Should fall back to legacy inserts (one per user)
      const legacyInsertCalls = mockPrepare.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO notifications') && call[0].includes('user_id')
      );
      expect(legacyInsertCalls.length).toBeGreaterThanOrEqual(2);

      consoleSpy.mockRestore();
    });
  });

  // ─── getAdminIds ───────────────────────────────────────────────────────────

  describe('getAdminIds', () => {
    it('returns array of admin user IDs', async () => {
      mockAll.mockResolvedValueOnce([
        { id: 'admin-1' },
        { id: 'admin-2' },
      ]);

      const result = await NotificationService.getAdminIds();

      expect(result).toEqual(['admin-1', 'admin-2']);
      // Role constant is now parameterized (finding 1.36 → 2.36): the query uses
      // `role = ?` with UserRole.ADMIN bound as a parameter rather than being
      // interpolated into the SQL string.
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('role = ?')
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("status = 'Active'")
      );
      expect(mockAll).toHaveBeenCalledWith('Admin');
    });
  });

  // ─── getUserIdByName ───────────────────────────────────────────────────────

  describe('getUserIdByName', () => {
    it('returns user ID when found by name', async () => {
      mockGet.mockResolvedValueOnce({ id: 'user-123' });

      const result = await NotificationService.getUserIdByName('John Doe');

      expect(result).toBe('user-123');
      expect(mockGet).toHaveBeenCalledWith('John Doe', 'John Doe');
    });

    it('returns null when user not found', async () => {
      mockGet.mockResolvedValueOnce(null);

      const result = await NotificationService.getUserIdByName('NonExistent');

      expect(result).toBeNull();
    });
  });
});

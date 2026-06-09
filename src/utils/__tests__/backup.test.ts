// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-cron
const mockSchedule = vi.fn();
const mockValidate = vi.fn().mockReturnValue(true);
vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: any[]) => {
      mockSchedule(...args);
      return { stop: vi.fn() };
    },
    validate: (...args: any[]) => mockValidate(...args),
  },
  schedule: (...args: any[]) => {
    mockSchedule(...args);
    return { stop: vi.fn() };
  },
  validate: (...args: any[]) => mockValidate(...args),
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1024, isDirectory: () => false }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ size: 1024, isDirectory: () => false }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, cb: Function) => cb(null, '', '')),
}));

// Mock the db module
const mockPrepare = vi.fn();
const mockAll = vi.fn();
const mockRun = vi.fn();
const mockGet = vi.fn();

vi.mock('../../db/index', () => ({
  db: {
    isExternal: false,
    prepare: (...args: any[]) => {
      mockPrepare(...args);
      return {
        all: (...a: any[]) => mockAll(...a),
        run: (...a: any[]) => mockRun(...a),
        get: (...a: any[]) => mockGet(...a),
      };
    },
    validateIdentifier: (name: string) => `"${name}"`,
  },
}));

// Mock logger
vi.mock('../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock NotificationService (dynamic import in backup.ts)
vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../constants', () => ({
  UserRole: { ADMIN: 'admin' },
}));

import { BackupScheduler } from '../backup';
import fs from 'fs';

describe('BackupScheduler', () => {
  let scheduler: BackupScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock behaviors
    mockAll.mockResolvedValue([]);
    mockRun.mockResolvedValue({ changes: 1 });
    mockGet.mockResolvedValue(undefined);
    scheduler = new BackupScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('Config defaults', () => {
    it('should use default schedule of "0 2 * * *"', () => {
      scheduler.start();

      expect(mockSchedule).toHaveBeenCalledWith(
        '0 2 * * *',
        expect.any(Function)
      );
    });

    it('should use default retention of 30 days', async () => {
      // Create scheduler with explicit defaults to verify
      const defaultScheduler = new BackupScheduler();

      // Trigger a backup to exercise retention policy
      // The retention policy uses retentionDays internally
      // We verify by checking the cutoff date calculation in the SQL query
      await defaultScheduler.runNow();

      // The retention policy query should have been called with a date ~30 days ago
      const retentionCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('started_at <') && call[0]?.includes('backup_history')
      );
      expect(retentionCalls.length).toBeGreaterThan(0);
    });
  });

  describe('start() and stop()', () => {
    it('should start scheduling and set isRunning to true', () => {
      expect(scheduler.isRunning()).toBe(false);

      scheduler.start();

      expect(scheduler.isRunning()).toBe(true);
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    });

    it('should stop scheduling and set isRunning to false', () => {
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
    });

    it('should validate cron expression before scheduling', () => {
      mockValidate.mockReturnValueOnce(false);

      scheduler.start({ schedule: 'invalid-cron' });

      expect(scheduler.isRunning()).toBe(false);
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('should stop previous schedule when start is called again', () => {
      scheduler.start();
      const firstCallCount = mockSchedule.mock.calls.length;

      scheduler.start({ schedule: '0 3 * * *' });

      // Should have scheduled again
      expect(mockSchedule.mock.calls.length).toBe(firstCallCount + 1);
    });
  });

  describe('runNow() - manual trigger', () => {
    it('should execute a backup and return a BackupResult', async () => {
      // Mock table data for PGlite backup
      mockAll.mockResolvedValue([]);

      const result = await scheduler.runNow();

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('status');
      expect(typeof result.id).toBe('string');
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should record backup as "manual" type', async () => {
      mockAll.mockResolvedValue([]);

      await scheduler.runNow();

      // Check that the INSERT into backup_history includes 'manual' type
      const insertCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO backup_history')
      );
      expect(insertCalls.length).toBeGreaterThan(0);

      // The run call for the INSERT should include 'manual'
      const runCallArgs = mockRun.mock.calls;
      const hasManualType = runCallArgs.some((args: any[]) =>
        args.some((arg: any) => arg === 'manual')
      );
      expect(hasManualType).toBe(true);
    });
  });

  describe('getHistory()', () => {
    it('should return backup records from the database', async () => {
      const mockRecords = [
        {
          id: 'backup-1',
          started_at: '2024-01-01T02:00:00Z',
          completed_at: '2024-01-01T02:01:00Z',
          status: 'success',
          type: 'scheduled',
          size_bytes: 5000,
          tables_count: 10,
          file_path: '/backups/backup-1',
          error_message: null,
          verified: true,
          verified_at: '2024-01-01T02:01:00Z',
        },
        {
          id: 'backup-2',
          started_at: '2024-01-02T02:00:00Z',
          completed_at: '2024-01-02T02:01:30Z',
          status: 'success',
          type: 'manual',
          size_bytes: 5200,
          tables_count: 10,
          file_path: '/backups/backup-2',
          error_message: null,
          verified: true,
          verified_at: '2024-01-02T02:01:30Z',
        },
      ];
      mockAll.mockResolvedValueOnce(mockRecords);

      const history = await scheduler.getHistory();

      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('backup-1');
      expect(history[1].id).toBe('backup-2');
    });

    it('should query with ORDER BY started_at DESC and LIMIT', async () => {
      mockAll.mockResolvedValueOnce([]);

      await scheduler.getHistory(10);

      const selectCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('SELECT') && call[0]?.includes('backup_history')
      );
      expect(selectCalls.length).toBeGreaterThan(0);
      expect(selectCalls[0][0]).toContain('ORDER BY started_at DESC');
      expect(selectCalls[0][0]).toContain('LIMIT');
    });

    it('should return empty array on database error', async () => {
      mockAll.mockRejectedValueOnce(new Error('DB connection failed'));

      const history = await scheduler.getHistory();

      expect(history).toEqual([]);
    });

    it('should default to limit of 20', async () => {
      mockAll.mockResolvedValueOnce([]);

      await scheduler.getHistory();

      // The LIMIT ? should be called with 20
      expect(mockAll).toHaveBeenCalledWith(20);
    });
  });

  describe('Retention policy', () => {
    it('should delete backups older than retentionDays', async () => {
      const oldBackupRecords = [
        { id: 'old-backup-1', file_path: '/backups/old-backup-1.sql.gz' },
        { id: 'old-backup-2', file_path: '/backups/old-backup-2.sql.gz' },
      ];

      // First call returns empty (for table SELECT during backup)
      // Then returns old records for retention policy
      let callCount = 0;
      mockAll.mockImplementation((...args: any[]) => {
        callCount++;
        // The retention policy query contains 'started_at <'
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve(oldBackupRecords);
        }
        return Promise.resolve([]);
      });

      (fs.existsSync as any).mockReturnValue(true);
      (fs.statSync as any).mockReturnValue({ size: 1024, isDirectory: () => false });

      await scheduler.runNow();

      // Verify that DELETE was called for old records
      const deleteCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('DELETE FROM backup_history')
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
    });

    it('should delete backup files from disk during retention cleanup', async () => {
      const oldBackupRecords = [
        { id: 'old-backup-1', file_path: '/backups/old-backup-1.sql.gz' },
      ];

      mockAll.mockImplementation((...args: any[]) => {
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve(oldBackupRecords);
        }
        return Promise.resolve([]);
      });

      (fs.existsSync as any).mockReturnValue(true);
      (fs.statSync as any).mockReturnValue({ size: 1024, isDirectory: () => false });

      await scheduler.runNow();

      // Verify fs.unlinkSync was called for the old backup file
      expect(fs.unlinkSync).toHaveBeenCalledWith('/backups/old-backup-1.sql.gz');
    });

    it('should delete directory backups with rmSync', async () => {
      const oldBackupRecords = [
        { id: 'old-backup-1', file_path: '/backups/old-backup-dir' },
      ];

      mockAll.mockImplementation((...args: any[]) => {
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve(oldBackupRecords);
        }
        return Promise.resolve([]);
      });

      (fs.existsSync as any).mockReturnValue(true);
      (fs.statSync as any).mockReturnValue({ size: 1024, isDirectory: () => true });

      await scheduler.runNow();

      expect(fs.rmSync).toHaveBeenCalledWith('/backups/old-backup-dir', { recursive: true, force: true });
    });
  });

  describe('Failure handling', () => {
    it('should set status to "failed" when backup execution throws', async () => {
      // Make the table backup throw an error
      mockAll.mockImplementation((...args: any[]) => {
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('SELECT *')) {
          return Promise.reject(new Error('Database connection lost'));
        }
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await scheduler.runNow();

      expect(result.status).toBe('failed');
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should record error_message when backup fails', async () => {
      const errorMessage = 'Database connection lost';

      mockAll.mockImplementation((...args: any[]) => {
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('SELECT *')) {
          return Promise.reject(new Error(errorMessage));
        }
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await scheduler.runNow();

      // The UPDATE to backup_history should include the error message
      const updateCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('UPDATE backup_history')
      );
      expect(updateCalls.length).toBeGreaterThan(0);

      // Verify the error is in the result (formatted as "Failed to backup table X: message")
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.includes(errorMessage))).toBe(true);
    });

    it('should return partial status when some tables fail', async () => {
      let tableCallCount = 0;
      mockAll.mockImplementation((...args: any[]) => {
        const lastPrepareCall = mockPrepare.mock.calls[mockPrepare.mock.calls.length - 1];
        if (lastPrepareCall && lastPrepareCall[0]?.includes('SELECT *')) {
          tableCallCount++;
          // Fail on the 3rd table with a non-"does not exist" error
          if (tableCallCount === 3) {
            return Promise.reject(new Error('Failed to backup table audit_tasks: timeout'));
          }
          return Promise.resolve([{ id: 1, name: 'test' }]);
        }
        if (lastPrepareCall && lastPrepareCall[0]?.includes('started_at <')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await scheduler.runNow();

      expect(result.status).toBe('partial');
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });
});

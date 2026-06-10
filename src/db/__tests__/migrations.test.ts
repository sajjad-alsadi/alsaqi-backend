// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationRunner, Migration } from '../migrationRunner';

/**
 * Unit tests for the MigrationRunner class.
 * Tests use a mock DB wrapper to verify behavior without a real database.
 */
describe('MigrationRunner', () => {
  let mockDb: any;
  let runner: MigrationRunner;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      exec: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(undefined),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 }),
      }),
      transaction: vi.fn(async (fn: Function) => fn()),
    };

    runner = new MigrationRunner(mockDb);
  });

  describe('initialize()', () => {
    it('should create the schema_migrations table', async () => {
      await runner.initialize();

      expect(mockDb.exec).toHaveBeenCalledTimes(1);
      const sql = mockDb.exec.mock.calls[0][0];
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
      expect(sql).toContain('version TEXT PRIMARY KEY');
      expect(sql).toContain('name TEXT NOT NULL');
      expect(sql).toContain('type TEXT NOT NULL');
      expect(sql).toContain('applied_at TIMESTAMP');
    });

    it('should be safe to call multiple times (idempotent)', async () => {
      await runner.initialize();
      await runner.initialize();

      expect(mockDb.exec).toHaveBeenCalledTimes(2);
      // Both calls should use IF NOT EXISTS
      expect(mockDb.exec.mock.calls[0][0]).toContain('IF NOT EXISTS');
      expect(mockDb.exec.mock.calls[1][0]).toContain('IF NOT EXISTS');
    });
  });

  describe('getApplied()', () => {
    it('should return an empty array when no migrations have been applied', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const applied = await runner.getApplied();

      expect(applied).toEqual([]);
    });

    it('should return applied migrations sorted by version', async () => {
      const records = [
        { version: '001', name: 'create_users', type: 'schema', applied_at: '2024-01-01T00:00:00Z' },
        { version: '002', name: 'create_audits', type: 'schema', applied_at: '2024-01-02T00:00:00Z' },
      ];
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue(records),
        get: vi.fn(),
        run: vi.fn(),
      });

      const applied = await runner.getApplied();

      expect(applied).toHaveLength(2);
      expect(applied[0].version).toBe('001');
      expect(applied[1].version).toBe('002');
    });

    it('should query the schema_migrations table with ORDER BY version ASC', async () => {
      const mockAll = vi.fn().mockResolvedValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll, get: vi.fn(), run: vi.fn() });

      await runner.getApplied();

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY version ASC')
      );
    });
  });

  describe('getPending()', () => {
    it('should return all migrations when none have been applied', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: async () => {} },
        { version: '002', name: 'second', type: 'schema', up: async () => {} },
      ];

      const pending = await runner.getPending(available);

      expect(pending).toHaveLength(2);
      expect(pending[0].version).toBe('001');
      expect(pending[1].version).toBe('002');
    });

    it('should exclude already-applied migrations', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([
          { version: '001', name: 'first', type: 'schema', applied_at: '2024-01-01T00:00:00Z' },
        ]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: async () => {} },
        { version: '002', name: 'second', type: 'schema', up: async () => {} },
        { version: '003', name: 'third', type: 'seed', up: async () => {} },
      ];

      const pending = await runner.getPending(available);

      expect(pending).toHaveLength(2);
      expect(pending[0].version).toBe('002');
      expect(pending[1].version).toBe('003');
    });

    it('should return pending migrations sorted by version', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const available: Migration[] = [
        { version: '003', name: 'third', type: 'schema', up: async () => {} },
        { version: '001', name: 'first', type: 'schema', up: async () => {} },
        { version: '002', name: 'second', type: 'seed', up: async () => {} },
      ];

      const pending = await runner.getPending(available);

      expect(pending[0].version).toBe('001');
      expect(pending[1].version).toBe('002');
      expect(pending[2].version).toBe('003');
    });

    it('should return empty array when all migrations are applied', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([
          { version: '001', name: 'first', type: 'schema', applied_at: '2024-01-01T00:00:00Z' },
          { version: '002', name: 'second', type: 'schema', applied_at: '2024-01-02T00:00:00Z' },
        ]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: async () => {} },
        { version: '002', name: 'second', type: 'schema', up: async () => {} },
      ];

      const pending = await runner.getPending(available);

      expect(pending).toHaveLength(0);
    });
  });

  describe('run()', () => {
    it('should execute pending migrations in version order', async () => {
      const executionOrder: string[] = [];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 }),
      });

      const available: Migration[] = [
        { version: '002', name: 'second', type: 'schema', up: async () => { executionOrder.push('002'); } },
        { version: '001', name: 'first', type: 'schema', up: async () => { executionOrder.push('001'); } },
        { version: '003', name: 'third', type: 'seed', up: async () => { executionOrder.push('003'); } },
      ];

      await runner.run(available);

      expect(executionOrder).toEqual(['001', '002', '003']);
    });

    it('should record each migration in schema_migrations after execution', async () => {
      const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 });
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: mockRun,
      });

      const available: Migration[] = [
        { version: '001', name: 'create_users', type: 'schema', up: async () => {} },
      ];

      await runner.run(available);

      // Verify INSERT INTO schema_migrations was called
      const insertCalls = mockDb.prepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO schema_migrations')
      );
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it('should halt execution when a migration fails', async () => {
      const executionOrder: string[] = [];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 }),
      });

      // Make the transaction rethrow errors
      mockDb.transaction.mockImplementation(async (fn: Function) => fn());

      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: async () => { executionOrder.push('001'); } },
        { version: '002', name: 'failing', type: 'schema', up: async () => { throw new Error('Migration failed'); } },
        { version: '003', name: 'third', type: 'schema', up: async () => { executionOrder.push('003'); } },
      ];

      await expect(runner.run(available)).rejects.toThrow('Migration failed');

      // Only the first migration should have executed
      expect(executionOrder).toEqual(['001']);
      expect(executionOrder).not.toContain('003');
    });

    it('should do nothing when there are no pending migrations', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([
          { version: '001', name: 'first', type: 'schema', applied_at: '2024-01-01T00:00:00Z' },
        ]),
        get: vi.fn(),
        run: vi.fn(),
      });

      const upFn = vi.fn();
      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: upFn },
      ];

      await runner.run(available);

      expect(upFn).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should wrap each migration in a transaction', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 }),
      });

      const available: Migration[] = [
        { version: '001', name: 'first', type: 'schema', up: async () => {} },
        { version: '002', name: 'second', type: 'schema', up: async () => {} },
      ];

      await runner.run(available);

      // transaction should be called once per pending migration
      expect(mockDb.transaction).toHaveBeenCalledTimes(2);
    });

    it('should handle an empty migration list gracefully', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        run: vi.fn(),
      });

      await runner.run([]);

      // No transactions should be created for empty list
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });
});


/**
 * Unit tests for the MigrationRunner.rollback() method.
 * Validates Requirements 3.2, 3.6, 3.7
 */
describe('MigrationRunner - rollback()', () => {
  let mockDb: any;
  let runner: MigrationRunner;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      exec: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(undefined),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 }),
      }),
      transaction: vi.fn(async (fn: Function) => fn()),
    };

    runner = new MigrationRunner(mockDb);
  });

  it('should reject rollback with clear error if migration has no down() defined (Req 3.7)', async () => {
    const available: Migration[] = [
      { version: '001', name: 'create_users', type: 'schema', up: async () => {} },
    ];

    await expect(runner.rollback('001', available)).rejects.toThrow(
      'Rollback is not supported for migration 001'
    );
    await expect(runner.rollback('001', available)).rejects.toThrow(
      'no down() function defined'
    );
  });

  it('should reject rollback if migration version is not found', async () => {
    const available: Migration[] = [
      { version: '001', name: 'create_users', type: 'schema', up: async () => {} },
    ];

    await expect(runner.rollback('999', available)).rejects.toThrow(
      'Migration version "999" not found'
    );
  });

  it('should execute down() within a transaction (Req 3.6)', async () => {
    const downFn = vi.fn().mockResolvedValue(undefined);
    const available: Migration[] = [
      { version: '001', name: 'create_users', type: 'schema', up: async () => {}, down: downFn },
    ];

    await runner.rollback('001', available);

    // Transaction should be called once
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // down() should be called inside the transaction
    expect(downFn).toHaveBeenCalledTimes(1);
  });

  it('should remove record from schema_migrations within the same transaction (Req 3.6)', async () => {
    const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 });
    mockDb.prepare.mockReturnValue({
      all: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      run: mockRun,
    });

    const available: Migration[] = [
      { version: '001', name: 'create_users', type: 'schema', up: async () => {}, down: async () => {} },
    ];

    await runner.rollback('001', available);

    // Verify DELETE FROM schema_migrations was called
    const deleteCalls = mockDb.prepare.mock.calls.filter(
      (call: any[]) => call[0]?.includes('DELETE FROM schema_migrations')
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
  });

  it('should rollback transaction automatically on failure during down() (Req 3.2)', async () => {
    // Make transaction propagate errors (simulating rollback behavior)
    mockDb.transaction.mockImplementation(async (fn: Function) => {
      try {
        return await fn();
      } catch (error) {
        throw error; // transaction wrapper will have rolled back
      }
    });

    const available: Migration[] = [
      {
        version: '001',
        name: 'create_users',
        type: 'schema',
        up: async () => {},
        down: async () => { throw new Error('Rollback down() failed'); },
      },
    ];

    await expect(runner.rollback('001', available)).rejects.toThrow('Rollback down() failed');
  });

  it('should successfully rollback a migration with a valid down() function', async () => {
    const downFn = vi.fn().mockResolvedValue(undefined);
    const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 1 });
    mockDb.prepare.mockReturnValue({
      all: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      run: mockRun,
    });

    const available: Migration[] = [
      { version: '001', name: 'create_users', type: 'schema', up: async () => {}, down: downFn },
    ];

    await runner.rollback('001', available);

    expect(downFn).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });
});

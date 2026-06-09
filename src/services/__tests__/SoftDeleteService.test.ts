// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock references that can be used in vi.mock factories
const { mockPrepare, mockTransaction, mockValidateIdentifier } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockTransaction: vi.fn(),
  mockValidateIdentifier: vi.fn((name: string) => {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid database identifier: ${name}`);
    }
    return name;
  }),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    transaction: mockTransaction,
    validateIdentifier: mockValidateIdentifier,
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock AppCodeGenerator
vi.mock('../../utils/AppCodeGenerator', () => ({
  AppCodeGenerator: {
    generateCode: vi.fn(),
    generateFindingCode: vi.fn(),
  },
}));

// Mock crypto
vi.mock('crypto', () => ({
  default: {
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => 'mock-hash-value'),
    })),
  },
}));

import { SoftDeleteService } from '../SoftDeleteService';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

describe('SoftDeleteService', () => {
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

    // Default transaction mock: execute the function immediately and return its result
    mockTransaction.mockImplementation(async (fn: Function) => fn());
  });

  describe('softDelete', () => {
    it('should set deleted_at and deleted_by on the record', async () => {
      // First call: UPDATE ... RETURNING id (main record)
      mockGet.mockResolvedValueOnce({ id: 1 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.softDelete({
        tableName: 'audit_plans',
        id: 1,
        deletedBy: 'user-uuid-123',
      });

      // Verify the UPDATE was called with correct SQL
      const updateCall = mockPrepare.mock.calls[0][0];
      expect(updateCall).toContain('UPDATE audit_plans');
      expect(updateCall).toContain('SET deleted_at');
      expect(updateCall).toContain('deleted_by');
      expect(updateCall).toContain('WHERE id = ?');
      expect(updateCall).toContain('AND deleted_at IS NULL');
    });

    it('should throw NotFoundError when record does not exist', async () => {
      mockGet.mockResolvedValueOnce(null); // UPDATE returns null (no matching record)

      await expect(
        SoftDeleteService.softDelete({
          tableName: 'audit_plans',
          id: 999,
          deletedBy: 'user-uuid-123',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when record is already soft-deleted', async () => {
      mockGet.mockResolvedValueOnce(null); // deleted_at IS NULL condition fails

      await expect(
        SoftDeleteService.softDelete({
          tableName: 'audit_plans',
          id: 1,
          deletedBy: 'user-uuid-123',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('should cascade soft delete to dependent records', async () => {
      // Main record update
      mockGet.mockResolvedValueOnce({ id: 1 });
      // Cascade update for child table
      mockRun.mockResolvedValueOnce({ changes: 3 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.softDelete({
        tableName: 'audit_plans',
        id: 1,
        deletedBy: 'user-uuid-123',
        cascade: [{ table: 'audit_tasks', foreignKey: 'plan_id' }],
      });

      // Verify cascade UPDATE was called
      const cascadeCall = mockPrepare.mock.calls[1][0];
      expect(cascadeCall).toContain('UPDATE audit_tasks');
      expect(cascadeCall).toContain('SET deleted_at');
      expect(cascadeCall).toContain('WHERE plan_id = ?');
      expect(cascadeCall).toContain('AND deleted_at IS NULL');
    });

    it('should cascade soft delete to multiple dependent tables', async () => {
      // Main record update
      mockGet.mockResolvedValueOnce({ id: 1 });
      // Cascade update for first child table
      mockRun.mockResolvedValueOnce({ changes: 2 });
      // Cascade update for second child table
      mockRun.mockResolvedValueOnce({ changes: 1 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.softDelete({
        tableName: 'audit_plans',
        id: 1,
        deletedBy: 'user-uuid-123',
        cascade: [
          { table: 'audit_tasks', foreignKey: 'plan_id' },
          { table: 'audit_programs', foreignKey: 'plan_id' },
        ],
      });

      // Verify both cascade UPDATEs were called
      const calls = mockPrepare.mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((sql: string) => sql.includes('UPDATE audit_tasks'))).toBe(true);
      expect(calls.some((sql: string) => sql.includes('UPDATE audit_programs'))).toBe(true);
    });

    it('should record an audit log entry', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 }); // main record
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' }); // audit hash
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 }); // audit insert

      await SoftDeleteService.softDelete({
        tableName: 'audit_plans',
        id: 1,
        deletedBy: 'admin-user',
      });

      // Verify audit trail insert was called
      const auditCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(auditCalls.length).toBeGreaterThan(0);
    });
  });

  describe('restore', () => {
    it('should clear deleted_at and deleted_by on the record', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 }); // UPDATE RETURNING id
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.restore('audit_plans', 1, 'admin-user');

      const updateCall = mockPrepare.mock.calls[0][0];
      expect(updateCall).toContain('UPDATE audit_plans');
      expect(updateCall).toContain('SET deleted_at = NULL, deleted_by = NULL');
      expect(updateCall).toContain('WHERE id = ?');
      expect(updateCall).toContain('AND deleted_at IS NOT NULL');
    });

    it('should throw NotFoundError when record does not exist', async () => {
      mockGet.mockResolvedValueOnce(null);

      await expect(
        SoftDeleteService.restore('audit_plans', 999, 'admin-user')
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when record is not soft-deleted', async () => {
      mockGet.mockResolvedValueOnce(null); // deleted_at IS NOT NULL condition fails

      await expect(
        SoftDeleteService.restore('audit_plans', 1, 'admin-user')
      ).rejects.toThrow(NotFoundError);
    });

    it('should record an audit log entry', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 });
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.restore('audit_plans', 1, 'admin-user');

      const auditCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(auditCalls.length).toBeGreaterThan(0);
    });
  });

  describe('permanentDelete', () => {
    it('should reject with 403 when user is not admin', async () => {
      await expect(
        SoftDeleteService.permanentDelete('audit_plans', 1, 'regular-user', false)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should permanently delete the record when user is admin', async () => {
      // SELECT to check existence
      mockGet.mockResolvedValueOnce({ id: 1 });
      // DELETE
      mockRun.mockResolvedValueOnce({ changes: 1 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await SoftDeleteService.permanentDelete('audit_plans', 1, 'admin-user', true);

      const deleteCall = mockPrepare.mock.calls[1][0];
      expect(deleteCall).toContain('DELETE FROM audit_plans WHERE id = ?');
    });

    it('should throw NotFoundError when record does not exist', async () => {
      mockGet.mockResolvedValueOnce(null); // SELECT returns null

      await expect(
        SoftDeleteService.permanentDelete('audit_plans', 999, 'admin-user', true)
      ).rejects.toThrow(NotFoundError);
    });

    it('should record an audit log entry', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 }); // existence check
      mockRun.mockResolvedValueOnce({ changes: 1 }); // DELETE
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' }); // audit hash
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 }); // audit insert

      await SoftDeleteService.permanentDelete('audit_plans', 1, 'admin-user', true);

      const auditCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(auditCalls.length).toBeGreaterThan(0);
    });
  });

  describe('getDeleted', () => {
    it('should return paginated soft-deleted records', async () => {
      mockGet.mockResolvedValueOnce({ total: 15 }); // COUNT query
      mockAll.mockResolvedValueOnce([
        { id: 1, title: 'Deleted Item 1', deleted_at: '2024-01-01T00:00:00Z' },
        { id: 2, title: 'Deleted Item 2', deleted_at: '2024-01-02T00:00:00Z' },
      ]);

      const result = await SoftDeleteService.getDeleted('audit_plans', 1, 10);

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        page: 1,
        pageSize: 10,
        total: 15,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
      });

      // Verify the COUNT query filters by deleted_at IS NOT NULL
      const countCall = mockPrepare.mock.calls[0][0];
      expect(countCall).toContain('WHERE deleted_at IS NOT NULL');

      // Verify the data query filters by deleted_at IS NOT NULL
      const dataCall = mockPrepare.mock.calls[1][0];
      expect(dataCall).toContain('WHERE deleted_at IS NOT NULL');
      expect(dataCall).toContain('ORDER BY deleted_at DESC');
    });

    it('should return empty data when no soft-deleted records exist', async () => {
      mockGet.mockResolvedValueOnce({ total: 0 });
      mockAll.mockResolvedValueOnce([]);

      const result = await SoftDeleteService.getDeleted('audit_plans', 1, 10);

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it('should use default page and pageSize when not provided', async () => {
      mockGet.mockResolvedValueOnce({ total: 5 });
      mockAll.mockResolvedValueOnce([]);

      await SoftDeleteService.getDeleted('audit_plans');

      // Verify LIMIT and OFFSET use defaults (page=1, pageSize=20)
      const dataCall = mockPrepare.mock.calls[1][0];
      expect(dataCall).toContain('LIMIT ?');
      expect(dataCall).toContain('OFFSET ?');
      // Check the params passed to all()
      expect(mockAll).toHaveBeenCalledWith(20, 0);
    });
  });
});

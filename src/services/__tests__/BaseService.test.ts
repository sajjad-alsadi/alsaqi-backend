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

const { mockGenerateCode, mockGenerateFindingCode } = vi.hoisted(() => ({
  mockGenerateCode: vi.fn(),
  mockGenerateFindingCode: vi.fn(),
}));

const { mockSendEvent } = vi.hoisted(() => ({
  mockSendEvent: vi.fn().mockResolvedValue(undefined),
}));

const { mockAuditAppend } = vi.hoisted(() => ({
  mockAuditAppend: vi.fn().mockResolvedValue(undefined),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    transaction: mockTransaction,
    validateIdentifier: mockValidateIdentifier,
  },
}));

// Mock AppCodeGenerator
vi.mock('../../utils/AppCodeGenerator', () => ({
  AppCodeGenerator: {
    generateCode: mockGenerateCode,
    generateFindingCode: mockGenerateFindingCode,
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: mockSendEvent,
  },
}));

// Mock AuditChainService - logAudit now delegates to its single canonical append
vi.mock('../AuditChainService', () => ({
  AuditChainService: {
    append: mockAuditAppend,
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

import { BaseService } from '../BaseService';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { clearCountCache } from '../countCache';

describe('BaseService', () => {
  let mockGet: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;
  let mockRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCountCache();

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

  describe('findAll', () => {
    it('should return paginated data with correct pagination metadata', async () => {
      mockGet.mockResolvedValueOnce({ total: 25 }); // count query
      mockAll.mockResolvedValueOnce([
        { id: 1, title: 'Item 1' },
        { id: 2, title: 'Item 2' },
      ]);

      const result = await BaseService.findAll('audit_plans', { page: 2, pageSize: 10 });

      expect(result.pagination).toEqual({
        page: 2,
        pageSize: 10,
        total: 25,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });
      expect(result.data).toHaveLength(2);
    });

    it('should apply search filter across text columns', async () => {
      mockGet.mockResolvedValueOnce({ total: 1 });
      mockAll.mockResolvedValueOnce([{ id: 1, title: 'Test Plan' }]);

      await BaseService.findAll('audit_plans', {
        where: { search: 'Test' },
      });

      // Verify the prepare was called with LIKE clauses for search
      const countCall = mockPrepare.mock.calls[0][0];
      expect(countCall).toContain('LIKE');

      const dataCall = mockPrepare.mock.calls[1][0];
      expect(dataCall).toContain('LIKE');
    });

    it('should apply where filters correctly', async () => {
      mockGet.mockResolvedValueOnce({ total: 5 });
      mockAll.mockResolvedValueOnce([{ id: 1, status: 'Active' }]);

      await BaseService.findAll('audit_plans', {
        where: { status: 'Active', department: 'IT' },
      });

      // Verify WHERE clause was built with the filter keys
      const countCall = mockPrepare.mock.calls[0][0];
      expect(countCall).toContain('WHERE');
      expect(countCall).toContain('status');
      expect(countCall).toContain('department');
    });

    it('should validate orderBy column name and reject SQL injection attempts', async () => {
      await expect(
        BaseService.findAll('audit_plans', { orderBy: 'id; DROP TABLE users--' })
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.findAll('audit_plans', { orderBy: "name' OR '1'='1" })
      ).rejects.toThrow(ValidationError);
    });

    it('should validate orderBy direction (only ASC/DESC allowed)', async () => {
      await expect(
        BaseService.findAll('audit_plans', { orderBy: 'id INVALID' })
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.findAll('audit_plans', { orderBy: 'id DROP' })
      ).rejects.toThrow(ValidationError);
    });

    it('should use default orderBy "id DESC" when not specified', async () => {
      mockGet.mockResolvedValueOnce({ total: 0 });
      mockAll.mockResolvedValueOnce([]);

      await BaseService.findAll('audit_plans');

      // The data query should contain ORDER BY id DESC
      const dataCall = mockPrepare.mock.calls[1][0];
      expect(dataCall).toContain('ORDER BY id DESC');
    });

    it('should run without a search clause for tables with no configured search columns', async () => {
      // `departments` has no entry in TABLE_SEARCH_COLUMNS, so there is no
      // title/name/description fallback and the query runs unfiltered (Req 5.2).
      mockGet.mockResolvedValueOnce({ total: 3 });
      mockAll.mockResolvedValueOnce([{ id: 1, name: 'Dept' }]);

      const result = await BaseService.findAll('departments', { where: { search: 'anything' } });

      const countCall = mockPrepare.mock.calls[0][0];
      const dataCall = mockPrepare.mock.calls[1][0];
      expect(countCall).not.toContain('LIKE');
      expect(dataCall).not.toContain('LIKE');
      expect(result.data).toHaveLength(1);
    });
  });

  describe('findAll (keyset pagination for large-table-configured endpoints)', () => {
    it('should use composite keyset ordering and return a nextCursor when more rows remain', async () => {
      // Keyset default page size is 25; return 26 rows so a following page exists.
      const rows = Array.from({ length: 26 }, (_, i) => ({
        id: `id-${String(i).padStart(3, '0')}`,
        created_at: `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      }));
      mockAll.mockResolvedValueOnce(rows);
      mockGet.mockResolvedValueOnce({ total: 5000 });

      const result = await BaseService.findAll('audit_findings');

      // The keyset SELECT orders by the composite deterministic key.
      const dataSql = mockPrepare.mock.calls[0][0];
      expect(dataSql).toContain('ORDER BY created_at DESC, id DESC');

      expect(result.data).toHaveLength(25);
      expect(typeof result.nextCursor).toBe('string');
      expect(result.pagination.total).toBe(5000);
    });

    it('should not return a nextCursor when no further rows remain', async () => {
      mockAll.mockResolvedValueOnce([
        { id: 'id-1', created_at: '2024-01-01T00:00:00Z' },
      ]);
      mockGet.mockResolvedValueOnce({ total: 1 });

      const result = await BaseService.findAll('audit_findings');

      expect(result.data).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it('should serve the total count from cache rather than running COUNT(*) on every request', async () => {
      mockAll.mockResolvedValue([]);
      mockGet.mockResolvedValue({ total: 1234 });

      await BaseService.findAll('audit_findings');
      await BaseService.findAll('audit_findings');

      // COUNT(*) must be issued only once across the two identical requests (Req 6.5).
      const countCalls = mockPrepare.mock.calls.filter((c: any[]) =>
        String(c[0]).includes('COUNT(*)')
      );
      expect(countCalls).toHaveLength(1);
    });

    it('should reject a malformed cursor with a ValidationError', async () => {
      await expect(
        BaseService.findAll('audit_findings', { cursor: 'not-a-valid-cursor!!!' })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('findById', () => {
    it('should return the record when found', async () => {
      const record = { id: 1, title: 'Test Plan', status: 'Active' };
      mockGet.mockResolvedValueOnce(record);

      const result = await BaseService.findById('audit_plans', 1);

      expect(result).toEqual(record);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM audit_plans WHERE id = ?')
      );
    });

    it('should throw NotFoundError when record does not exist', async () => {
      mockGet.mockResolvedValueOnce(null);

      await expect(
        BaseService.findById('audit_plans', 999)
      ).rejects.toThrow(NotFoundError);

      await expect(
        BaseService.findById('audit_plans', 999)
      ).rejects.toThrow('audit_plans item with ID 999 not found');
    });
  });

  describe('create', () => {
    it('should reject the entire request when it contains non-whitelisted fields (id, created_at, updated_at)', async () => {
      // id/created_at/updated_at are system-managed and absent from the write
      // schema, so the whole request is rejected and no row is created (Req 4.3).
      const data = {
        id: 999,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
        title: 'New Plan',
        department: 'IT',
      };

      await expect(BaseService.create('audit_plans', data)).rejects.toThrow(ValidationError);
      await expect(BaseService.create('audit_plans', data)).rejects.toThrow(/not permitted/i);

      // No INSERT should have been issued for the rejected request.
      expect(mockRun).not.toHaveBeenCalled();
      const issuedSql = mockPrepare.mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(issuedSql).not.toContain('INSERT INTO');
    });

    it('should name the rejected keys in the validation error', async () => {
      const data = { title: 'New Plan', role: 'admin', deleted_at: 'now' };

      await expect(BaseService.create('audit_plans', data)).rejects.toThrow(/role/);
      await expect(BaseService.create('audit_plans', data)).rejects.toThrow(/deleted_at/);
    });

    it('should generate auto-code when code column is empty', async () => {
      mockGenerateCode.mockResolvedValueOnce('IT-PL-24-001');
      mockGet.mockResolvedValueOnce({ id: 5 }); // INSERT ... RETURNING id

      const data = { title: 'New Plan', department: 'IT' };

      const result = await BaseService.create('audit_plans', data);

      expect(mockGenerateCode).toHaveBeenCalledWith('audit_plans', 'IT');
      expect(result.plan_code).toBe('IT-PL-24-001');
    });

    it('should insert record and return result with id', async () => {
      // create now obtains the real primary key via `INSERT ... RETURNING id`
      // executed through `get()`, so the inserted row is read back as { id }.
      mockGet.mockResolvedValueOnce({ id: 42 }); // RETURNING id
      mockGenerateCode.mockResolvedValueOnce(null);

      const data = { title: 'Test Task', plan_code: 'EXISTING-CODE' };

      const result = await BaseService.create('audit_plans', data);

      expect(result.id).toBe(42);
      expect(result.title).toBe('Test Task');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO')
      );
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING id')
      );
    });

    it('should throw ValidationError when no whitelisted data is provided', async () => {
      // An empty body passes the whitelist (no rejected keys) but yields no
      // writable columns once auto-code generation produces nothing.
      mockGenerateCode.mockResolvedValueOnce(null);
      const data = {};

      await expect(
        BaseService.create('audit_plans', data)
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.create('audit_plans', data)
      ).rejects.toThrow('No data provided for creation');
    });
  });

  describe('update', () => {
    it('should reject the entire request when it contains non-whitelisted fields (mass-assignment)', async () => {
      // role and deleted_at are not writable for audit_plans, so the whole
      // request is rejected and the existing row is left unchanged (Req 4.3, 4.4).
      const data = {
        title: 'Updated Title',
        status: 'Active',
        role: 'admin',
        deleted_at: 'now',
      };

      await expect(BaseService.update('audit_plans', 1, data)).rejects.toThrow(ValidationError);
      await expect(BaseService.update('audit_plans', 1, data)).rejects.toThrow(/not permitted/i);

      // No UPDATE should have been issued for the rejected request.
      const issuedSql = mockPrepare.mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(issuedSql).not.toContain('UPDATE audit_plans SET');
    });

    it('should update record and return result for whitelisted fields', async () => {
      mockGet.mockResolvedValueOnce({ id: 5 }); // RETURNING id

      const data = { title: 'Updated', status: 'Completed' };

      const result = await BaseService.update('audit_plans', 5, data);

      expect(result).toEqual({ id: 5, title: 'Updated', status: 'Completed' });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE audit_plans SET')
      );
    });

    it('should throw NotFoundError when record does not exist', async () => {
      mockGet.mockResolvedValueOnce(null); // RETURNING id returns null

      const data = { title: 'Updated' };

      await expect(
        BaseService.update('audit_plans', 999, data)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when no data provided', async () => {
      // An empty body passes the whitelist but leaves nothing to update.
      const data = {};

      await expect(
        BaseService.update('audit_plans', 1, data)
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.update('audit_plans', 1, data)
      ).rejects.toThrow('No data provided for update');
    });
  });

  describe('delete', () => {
    it('should soft-delete (UPDATE deleted_at) for tables with a deleted_at column', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 }); // RETURNING id from the soft-delete UPDATE

      const result = await BaseService.delete('audit_plans', 1);

      expect(result).toBe(true);
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain('UPDATE audit_plans SET deleted_at = CURRENT_TIMESTAMP');
      expect(sql).toContain('deleted_at IS NULL');
      expect(sql).not.toContain('DELETE FROM');
      expect(mockGet).toHaveBeenCalledWith(1);
    });

    it('should return NotFoundError when the row is already soft-deleted (no RETURNING row)', async () => {
      mockGet.mockResolvedValueOnce(undefined); // already soft-deleted -> WHERE deleted_at IS NULL matches nothing

      await expect(BaseService.delete('audit_plans', 1)).rejects.toThrow(NotFoundError);
      // No hard DELETE should ever be issued on the default path
      const issuedSql = mockPrepare.mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(issuedSql).not.toContain('DELETE FROM');
    });

    it('should hard-delete physically for tables without a deleted_at column', async () => {
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await BaseService.delete('role_permissions', 1);

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM role_permissions WHERE id = ?')
      );
      expect(mockRun).toHaveBeenCalledWith(1);
    });
  });

  // Task 5.12 — soft-delete and count edge cases (Requirements 6.5, 25.4, 25.5)
  describe('soft-delete and count edge cases (Task 5.12)', () => {
    it('returns NotFoundError for an already-soft-deleted row and preserves the existing deleted_at', async () => {
      // RETURNING id yields no row because `deleted_at IS NULL` matches nothing
      // on an already-soft-deleted target.
      mockGet.mockResolvedValueOnce(undefined);

      await expect(BaseService.delete('audit_plans', 1)).rejects.toThrow(NotFoundError);

      const issuedSql = mockPrepare.mock.calls.map((c: any[]) => String(c[0]));

      // Exactly one statement is issued: the guarded conditional soft-delete.
      expect(issuedSql).toHaveLength(1);
      expect(issuedSql[0]).toContain('UPDATE audit_plans SET deleted_at = CURRENT_TIMESTAMP');

      // The single UPDATE is guarded by `deleted_at IS NULL`, so the preserved
      // deleted_at on the already-deleted row is never overwritten (Req 25.4).
      expect(issuedSql[0]).toContain('deleted_at IS NULL');

      // There is no second/unconditional UPDATE that would change deleted_at.
      const unconditionalUpdates = issuedSql.filter(
        (sql) => sql.includes('SET deleted_at') && !sql.includes('deleted_at IS NULL')
      );
      expect(unconditionalUpdates).toHaveLength(0);

      // The default path issues no hard DELETE.
      expect(issuedSql.some((sql) => sql.includes('DELETE FROM'))).toBe(false);
    });

    it('never invokes hardDelete on the default delete path for a soft-delete table (Req 25.5)', async () => {
      const hardDeleteSpy = vi.spyOn(BaseService, 'hardDelete');
      mockGet.mockResolvedValueOnce({ id: 1 }); // successful soft-delete

      await BaseService.delete('audit_plans', 1);

      expect(hardDeleteSpy).not.toHaveBeenCalled();
      hardDeleteSpy.mockRestore();
    });

    it('never invokes hardDelete on the default delete path for a hard-delete table (Req 25.5)', async () => {
      // Even when the row has no deleted_at column and is removed physically, the
      // default delete path must not delegate to the distinct hardDelete operation.
      const hardDeleteSpy = vi.spyOn(BaseService, 'hardDelete');
      mockRun.mockResolvedValueOnce({ changes: 1 });

      await BaseService.delete('role_permissions', 1);

      expect(hardDeleteSpy).not.toHaveBeenCalled();
      hardDeleteSpy.mockRestore();
    });

    it('serves a cached estimate for a large/keyset table, issuing COUNT(*) at most once within the TTL (Req 6.5)', async () => {
      mockAll.mockResolvedValue([]);
      mockGet.mockResolvedValue({ total: 9876 });

      // Several identical list requests within the cache TTL.
      const r1 = await BaseService.findAll('audit_findings');
      const r2 = await BaseService.findAll('audit_findings');
      const r3 = await BaseService.findAll('audit_findings');

      const countCalls = mockPrepare.mock.calls.filter((c: any[]) =>
        String(c[0]).includes('COUNT(*)')
      );

      // At most one COUNT(*) is executed across the repeated requests; the rest
      // are served from the cache rather than a per-request COUNT(*).
      expect(countCalls.length).toBeLessThanOrEqual(1);
      expect(r1.pagination.total).toBe(9876);
      expect(r2.pagination.total).toBe(9876);
      expect(r3.pagination.total).toBe(9876);
    });
  });

  describe('hardDelete', () => {
    it('should physically delete the row', async () => {
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await BaseService.hardDelete('audit_plans', 1);

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM audit_plans WHERE id = ?')
      );
      expect(mockRun).toHaveBeenCalledWith(1);
    });
  });

  describe('sanitizeBody', () => {
    it('should convert empty string to null for fields ending with _id', async () => {
      // sanitizeBody is protected, so we test it indirectly through update using
      // whitelisted _id columns of the target table.
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { plan_id: '', program_id: '', title: 'Test' };

      const result = await BaseService.update('audit_tasks', 1, data);

      expect(result.plan_id).toBeNull();
      expect(result.program_id).toBeNull();
    });

    it('should leave non-empty _id fields unchanged', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { plan_id: 'plan-123', title: 'Test' };

      const result = await BaseService.update('audit_tasks', 1, data);

      expect(result.plan_id).toBe('plan-123');
    });

    it('should leave non-_id fields unchanged even if empty', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { title: '', audit_type: '' };

      const result = await BaseService.update('audit_tasks', 1, data);

      expect(result.title).toBe('');
      expect(result.audit_type).toBe('');
    });
  });

  describe('logAudit', () => {
    it('should delegate to the single canonical AuditChainService.append', async () => {
      await BaseService.logAudit('admin', 'create', 'AuditPlan', 'Created plan');

      // logAudit must delegate to the one canonical hash-chain writer rather
      // than running its own inline INSERT INTO audit_trail (Req 7.1, 27.1).
      expect(mockAuditAppend).toHaveBeenCalledTimes(1);
      expect(mockAuditAppend).toHaveBeenCalledWith({
        user: 'admin',
        action: 'create',
        module: 'AuditPlan',
        details: 'Created plan',
      });

      // The duplicated inline writer is gone: BaseService itself must not issue
      // any audit_trail INSERT directly.
      const directInserts = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(directInserts.length).toBe(0);
    });

    it('should swallow append failures and not crash the caller', async () => {
      mockAuditAppend.mockRejectedValueOnce(new Error('append failed'));

      // The primary operation logging is a side effect; a write failure must not
      // propagate out of BaseService.logAudit.
      await expect(
        BaseService.logAudit('admin', 'create', 'AuditPlan', 'First entry')
      ).resolves.toBeUndefined();

      expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    });
  });
});

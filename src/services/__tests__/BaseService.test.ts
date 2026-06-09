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

describe('BaseService', () => {
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
    it('should remove restricted fields (id, created_at, updated_at) from body', async () => {
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 10, changes: 1 });

      const data = {
        id: 999,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
        title: 'New Plan',
        department: 'IT',
      };

      const result = await BaseService.create('audit_plans', data);

      // The result should not contain restricted fields
      expect(result).not.toHaveProperty('created_at');
      expect(result).not.toHaveProperty('updated_at');
      expect(result.id).toBe(10); // Should use lastInsertRowid
      expect(result.title).toBe('New Plan');
    });

    it('should generate auto-code when code column is empty', async () => {
      mockGenerateCode.mockResolvedValueOnce('IT-PL-24-001');
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 5, changes: 1 });

      const data = { title: 'New Plan', department: 'IT' };

      const result = await BaseService.create('audit_plans', data);

      expect(mockGenerateCode).toHaveBeenCalledWith('audit_plans', 'IT');
      expect(result.plan_code).toBe('IT-PL-24-001');
    });

    it('should insert record and return result with id', async () => {
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 42, changes: 1 });
      mockGenerateCode.mockResolvedValueOnce(null);

      const data = { title: 'Test Task', plan_code: 'EXISTING-CODE' };

      const result = await BaseService.create('audit_plans', data);

      expect(result.id).toBe(42);
      expect(result.title).toBe('Test Task');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO')
      );
    });

    it('should throw ValidationError when no data provided', async () => {
      // All fields are restricted, so after stripping there's nothing left
      const data = { id: 1, created_at: '2024-01-01', updated_at: '2024-01-01' };

      await expect(
        BaseService.create('audit_plans', data)
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.create('audit_plans', data)
      ).rejects.toThrow('No data provided for creation');
    });
  });

  describe('update', () => {
    it('should remove immutable fields (plan_code, program_code, task_number, etc.)', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 }); // RETURNING id

      const data = {
        plan_code: 'HACK-CODE',
        program_code: 'HACK-PROG',
        task_number: 'HACK-TASK',
        finding_number: 'HACK-FIND',
        rec_number: 'HACK-REC',
        risk_id: 'HACK-RISK',
        employee_id: 'HACK-EMP',
        title: 'Updated Title',
      };

      const result = await BaseService.update('audit_plans', 1, data);

      // Only title should remain after stripping immutable fields
      expect(result.title).toBe('Updated Title');
      expect(result).not.toHaveProperty('plan_code');
      expect(result).not.toHaveProperty('program_code');
      expect(result).not.toHaveProperty('task_number');
      expect(result).not.toHaveProperty('finding_number');
      expect(result).not.toHaveProperty('rec_number');
      expect(result).not.toHaveProperty('risk_id');
      expect(result).not.toHaveProperty('employee_id');
    });

    it('should update record and return result', async () => {
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

    it('should throw ValidationError when no data provided after stripping immutable fields', async () => {
      // All provided fields are immutable
      const data = {
        id: 1,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
        plan_code: 'CODE',
        program_code: 'PROG',
      };

      await expect(
        BaseService.update('audit_plans', 1, data)
      ).rejects.toThrow(ValidationError);

      await expect(
        BaseService.update('audit_plans', 1, data)
      ).rejects.toThrow('No data provided for update');
    });
  });

  describe('delete', () => {
    it('should delete record and return true', async () => {
      mockRun.mockResolvedValueOnce({ changes: 1 });

      const result = await BaseService.delete('audit_plans', 1);

      expect(result).toBe(true);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM audit_plans WHERE id = ?')
      );
      expect(mockRun).toHaveBeenCalledWith(1);
    });
  });

  describe('sanitizeBody', () => {
    it('should convert empty string to null for fields ending with _id', async () => {
      // sanitizeBody is protected, so we test it indirectly through create
      // But we can access it via a workaround using update which also calls sanitizeBody
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { department_id: '', category_id: '', title: 'Test' };

      const result = await BaseService.update('audit_plans', 1, data);

      expect(result.department_id).toBeNull();
      expect(result.category_id).toBeNull();
    });

    it('should leave non-empty _id fields unchanged', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { department_id: 'dept-123', title: 'Test' };

      const result = await BaseService.update('audit_plans', 1, data);

      expect(result.department_id).toBe('dept-123');
    });

    it('should leave non-_id fields unchanged even if empty', async () => {
      mockGet.mockResolvedValueOnce({ id: 1 });

      const data = { title: '', description: '' };

      const result = await BaseService.update('audit_plans', 1, data);

      expect(result.title).toBe('');
      expect(result.description).toBe('');
    });
  });

  describe('logAudit', () => {
    it('should insert audit trail record with hash chaining', async () => {
      mockGet.mockResolvedValueOnce({ hash: 'previous-hash' });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await BaseService.logAudit('admin', 'create', 'AuditPlan', 'Created plan');

      // Verify the audit trail insert was called
      const insertCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it('should use "0" as previous hash when no prior records exist', async () => {
      mockGet.mockResolvedValueOnce(null); // No previous hash
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await BaseService.logAudit('admin', 'create', 'AuditPlan', 'First entry');

      // Verify run was called (audit was inserted)
      expect(mockRun).toHaveBeenCalled();
      // The previous_hash parameter should be '0'
      const runArgs = mockRun.mock.calls[0];
      expect(runArgs).toContain('0');
    });
  });
});

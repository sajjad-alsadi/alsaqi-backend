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

import { BulkOperationsService, BULK_ALLOWED_RESOURCES, MIN_BATCH_SIZE, MAX_BATCH_SIZE } from '../BulkOperationsService';
import { ValidationError } from '../../utils/errors';

describe('BulkOperationsService', () => {
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

  describe('validateBatchSize', () => {
    it('should accept batch size of 1', () => {
      expect(() => BulkOperationsService.validateBatchSize([{ title: 'test' }])).not.toThrow();
    });

    it('should accept batch size of 100', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ title: `item ${i}` }));
      expect(() => BulkOperationsService.validateBatchSize(items)).not.toThrow();
    });

    it('should reject empty array', () => {
      expect(() => BulkOperationsService.validateBatchSize([])).toThrow(ValidationError);
    });

    it('should reject batch size over 100', () => {
      const items = Array.from({ length: 101 }, (_, i) => ({ title: `item ${i}` }));
      expect(() => BulkOperationsService.validateBatchSize(items)).toThrow(ValidationError);
    });

    it('should reject non-array input', () => {
      expect(() => BulkOperationsService.validateBatchSize(null as any)).toThrow(ValidationError);
      expect(() => BulkOperationsService.validateBatchSize(undefined as any)).toThrow(ValidationError);
      expect(() => BulkOperationsService.validateBatchSize('string' as any)).toThrow(ValidationError);
    });
  });

  describe('resolveTable', () => {
    it('should resolve valid resource names to table names', () => {
      expect(BulkOperationsService.resolveTable('audit-plans')).toBe('audit_plans');
      expect(BulkOperationsService.resolveTable('recommendations')).toBe('recommendations');
      expect(BulkOperationsService.resolveTable('risk-register')).toBe('risk_register');
    });

    it('should throw ValidationError for unsupported resources', () => {
      expect(() => BulkOperationsService.resolveTable('invalid-resource')).toThrow(ValidationError);
      expect(() => BulkOperationsService.resolveTable('')).toThrow(ValidationError);
    });
  });

  describe('validateItems', () => {
    it('should return no errors for valid create items', () => {
      const items = [{ title: 'Plan A' }, { title: 'Plan B' }];
      const errors = BulkOperationsService.validateItems('create', items, 'audit_plans');
      expect(errors).toHaveLength(0);
    });

    it('should return no errors for valid update items', () => {
      const items = [{ id: 1, title: 'Updated' }, { id: 2, status: 'Active' }];
      const errors = BulkOperationsService.validateItems('update', items, 'audit_plans');
      expect(errors).toHaveLength(0);
    });

    it('should return no errors for valid delete items', () => {
      const items = [{ id: 1 }, { id: 2 }];
      const errors = BulkOperationsService.validateItems('delete', items, 'audit_plans');
      expect(errors).toHaveLength(0);
    });

    it('should return errors for create items with no fields', () => {
      const items = [{ id: 5 }]; // only id, which is excluded for create
      const errors = BulkOperationsService.validateItems('create', items, 'audit_plans');
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(0);
    });

    it('should return errors for update items without id', () => {
      const items = [{ title: 'No ID' }];
      const errors = BulkOperationsService.validateItems('update', items, 'audit_plans');
      expect(errors).toHaveLength(1);
      expect(errors[0].errors).toContain('Item must have an "id" field for update operations');
    });

    it('should return errors for update items with only id', () => {
      const items = [{ id: 1 }];
      const errors = BulkOperationsService.validateItems('update', items, 'audit_plans');
      expect(errors).toHaveLength(1);
      expect(errors[0].errors).toContain('Item must have at least one field to update besides "id"');
    });

    it('should return errors for delete items without id', () => {
      const items = [{ title: 'No ID' }];
      const errors = BulkOperationsService.validateItems('delete', items, 'audit_plans');
      expect(errors).toHaveLength(1);
      expect(errors[0].errors).toContain('Item must have an "id" field for delete operations');
    });

    it('should return errors for non-object items', () => {
      const items = [null, 'string', 42, []] as any[];
      const errors = BulkOperationsService.validateItems('create', items, 'audit_plans');
      expect(errors).toHaveLength(4);
    });

    it('should return per-item errors for mixed valid/invalid items', () => {
      const items = [
        { id: 1, title: 'Valid' },
        { title: 'Missing ID' },
        { id: 3, status: 'Active' },
      ];
      const errors = BulkOperationsService.validateItems('update', items, 'audit_plans');
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
    });
  });

  describe('execute', () => {
    it('should process bulk create successfully', async () => {
      const items = [{ title: 'Plan A' }, { title: 'Plan B' }];

      // Each create: INSERT RETURNING
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 2, changes: 1 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      const result = await BulkOperationsService.execute('audit-plans', 'create', items, 'admin');

      expect(result.processed).toBe(2);
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.details).toHaveLength(2);
      expect(result.details[0]).toEqual({ index: 0, id: 1, success: true });
      expect(result.details[1]).toEqual({ index: 1, id: 2, success: true });
    });

    it('should process bulk update successfully', async () => {
      const items = [
        { id: 1, status: 'Closed' },
        { id: 2, status: 'Closed' },
      ];

      // Each update: UPDATE RETURNING
      mockGet.mockResolvedValueOnce({ id: 1 });
      mockGet.mockResolvedValueOnce({ id: 2 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      const result = await BulkOperationsService.execute('recommendations', 'update', items, 'admin');

      expect(result.processed).toBe(2);
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should process bulk delete successfully', async () => {
      const items = [{ id: 1 }, { id: 2 }];

      // Each delete: UPDATE (soft delete) RETURNING
      mockGet.mockResolvedValueOnce({ id: 1 });
      mockGet.mockResolvedValueOnce({ id: 2 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      const result = await BulkOperationsService.execute('audit-plans', 'delete', items, 'admin');

      expect(result.processed).toBe(2);
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should reject entire batch when validation fails', async () => {
      const items = [
        { id: 1, title: 'Valid' },
        { title: 'Missing ID' }, // invalid for update
      ];

      await expect(
        BulkOperationsService.execute('audit-plans', 'update', items, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject batch with invalid batch size (empty)', async () => {
      await expect(
        BulkOperationsService.execute('audit-plans', 'create', [], 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject batch with invalid batch size (over 100)', async () => {
      const items = Array.from({ length: 101 }, (_, i) => ({ title: `item ${i}` }));
      await expect(
        BulkOperationsService.execute('audit-plans', 'create', items, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject unsupported resource', async () => {
      await expect(
        BulkOperationsService.execute('invalid-resource', 'create', [{ title: 'test' }], 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should rollback entire transaction on processing failure', async () => {
      const items = [{ title: 'Plan A' }, { title: 'Plan B' }];

      // First create succeeds
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });
      // Second create fails
      mockRun.mockRejectedValueOnce(new Error('DB constraint violation'));

      await expect(
        BulkOperationsService.execute('audit-plans', 'create', items, 'admin')
      ).rejects.toThrow('Processing failed at item index 1');
    });

    it('should rollback when update target not found', async () => {
      const items = [{ id: 999, status: 'Closed' }];

      // UPDATE returns null (record not found)
      mockGet.mockResolvedValueOnce(null);

      await expect(
        BulkOperationsService.execute('recommendations', 'update', items, 'admin')
      ).rejects.toThrow('Processing failed at item index 0');
    });

    it('should record a single audit log entry for the bulk operation', async () => {
      const items = [{ title: 'Plan A' }];

      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });
      // Audit: get previous hash
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      // Audit: insert
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      await BulkOperationsService.execute('audit-plans', 'create', items, 'admin');

      // Verify audit trail insert was called
      const auditCalls = mockPrepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_trail')
      );
      expect(auditCalls.length).toBe(1);
    });

    it('should return correct response structure', async () => {
      const items = [{ title: 'Plan A' }, { title: 'Plan B' }, { title: 'Plan C' }];

      mockRun.mockResolvedValueOnce({ lastInsertRowid: 10, changes: 1 });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 11, changes: 1 });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 12, changes: 1 });
      // Audit
      mockGet.mockResolvedValueOnce({ hash: 'prev-hash' });
      mockRun.mockResolvedValueOnce({ lastInsertRowid: 1, changes: 1 });

      const result = await BulkOperationsService.execute('audit-plans', 'create', items, 'admin');

      expect(result).toHaveProperty('processed', 3);
      expect(result).toHaveProperty('success', 3);
      expect(result).toHaveProperty('failed', 0);
      expect(result).toHaveProperty('details');
      expect(result.details).toHaveLength(3);
      result.details.forEach((detail, i) => {
        expect(detail).toHaveProperty('index', i);
        expect(detail).toHaveProperty('success', true);
        expect(detail).toHaveProperty('id');
      });
    });
  });
});

// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  const mockTransaction = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: mockTransaction,
    },
  };
});

import { PdfTemplateService } from '../PdfTemplateService';
import { db } from '../../db/index';
import { NotFoundError, ValidationError } from '../../utils/errors';

describe('PdfTemplateService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default transaction implementation: just execute the fn
    mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());
  });

  // ─── Helper: build a mock row as returned from DB ───────────────────────

  function makeMockRow(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'test-uuid-001',
      template_name: 'Test Template',
      template_type_key: 'audit_report',
      template_type: 'audit_report',
      content: '<h1>Hello</h1>',
      status: 'Draft',
      is_default: 0,
      version: 1,
      created_by: 'admin',
      updated_by: 'admin',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  // ─── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('should return all templates with boolean is_default', async () => {
      const rows = [
        makeMockRow({ is_default: 1 }),
        makeMockRow({ id: 'test-uuid-002', is_default: 0 }),
      ];
      mockDb.prepare.mockReturnValueOnce({ all: vi.fn().mockResolvedValue(rows) });

      const result = await PdfTemplateService.getAll();

      expect(result).toHaveLength(2);
      expect(result[0].is_default).toBe(true);
      expect(result[1].is_default).toBe(false);
    });

    it('should return empty array when no templates exist', async () => {
      mockDb.prepare.mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) });

      const result = await PdfTemplateService.getAll();
      expect(result).toEqual([]);
    });
  });

  // ─── getById ────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('should return template with boolean is_default when found', async () => {
      const row = makeMockRow({ is_default: 1 });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(row) });

      const result = await PdfTemplateService.getById('test-uuid-001');

      expect(result.id).toBe('test-uuid-001');
      expect(result.is_default).toBe(true);
    });

    it('should throw NotFoundError when template does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(undefined) });

      await expect(PdfTemplateService.getById('nonexistent')).rejects.toThrow(NotFoundError);
    });
  });

  // ─── getActiveByType ────────────────────────────────────────────────────

  describe('getActiveByType', () => {
    it('should return the default approved template for a type', async () => {
      const row = makeMockRow({ status: 'Approved', is_default: 1 });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(row) });

      const result = await PdfTemplateService.getActiveByType('audit_report');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('Approved');
      expect(result!.is_default).toBe(true);
    });

    it('should return null when no default approved template exists', async () => {
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(undefined) });

      const result = await PdfTemplateService.getActiveByType('audit_report');
      expect(result).toBeNull();
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    const validData = {
      template_name: 'New Template',
      template_type_key: 'audit_report' as const,
      content: '<h1>Report</h1>',
    };

    it('should create a template with version=1', async () => {
      const returnedRow = makeMockRow({
        template_name: validData.template_name,
        template_type_key: validData.template_type_key,
        content: validData.content,
        version: 1,
      });

      // INSERT RETURNING *
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(returnedRow) });

      const result = await PdfTemplateService.create(validData, 'admin');

      expect(result.version).toBe(1);
      expect(result.template_name).toBe('New Template');
    });

    it('should reject when template_name exceeds 200 characters', async () => {
      const longName = 'a'.repeat(201);

      await expect(
        PdfTemplateService.create({ ...validData, template_name: longName }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject when content exceeds 500KB', async () => {
      const bigContent = 'x'.repeat(500 * 1024 + 1);

      await expect(
        PdfTemplateService.create({ ...validData, content: bigContent }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject an invalid template_type_key', async () => {
      await expect(
        PdfTemplateService.create(
          { ...validData, template_type_key: 'invalid_key' as any },
          'admin'
        )
      ).rejects.toThrow(ValidationError);
    });

    it('should reject missing required fields', async () => {
      await expect(
        PdfTemplateService.create({ template_name: '', template_type_key: 'audit_report' as any, content: '' }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should unset previous default when is_default is true', async () => {
      const returnedRow = makeMockRow({
        ...validData,
        status: 'Approved',
        is_default: 1,
        version: 1,
      });

      // First call: UPDATE to unset previous defaults
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });
      mockDb.prepare.mockReturnValueOnce({ run: mockRun });
      // Second call: INSERT RETURNING *
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(returnedRow) });

      await PdfTemplateService.create(
        { ...validData, is_default: true, status: 'Approved' },
        'admin'
      );

      // Verify UPDATE was called to unset defaults
      expect(mockRun).toHaveBeenCalled();
    });

    it('should reject setting non-Approved template as default', async () => {
      await expect(
        PdfTemplateService.create({ ...validData, is_default: true, status: 'Draft' }, 'admin')
      ).rejects.toThrow(ValidationError);
    });
  });

  // ─── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('should increment version when content changes', async () => {
      const existingRow = makeMockRow({ version: 3, content: 'old content' });
      const updatedRow = makeMockRow({ version: 4, content: 'new content' });

      // getById
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });
      // UPDATE RETURNING *
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(updatedRow) });

      const result = await PdfTemplateService.update(
        'test-uuid-001',
        { content: 'new content' },
        'editor'
      );

      expect(result.version).toBe(4);
    });

    it('should NOT increment version for metadata-only update', async () => {
      const existingRow = makeMockRow({ version: 3, template_name: 'Old Name' });
      const updatedRow = makeMockRow({ version: 3, template_name: 'New Name' });

      // getById
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });
      // UPDATE RETURNING *
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(updatedRow) });

      const result = await PdfTemplateService.update(
        'test-uuid-001',
        { template_name: 'New Name' },
        'editor'
      );

      expect(result.version).toBe(3);
    });

    it('should reject content exceeding 500KB', async () => {
      const existingRow = makeMockRow();
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });

      const bigContent = 'x'.repeat(500 * 1024 + 1);

      await expect(
        PdfTemplateService.update('test-uuid-001', { content: bigContent }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject template_name exceeding 200 characters', async () => {
      const existingRow = makeMockRow();
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });

      const longName = 'a'.repeat(201);

      await expect(
        PdfTemplateService.update('test-uuid-001', { template_name: longName }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject setting non-Approved template as default', async () => {
      const existingRow = makeMockRow({ status: 'Draft' });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });

      await expect(
        PdfTemplateService.update('test-uuid-001', { is_default: true }, 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should unset previous defaults when setting new default', async () => {
      const existingRow = makeMockRow({ status: 'Approved' });
      const updatedRow = makeMockRow({ status: 'Approved', is_default: 1 });

      // getById
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });
      // UPDATE unset previous defaults
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });
      mockDb.prepare.mockReturnValueOnce({ run: mockRun });
      // UPDATE RETURNING *
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(updatedRow) });

      await PdfTemplateService.update('test-uuid-001', { is_default: true }, 'admin');

      expect(mockRun).toHaveBeenCalled();
    });
  });

  // ─── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should delete a non-default template', async () => {
      const existingRow = makeMockRow({ is_default: 0, status: 'Draft' });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });
      mockDb.prepare.mockReturnValueOnce({ run: vi.fn().mockResolvedValue({ changes: 1 }) });

      await expect(PdfTemplateService.delete('test-uuid-001', 'admin')).resolves.toBeUndefined();
    });

    it('should reject deleting a default approved template', async () => {
      const existingRow = makeMockRow({ is_default: 1, status: 'Approved' });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });

      await expect(
        PdfTemplateService.delete('test-uuid-001', 'admin')
      ).rejects.toThrow(ValidationError);
    });

    it('should allow deleting a default Draft template', async () => {
      const existingRow = makeMockRow({ is_default: 1, status: 'Draft' });
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(existingRow) });
      mockDb.prepare.mockReturnValueOnce({ run: vi.fn().mockResolvedValue({ changes: 1 }) });

      await expect(PdfTemplateService.delete('test-uuid-001', 'admin')).resolves.toBeUndefined();
    });

    it('should throw NotFoundError if template does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({ get: vi.fn().mockResolvedValue(undefined) });

      await expect(PdfTemplateService.delete('nonexistent', 'admin')).rejects.toThrow(
        NotFoundError
      );
    });
  });
});

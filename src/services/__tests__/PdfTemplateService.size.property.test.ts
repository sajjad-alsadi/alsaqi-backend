// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test: Content Size Limit Enforcement (Property 7)
 *
 * Feature: pdf-template-system-overhaul
 *
 * **Validates: Requirements 9.3**
 *
 * For any content string with Buffer.byteLength > 500*1024 bytes,
 * PdfTemplateService.create/update should reject with a ValidationError.
 * For any content string with Buffer.byteLength <= 500*1024 bytes
 * (and other valid fields), PdfTemplateService.create/update should NOT
 * throw a ValidationError about content size.
 */

// ─── Mock the db module ──────────────────────────────────────────────────────

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
import { ValidationError } from '../../utils/errors';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CONTENT_BYTES = 500 * 1024; // 500 KB

// ─── Test Setup ──────────────────────────────────────────────────────────────

describe('Property 7: Content size limit enforcement', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default transaction implementation: just execute the fn
    mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());
  });

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

  // ─── Property: Content exceeding 500KB is rejected on create ─────────────

  it('create rejects content exceeding 500KB', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a string length that will exceed 500KB.
        // ASCII chars are 1 byte each, so length > 500*1024 guarantees > 500KB.
        fc.integer({ min: MAX_CONTENT_BYTES + 1, max: MAX_CONTENT_BYTES + 1024 }),
        async (contentLength) => {
          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const content = 'x'.repeat(contentLength);

          // Sanity: byte length exceeds 500KB
          expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_CONTENT_BYTES);

          await expect(
            PdfTemplateService.create(
              {
                template_name: 'Test Template',
                template_type_key: 'audit_report',
                content,
              },
              'admin'
            )
          ).rejects.toThrow(ValidationError);
        }
      ),
      { numRuns: 20 }
    );
  });

  // ─── Property: Content ≤ 500KB is accepted on create ─────────────────────

  it('create accepts content at or below 500KB', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate lengths from 1 up to exactly 500KB (valid range).
        // Use smaller values to keep test fast — the property holds at any size ≤ 500KB.
        fc.integer({ min: 1, max: 2048 }),
        async (contentLength) => {
          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const content = 'a'.repeat(contentLength);

          // Sanity: byte length is within limit
          expect(Buffer.byteLength(content, 'utf-8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES);

          // Mock INSERT RETURNING * to return a valid row
          const returnedRow = makeMockRow({
            template_name: 'Test Template',
            template_type_key: 'audit_report',
            content,
            version: 1,
          });
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(returnedRow),
          });

          // Should NOT throw a ValidationError about content size
          const result = await PdfTemplateService.create(
            {
              template_name: 'Test Template',
              template_type_key: 'audit_report',
              content,
            },
            'admin'
          );

          expect(result).toBeDefined();
          expect(result.template_name).toBe('Test Template');
        }
      ),
      { numRuns: 10 }
    );
  });

  // ─── Property: Boundary — content at exactly 500KB is accepted on create ─

  it('create accepts content at exactly 500KB boundary', async () => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

    const content = 'z'.repeat(MAX_CONTENT_BYTES);
    expect(Buffer.byteLength(content, 'utf-8')).toBe(MAX_CONTENT_BYTES);

    const returnedRow = makeMockRow({
      template_name: 'Boundary Template',
      template_type_key: 'audit_report',
      content,
      version: 1,
    });
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(returnedRow),
    });

    const result = await PdfTemplateService.create(
      {
        template_name: 'Boundary Template',
        template_type_key: 'audit_report',
        content,
      },
      'admin'
    );

    expect(result).toBeDefined();
  });

  // ─── Property: Content exceeding 500KB is rejected on update ─────────────

  it('update rejects content exceeding 500KB', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MAX_CONTENT_BYTES + 1, max: MAX_CONTENT_BYTES + 1024 }),
        async (contentLength) => {
          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const content = 'x'.repeat(contentLength);

          expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_CONTENT_BYTES);

          // Mock getById (called at start of update)
          const existingRow = makeMockRow();
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(existingRow),
          });

          await expect(
            PdfTemplateService.update('test-uuid-001', { content }, 'admin')
          ).rejects.toThrow(ValidationError);
        }
      ),
      { numRuns: 20 }
    );
  });

  // ─── Property: Content ≤ 500KB is accepted on update ─────────────────────

  it('update accepts content at or below 500KB', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2048 }),
        async (contentLength) => {
          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const content = 'b'.repeat(contentLength);

          expect(Buffer.byteLength(content, 'utf-8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES);

          // Mock getById
          const existingRow = makeMockRow({ content: 'old content' });
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(existingRow),
          });

          // Mock UPDATE RETURNING *
          const updatedRow = makeMockRow({ content, version: 2 });
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(updatedRow),
          });

          // Should NOT throw a ValidationError about content size
          const result = await PdfTemplateService.update(
            'test-uuid-001',
            { content },
            'admin'
          );

          expect(result).toBeDefined();
        }
      ),
      { numRuns: 10 }
    );
  });
});

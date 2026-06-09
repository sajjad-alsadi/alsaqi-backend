// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test: Version increment and audit trail (Property 9)
 *
 * Feature: pdf-template-system-overhaul
 *
 * **Validates: Requirements 1.3, 1.4**
 *
 * Properties verified:
 * 1. For any template at version N, updating the `content` field produces version N+1
 * 2. Updating only metadata (template_name, status) does NOT change the version (stays at N)
 * 3. After any update, `updated_by` matches the username passed to the update function
 * 4. After any update, `updated_at` is a recent timestamp
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

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

const mockDb = db as any;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for valid version numbers (positive integers) */
const versionArb = fc.integer({ min: 1, max: 1000 });

/** Arbitrary for non-empty content strings (≤500KB) */
const contentArb = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary for valid template_name (≤200 chars, non-empty) */
const templateNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);

/** Arbitrary for valid usernames (non-empty, no whitespace-only) */
const usernameArb = fc.stringMatching(/^[a-zA-Z0-9_.-]{1,30}$/);

/** Arbitrary for valid template status */
const statusArb = fc.constantFrom('Draft' as const, 'Approved' as const, 'Archived' as const);

/** Arbitrary for valid template type keys */
const templateTypeKeyArb = fc.constantFrom(
  'audit_report',
  'quarterly_report',
  'annual_report',
  'audit_plan',
  'audit_missions',
  'recommendations',
  'outgoing_letter',
  'general'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'test-uuid-001',
    template_name: 'Test Template',
    template_type_key: 'audit_report',
    template_type: 'audit_report',
    content: '<h1>Original Content</h1>',
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

/**
 * Sets up mocks for a single update call.
 * The UPDATE mock captures the arguments passed by the service and reflects them in the row.
 */
function setupUpdateMocks(existingRow: Record<string, any>) {
  // getById call (first prepare)
  mockDb.prepare.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue(existingRow),
  });
  // UPDATE RETURNING * call (second prepare)
  // This mock captures the actual args the service passes to the DB
  mockDb.prepare.mockReturnValueOnce({
    get: vi.fn().mockImplementation(
      (
        _templateName: any,
        _content: any,
        _status: any,
        _isDefault: any,
        version: number,
        updatedBy: string,
        updatedAt: string,
        _id: string
      ) => {
        return Promise.resolve({
          ...existingRow,
          template_name: _templateName ?? existingRow.template_name,
          content: _content ?? existingRow.content,
          status: _status ?? existingRow.status,
          is_default: _isDefault ?? existingRow.is_default,
          version,
          updated_by: updatedBy,
          updated_at: updatedAt,
        });
      }
    ),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PdfTemplateService — Property 9: Version increment and audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());
  });

  it('content update increments version from N to N+1', async () => {
    await fc.assert(
      fc.asyncProperty(
        versionArb,
        contentArb,
        contentArb,
        usernameArb,
        templateTypeKeyArb,
        async (currentVersion, existingContent, newContent, username, typeKey) => {
          // Ensure content actually differs
          fc.pre(newContent !== existingContent);

          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const existingRow = makeMockRow({
            version: currentVersion,
            content: existingContent,
            template_type_key: typeKey,
          });

          setupUpdateMocks(existingRow);

          const result = await PdfTemplateService.update(
            'test-uuid-001',
            { content: newContent },
            username
          );

          // Property: version should be N+1
          expect(result.version).toBe(currentVersion + 1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('metadata-only update does NOT change version (stays at N)', async () => {
    await fc.assert(
      fc.asyncProperty(
        versionArb,
        templateNameArb,
        usernameArb,
        statusArb,
        templateTypeKeyArb,
        async (currentVersion, newName, username, newStatus, typeKey) => {
          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const existingRow = makeMockRow({
            version: currentVersion,
            template_name: 'Old Name',
            status: 'Draft',
            template_type_key: typeKey,
          });

          setupUpdateMocks(existingRow);

          const result = await PdfTemplateService.update(
            'test-uuid-001',
            { template_name: newName, status: newStatus },
            username
          );

          // Property: version should stay at N (no content change)
          expect(result.version).toBe(currentVersion);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('updated_by matches the username passed to the update function', async () => {
    await fc.assert(
      fc.asyncProperty(
        versionArb,
        contentArb,
        usernameArb,
        templateTypeKeyArb,
        async (currentVersion, newContent, username, typeKey) => {
          // Ensure content differs from existing
          fc.pre(newContent !== '<h1>Original Content</h1>');

          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const existingRow = makeMockRow({
            version: currentVersion,
            template_type_key: typeKey,
          });

          setupUpdateMocks(existingRow);

          const result = await PdfTemplateService.update(
            'test-uuid-001',
            { content: newContent },
            username
          );

          // Property: updated_by matches the username
          expect(result.updated_by).toBe(username);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('updated_at is a recent timestamp after any update', async () => {
    await fc.assert(
      fc.asyncProperty(
        versionArb,
        contentArb,
        usernameArb,
        templateTypeKeyArb,
        async (currentVersion, newContent, username, typeKey) => {
          fc.pre(newContent !== '<h1>Original Content</h1>');

          vi.clearAllMocks();
          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          const existingRow = makeMockRow({
            version: currentVersion,
            template_type_key: typeKey,
          });

          const beforeUpdate = Date.now();

          setupUpdateMocks(existingRow);

          const result = await PdfTemplateService.update(
            'test-uuid-001',
            { content: newContent },
            username
          );

          const afterUpdate = Date.now();

          // Property: updated_at is a valid ISO timestamp within the test execution window
          const updatedAtMs = new Date(result.updated_at).getTime();
          expect(updatedAtMs).toBeGreaterThanOrEqual(beforeUpdate);
          expect(updatedAtMs).toBeLessThanOrEqual(afterUpdate);
        }
      ),
      { numRuns: 100 }
    );
  });
});

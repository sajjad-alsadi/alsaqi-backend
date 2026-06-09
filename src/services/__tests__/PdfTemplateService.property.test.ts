// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for PdfTemplateService (Property 1)
 *
 * Feature: pdf-template-system-overhaul
 *
 * Property 1: One default template per type
 * After any sequence of setDefault operations for the same TemplateTypeKey,
 * at most one template has is_default=true and status='Approved'.
 *
 * **Validates: Requirements 2.1, 2.3**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn()),
    },
  };
});

import { PdfTemplateService } from '../PdfTemplateService';
import { db } from '../../db/index';
import type { TemplateTypeKey } from '../../constants/templateTypes';
import type { PdfTemplateRow } from '../../types/pdf';

// ─── In-memory store to simulate DB state ────────────────────────────────────

interface InMemoryTemplate {
  id: string;
  template_name: string;
  template_type_key: TemplateTypeKey;
  template_type: string;
  content: string;
  status: 'Draft' | 'Approved' | 'Archived';
  is_default: number; // 0 or 1
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const VALID_TYPE_KEYS: TemplateTypeKey[] = [
  'audit_report',
  'quarterly_report',
  'annual_report',
  'audit_plan',
  'audit_missions',
  'recommendations',
  'outgoing_letter',
  'general',
];

/** Arbitrary for a valid TemplateTypeKey */
const templateTypeKeyArb = fc.constantFrom(...VALID_TYPE_KEYS);

/** Arbitrary for a valid template name (≤200 chars, non-empty) */
const templateNameArb = fc.string({ minLength: 1, maxLength: 50 });

/** Arbitrary for valid content (non-empty, ≤500KB — we keep it small for tests) */
const templateContentArb = fc.string({ minLength: 1, maxLength: 200 }).map(
  (s) => `<h1>${s}</h1>`
);

/** Arbitrary for a username */
const usernameArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

/**
 * Arbitrary for a sequence of "set default" operations on templates of the same type.
 * Each operation is represented by a template index (which template to make default).
 */
const setDefaultSequenceArb = fc.integer({ min: 1, max: 5 }).chain((numTemplates) =>
  fc.tuple(
    fc.constant(numTemplates),
    fc.array(fc.integer({ min: 0, max: numTemplates - 1 }), { minLength: 1, maxLength: 10 })
  )
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 1: One default template per type', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 2.1, 2.3**
   *
   * For any TemplateTypeKey and any sequence of setDefault operations
   * (creating templates with is_default=true, or updating templates to is_default=true),
   * calling getActiveByType returns at most one template with status 'Approved'
   * and is_default = true.
   *
   * Strategy: Simulate an in-memory DB. For each setDefault operation,
   * mock the database calls to reflect PdfTemplateService's behavior,
   * then verify the invariant after the entire sequence.
   */
  it('after any sequence of setDefault operations on same type, at most one template is default+approved', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateTypeKeyArb,
        setDefaultSequenceArb,
        usernameArb,
        async (typeKey, [numTemplates, setDefaultOps], username) => {
          vi.clearAllMocks();

          // ── In-memory database simulation ──
          const templates: InMemoryTemplate[] = [];
          let idCounter = 0;

          // Create N Approved templates for this type (none are default yet)
          for (let i = 0; i < numTemplates; i++) {
            idCounter++;
            templates.push({
              id: `tpl-${idCounter}`,
              template_name: `Template ${idCounter}`,
              template_type_key: typeKey,
              template_type: typeKey,
              content: `<h1>Content ${idCounter}</h1>`,
              status: 'Approved',
              is_default: 0,
              version: 1,
              created_by: username,
              updated_by: username,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }

          // ── Apply setDefault sequence via PdfTemplateService.update ──
          for (const templateIdx of setDefaultOps) {
            const targetTemplate = templates[templateIdx];
            vi.clearAllMocks();

            // Mock getById (first db.prepare call in update)
            mockDb.prepare.mockImplementation((sql: string) => {
              // getById SELECT
              if (sql.includes('SELECT') && sql.includes('WHERE id')) {
                return {
                  get: vi.fn().mockResolvedValue({ ...targetTemplate }),
                };
              }
              // UPDATE to unset previous defaults
              if (sql.includes('UPDATE') && sql.includes('is_default = 0')) {
                return {
                  run: vi.fn().mockImplementation(async () => {
                    // Simulate unsetting all defaults for this type
                    for (const t of templates) {
                      if (t.template_type_key === typeKey && t.is_default === 1) {
                        t.is_default = 0;
                      }
                    }
                    return { changes: 1 };
                  }),
                };
              }
              // UPDATE RETURNING * (the actual update)
              if (sql.includes('UPDATE') && sql.includes('RETURNING')) {
                return {
                  get: vi.fn().mockImplementation(async () => {
                    // Set the target template as default
                    targetTemplate.is_default = 1;
                    targetTemplate.updated_by = username;
                    targetTemplate.updated_at = new Date().toISOString();
                    return { ...targetTemplate };
                  }),
                };
              }
              // Fallback
              return { get: vi.fn().mockResolvedValue(undefined), run: vi.fn() };
            });

            // Execute update with is_default=true
            await PdfTemplateService.update(
              targetTemplate.id,
              { is_default: true },
              username
            );
          }

          // ── Verify invariant: at most one default+approved per type ──
          const defaultApproved = templates.filter(
            (t) =>
              t.template_type_key === typeKey &&
              t.is_default === 1 &&
              t.status === 'Approved'
          );

          // Property: at most one default approved template per type
          expect(defaultApproved.length).toBeLessThanOrEqual(1);

          // Also verify via getActiveByType mock
          vi.clearAllMocks();
          const activeTemplate = defaultApproved.length > 0 ? defaultApproved[0] : undefined;
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(activeTemplate),
          });

          const result = await PdfTemplateService.getActiveByType(typeKey);

          if (defaultApproved.length === 0) {
            expect(result).toBeNull();
          } else {
            expect(result).not.toBeNull();
            expect(result!.is_default).toBe(true);
            expect(result!.status).toBe('Approved');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.1, 2.3**
   *
   * Creating a new template with is_default=true for a type that already
   * has a default approved template results in exactly one default.
   * The previous default is unset.
   */
  it('creating a new default template unsets the previous default for same type', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateTypeKeyArb,
        templateNameArb,
        templateContentArb,
        usernameArb,
        async (typeKey, name, content, username) => {
          vi.clearAllMocks();

          // ── Simulate existing default template in DB ──
          const existingDefault: InMemoryTemplate = {
            id: 'existing-default-id',
            template_name: 'Existing Default',
            template_type_key: typeKey,
            template_type: typeKey,
            content: '<h1>Old default</h1>',
            status: 'Approved',
            is_default: 1,
            version: 1,
            created_by: 'system',
            updated_by: 'system',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          };

          let previousDefaultUnset = false;

          mockDb.transaction.mockImplementation(async (fn: () => Promise<any>) => fn());

          mockDb.prepare.mockImplementation((sql: string) => {
            // UPDATE to unset previous defaults (during create with is_default=true)
            if (sql.includes('UPDATE') && sql.includes('is_default = 0')) {
              return {
                run: vi.fn().mockImplementation(async () => {
                  existingDefault.is_default = 0;
                  previousDefaultUnset = true;
                  return { changes: 1 };
                }),
              };
            }
            // INSERT RETURNING * (the new template)
            if (sql.includes('INSERT')) {
              return {
                get: vi.fn().mockImplementation(async () => {
                  return {
                    id: 'new-tpl-id',
                    template_name: name,
                    template_type_key: typeKey,
                    template_type: typeKey,
                    content,
                    status: 'Approved',
                    is_default: 1,
                    version: 1,
                    created_by: username,
                    updated_by: username,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  };
                }),
              };
            }
            return { get: vi.fn().mockResolvedValue(undefined), run: vi.fn() };
          });

          const result = await PdfTemplateService.create(
            {
              template_name: name,
              template_type_key: typeKey,
              content,
              status: 'Approved',
              is_default: true,
            },
            username
          );

          // The new template is default
          expect(result.is_default).toBe(true);
          expect(result.status).toBe('Approved');

          // The previous default was unset
          expect(previousDefaultUnset).toBe(true);
          expect(existingDefault.is_default).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

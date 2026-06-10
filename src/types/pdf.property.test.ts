// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mapRowToTemplate, mapRowToSettings } from './pdf';
import type { PdfTemplateRow, PdfSettingsRow } from './pdf';
import { TEMPLATE_TYPES } from '../constants/templateTypes';

/**
 * Property Test: is_default number ↔ boolean conversion (Property 8)
 *
 * Feature: pdf-template-system-overhaul
 * Property 8: تحويل الصف — is_default (number ↔ boolean)
 *
 * **Validates: Requirements 1.5**
 *
 * For any PdfTemplateRow where is_default = 0 or 1, mapRowToTemplate returns
 * a PdfTemplate with is_default = false or true respectively.
 * For mapRowToSettings: rtl_enabled and show_page_number follow the same pattern.
 * The conversion is consistent regardless of other field values.
 */

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const templateTypeKeyArb = fc.constantFrom(
  ...TEMPLATE_TYPES.map((t) => t.key)
);

const statusArb = fc.constantFrom('Draft', 'Approved', 'Archived');

const numericBoolArb = fc.constantFrom(0, 1);

/** Generates an arbitrary PdfTemplateRow with controlled is_default */
const pdfTemplateRowArb = (isDefault: number): fc.Arbitrary<PdfTemplateRow> =>
  fc.record({
    id: fc.uuid(),
    template_name: fc.string({ minLength: 1, maxLength: 200 }),
    template_type_key: templateTypeKeyArb,
    template_type: fc.string({ minLength: 1, maxLength: 50 }),
    content: fc.string({ minLength: 0, maxLength: 1000 }),
    status: statusArb,
    is_default: fc.constant(isDefault),
    version: fc.nat({ max: 1000 }),
    created_by: fc.string({ minLength: 1, maxLength: 50 }),
    updated_by: fc.string({ minLength: 1, maxLength: 50 }),
    created_at: fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString()),
    updated_at: fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString()),
  });

/** Generates an arbitrary PdfSettingsRow with controlled rtl_enabled and show_page_number */
const pdfSettingsRowArb = (
  rtlEnabled: number,
  showPageNumber: number
): fc.Arbitrary<PdfSettingsRow> =>
  fc.record({
    id: fc.nat({ max: 100 }),
    arabic_font_name: fc.string({ minLength: 1, maxLength: 50 }),
    arabic_font_size: fc.integer({ min: 8, max: 72 }),
    heading_font_size: fc.integer({ min: 10, max: 72 }),
    subheading_font_size: fc.integer({ min: 8, max: 60 }),
    table_font_size: fc.integer({ min: 6, max: 36 }),
    rtl_enabled: fc.constant(rtlEnabled),
    margin_top: fc.integer({ min: 0, max: 100 }),
    margin_right: fc.integer({ min: 0, max: 100 }),
    margin_bottom: fc.integer({ min: 0, max: 100 }),
    margin_left: fc.integer({ min: 0, max: 100 }),
    header_template: fc.oneof(fc.string({ minLength: 1, maxLength: 200 }), fc.constant(null)),
    footer_template: fc.oneof(fc.string({ minLength: 1, maxLength: 200 }), fc.constant(null)),
    logo_position: fc.constantFrom('left', 'center', 'right', 'none'),
    show_page_number: fc.constant(showPageNumber),
  });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 8: is_default number ↔ boolean conversion', () => {
  it('mapRowToTemplate converts is_default=0 to false for any row', () => {
    fc.assert(
      fc.property(pdfTemplateRowArb(0), (row) => {
        const result = mapRowToTemplate(row);
        expect(result.is_default).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('mapRowToTemplate converts is_default=1 to true for any row', () => {
    fc.assert(
      fc.property(pdfTemplateRowArb(1), (row) => {
        const result = mapRowToTemplate(row);
        expect(result.is_default).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('mapRowToTemplate preserves boolean semantics for any is_default (0 or 1)', () => {
    fc.assert(
      fc.property(numericBoolArb, templateTypeKeyArb, statusArb, fc.uuid(), fc.string(), fc.string(), fc.nat(), fc.string(), fc.string(),
        (isDefault, typeKey, status, id, name, content, version, createdBy, updatedBy) => {
          const row: PdfTemplateRow = {
            id,
            template_name: name,
            template_type_key: typeKey,
            template_type: 'any',
            content,
            status,
            is_default: isDefault,
            version,
            created_by: createdBy,
            updated_by: updatedBy,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          const result = mapRowToTemplate(row);
          expect(result.is_default).toBe(isDefault === 1);
          expect(typeof result.is_default).toBe('boolean');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('mapRowToSettings converts rtl_enabled=0 to false', () => {
    fc.assert(
      fc.property(pdfSettingsRowArb(0, 0), (row) => {
        const result = mapRowToSettings(row);
        expect(result.rtl_enabled).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('mapRowToSettings converts rtl_enabled=1 to true', () => {
    fc.assert(
      fc.property(pdfSettingsRowArb(1, 0), (row) => {
        const result = mapRowToSettings(row);
        expect(result.rtl_enabled).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('mapRowToSettings converts show_page_number=0 to false', () => {
    fc.assert(
      fc.property(pdfSettingsRowArb(0, 0), (row) => {
        const result = mapRowToSettings(row);
        expect(result.show_page_number).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('mapRowToSettings converts show_page_number=1 to true', () => {
    fc.assert(
      fc.property(pdfSettingsRowArb(0, 1), (row) => {
        const result = mapRowToSettings(row);
        expect(result.show_page_number).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('mapRowToSettings boolean conversion is consistent for all combinations of rtl_enabled and show_page_number', () => {
    fc.assert(
      fc.property(numericBoolArb, numericBoolArb, (rtl, pageNum) => {
        const row: PdfSettingsRow = {
          id: 1,
          arabic_font_name: 'Tahoma',
          arabic_font_size: 14,
          heading_font_size: 18,
          subheading_font_size: 16,
          table_font_size: 10,
          rtl_enabled: rtl,
          margin_top: 20,
          margin_right: 15,
          margin_bottom: 20,
          margin_left: 15,
          header_template: null,
          footer_template: null,
          logo_position: 'right',
          show_page_number: pageNum,
        };
        const result = mapRowToSettings(row);
        expect(result.rtl_enabled).toBe(rtl === 1);
        expect(result.show_page_number).toBe(pageNum === 1);
        expect(typeof result.rtl_enabled).toBe('boolean');
        expect(typeof result.show_page_number).toBe('boolean');
      }),
      { numRuns: 100 }
    );
  });
});

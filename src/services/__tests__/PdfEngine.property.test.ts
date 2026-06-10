// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for PdfEngine (Property 3)
 *
 * Feature: pdf-template-system-overhaul
 *
 * Property 3: renderFromTemplate produces structurally valid PDF
 * For any valid RenderOptions (with or without a stored template), the result has:
 *   - buffer.length > 0
 *   - Buffer starts with '%PDF-'
 *   - fileSize === buffer.length
 *
 * **Validates: Requirements 4.1, 4.2, 4.3**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock BrowserPool before importing PdfEngine
// Note: vi.mock is hoisted, so we cannot reference top-level variables.
// The PDF buffer is created inline inside the factory.
vi.mock('../BrowserPool', () => {
  const pdfBuffer = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );

  const mockPage = {
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    setContent: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn().mockResolvedValue(pdfBuffer),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    connected: true,
  };

  return {
    browserPool: {
      acquire: vi.fn().mockResolvedValue(mockBrowser),
      release: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock logger to avoid noise
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PdfEngine } from '../PdfEngine';
import type { PdfSettings, PdfTemplate, RenderOptions } from '../../types/pdf';
import type { TemplateTypeKey } from '../../constants/templateTypes';

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

/** Arbitrary for a valid language */
const languageArb = fc.constantFrom<'ar' | 'en'>('ar', 'en');

/** Arbitrary for valid PdfSettings */
const pdfSettingsArb: fc.Arbitrary<PdfSettings> = fc.record({
  arabic_font_name: fc.constantFrom('Tahoma', 'Amiri', 'Arial'),
  arabic_font_size: fc.integer({ min: 8, max: 24 }),
  heading_font_size: fc.integer({ min: 12, max: 36 }),
  subheading_font_size: fc.integer({ min: 10, max: 24 }),
  table_font_size: fc.integer({ min: 8, max: 16 }),
  rtl_enabled: fc.boolean(),
  margin_top: fc.integer({ min: 5, max: 50 }),
  margin_right: fc.integer({ min: 5, max: 50 }),
  margin_bottom: fc.integer({ min: 5, max: 50 }),
  margin_left: fc.integer({ min: 5, max: 50 }),
  header_template: fc.oneof(fc.constant(null), fc.constant('<div>Header</div>')),
  footer_template: fc.oneof(fc.constant(null), fc.constant('<div>Footer</div>')),
  logo_position: fc.constantFrom<'left' | 'center' | 'right' | 'none'>(
    'left',
    'center',
    'right',
    'none'
  ),
  show_page_number: fc.boolean(),
});

/** Arbitrary for template data (Record<string, unknown>) */
const dataArb = fc.record({
  auditTitle: fc.string({ minLength: 1, maxLength: 50 }),
  auditDate: fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString().slice(0, 10)),
  auditorName: fc.string({ minLength: 1, maxLength: 30 }),
  departmentName: fc.string({ minLength: 1, maxLength: 30 }),
  findings: fc.array(
    fc.record({
      title: fc.string({ minLength: 1, maxLength: 30 }),
      description: fc.string({ maxLength: 50 }),
      risk_level: fc.constantFrom('High', 'Medium', 'Low'),
    }),
    { minLength: 0, maxLength: 3 }
  ),
});

/** Arbitrary for a valid PdfTemplate (with valid Handlebars) */
const pdfTemplateArb: fc.Arbitrary<PdfTemplate> = fc.record({
  id: fc.uuid(),
  template_name: fc.string({ minLength: 1, maxLength: 50 }),
  template_type_key: fc.constantFrom(...VALID_TYPE_KEYS),
  content: fc.constantFrom(
    '<h1>{{auditTitle}}</h1><p>{{auditDate}}</p>',
    '<div>{{auditorName}} - {{departmentName}}</div>',
    '<h1>Report</h1>{{#each findings}}<p>{{title}}</p>{{/each}}'
  ),
  status: fc.constant<'Approved'>('Approved'),
  is_default: fc.boolean(),
  version: fc.integer({ min: 1, max: 100 }),
  created_by: fc.string({ minLength: 1, maxLength: 20 }),
  updated_by: fc.string({ minLength: 1, maxLength: 20 }),
  created_at: fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString()),
  updated_at: fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString()),
});

/** Arbitrary for RenderOptions WITH a template */
const renderOptionsWithTemplateArb: fc.Arbitrary<RenderOptions> = fc.record({
  template: pdfTemplateArb,
  data: dataArb,
  settings: pdfSettingsArb,
  language: languageArb,
});

/** Arbitrary for RenderOptions WITHOUT a template (uses fallback) */
const renderOptionsWithoutTemplateArb: fc.Arbitrary<RenderOptions> = fc.record({
  data: dataArb,
  settings: pdfSettingsArb,
  language: languageArb,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 3: renderFromTemplate produces structurally valid PDF', () => {
  let engine: PdfEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PdfEngine();
  });

  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * For any valid RenderOptions with a stored template,
   * renderFromTemplate returns a PdfResult where:
   *   - buffer.length > 0
   *   - buffer starts with '%PDF-'
   *   - fileSize === buffer.length
   */
  it('with a stored template: buffer.length > 0, starts with %PDF-, fileSize === buffer.length', async () => {
    await fc.assert(
      fc.asyncProperty(renderOptionsWithTemplateArb, async (options) => {
        const result = await engine.renderFromTemplate(options);

        // Req 4.1: buffer.length > 0
        expect(result.buffer.length).toBeGreaterThan(0);

        // Req 4.2: starts with %PDF-
        const header = result.buffer.slice(0, 5).toString('ascii');
        expect(header).toBe('%PDF-');

        // Req 4.3: fileSize === buffer.length
        expect(result.fileSize).toBe(result.buffer.length);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * For any valid RenderOptions without a template (fallback path),
   * renderFromTemplate returns a PdfResult where:
   *   - buffer.length > 0
   *   - buffer starts with '%PDF-'
   *   - fileSize === buffer.length
   */
  it('without a template (fallback): buffer.length > 0, starts with %PDF-, fileSize === buffer.length', async () => {
    await fc.assert(
      fc.asyncProperty(renderOptionsWithoutTemplateArb, async (options) => {
        const result = await engine.renderFromTemplate(options);

        // Req 4.1: buffer.length > 0
        expect(result.buffer.length).toBeGreaterThan(0);

        // Req 4.2: starts with %PDF-
        const header = result.buffer.slice(0, 5).toString('ascii');
        expect(header).toBe('%PDF-');

        // Req 4.3: fileSize === buffer.length
        expect(result.fileSize).toBe(result.buffer.length);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * The property holds regardless of data content — even with various
   * language, settings, and data combinations.
   */
  it('property holds for mixed language and settings combinations', async () => {
    const mixedOptionsArb = fc.oneof(
      renderOptionsWithTemplateArb,
      renderOptionsWithoutTemplateArb
    );

    await fc.assert(
      fc.asyncProperty(mixedOptionsArb, async (options) => {
        const result = await engine.renderFromTemplate(options);

        // All three postconditions hold regardless of inputs
        expect(result.buffer.length).toBeGreaterThan(0);
        expect(result.buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
        expect(result.fileSize).toBe(result.buffer.length);
      }),
      { numRuns: 50 }
    );
  });
});

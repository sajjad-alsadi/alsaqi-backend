// @vitest-environment node
import fc from 'fast-check';

/**
 * Property Tests for PdfEngine.compilePreviewHtml (Property 6)
 *
 * Feature: pdf-template-system-overhaul
 *
 * Property 6: compilePreviewHtml — compilation correctness and error handling
 *
 * 1. For any valid Handlebars template and data with key-value pairs,
 *    compilePreviewHtml returns HTML containing the data values AND empty errors array
 * 2. For any invalid Handlebars (unclosed blocks, invalid syntax),
 *    compilePreviewHtml returns non-empty errors array AND HTML containing error description text
 * 3. The errors array entries have a `message` property that is a non-empty string
 * 4. The compiledHtml always starts with `<!DOCTYPE html>` (full HTML document)
 * 5. compilePreviewHtml never throws — it always returns a result object
 *
 * **Validates: Requirements 6.3, 6.4, 6.5**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock BrowserPool (not used by compilePreviewHtml, but imported by PdfEngine)
vi.mock('../BrowserPool.js', () => ({
  browserPool: {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock pdfHelpers — provide a minimal wrapWithStyles that returns a DOCTYPE document
vi.mock('../pdfHelpers.js', () => ({
  wrapWithStyles: (bodyHtml: string, _settings: unknown, _language: string) =>
    `<!DOCTYPE html>\n<html><head><meta charset="UTF-8"></head><body>${bodyHtml}</body></html>`,
  sanitizeHtml: (html: string) => html,
  buildHeaderTemplate: () => '<div></div>',
  buildFooterTemplate: () => '<div></div>',
}));

// Mock fallbackTemplates
vi.mock('../../constants/fallbackTemplates.js', () => ({
  FALLBACK_TEMPLATES: {},
  buildFallbackHtml: () => '<div>Fallback</div>',
}));

// Mock logger to avoid noise
vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PdfEngine } from '../PdfEngine.js';
import type { PdfSettings } from '../../types/pdf.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

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

/**
 * Generates a valid Handlebars template that references a given key.
 * The generated template uses simple interpolation so we can verify
 * that the corresponding data value appears in the compiled output.
 */
const validTemplateWithKeyArb = fc.constantFrom(
  { template: '<h1>{{title}}</h1>', key: 'title' },
  { template: '<p>{{name}}</p>', key: 'name' },
  { template: '<span>{{value}}</span>', key: 'value' },
  { template: '<div>{{content}}</div>', key: 'content' },
  { template: '<strong>{{label}}</strong>', key: 'label' }
);

/**
 * Generates valid templates that use block helpers (each).
 */
const validBlockTemplateArb = fc.constantFrom(
  { template: '{{#each items}}<li>{{this}}</li>{{/each}}', key: 'items' },
  { template: '{{#if show}}<p>visible</p>{{/if}}', key: 'show' }
);

/**
 * Generates invalid Handlebars templates that will cause compilation errors.
 */
const invalidTemplateArb = fc.constantFrom(
  '{{#if}}',                           // Missing condition
  '{{#each items}}<li>{{this}}</li>',  // Unclosed each block
  '{{#if show}}<p>yes</p>',            // Unclosed if block
  '{{#unless}}content{{/unless}}',     // Missing condition for unless
  '{{#each}}<span>x</span>{{/each}}'  // Missing argument
);

/**
 * Generates simple alphanumeric string data values for template substitution.
 * Restricted to alphanumeric to avoid HTML entity encoding issues in assertions.
 */
const simpleValueArb = fc
  .array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 1, maxLength: 30 }
  )
  .map((chars) => chars.join(''));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 6: compilePreviewHtml compilation and error handling', () => {
  let engine: PdfEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PdfEngine();
  });

  /**
   * **Validates: Requirements 6.3, 6.4**
   *
   * For any valid Handlebars template and data with key-value pairs,
   * compilePreviewHtml returns HTML containing the data values AND empty errors array.
   */
  it('valid template + data → HTML contains data values AND errors is empty', () => {
    fc.assert(
      fc.property(
        validTemplateWithKeyArb,
        simpleValueArb,
        pdfSettingsArb,
        languageArb,
        (templateInfo, dataValue, settings, language) => {
          const data = { [templateInfo.key]: dataValue };
          const result = engine.compilePreviewHtml(templateInfo.template, data, settings, language);

          // Req 6.4: Empty errors array on successful compilation
          expect(result.errors).toEqual([]);

          // Req 6.3: Compiled HTML contains the interpolated data value
          expect(result.compiledHtml).toContain(dataValue);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.5**
   *
   * For any invalid Handlebars template, compilePreviewHtml returns
   * non-empty errors array AND HTML containing error description text.
   */
  it('invalid template → non-empty errors AND HTML contains error description', () => {
    fc.assert(
      fc.property(
        invalidTemplateArb,
        pdfSettingsArb,
        languageArb,
        (template, settings, language) => {
          const data = { items: ['a', 'b'], show: true };
          const result = engine.compilePreviewHtml(template, data, settings, language);

          // Req 6.5: Non-empty errors array on failed compilation
          expect(result.errors.length).toBeGreaterThan(0);

          // Req 6.5: HTML contains error description for display in iframe
          expect(result.compiledHtml).toContain('Template Compilation Error');
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 6.5**
   *
   * The errors array entries have a `message` property that is a non-empty string.
   */
  it('error entries have a non-empty message string', () => {
    fc.assert(
      fc.property(
        invalidTemplateArb,
        pdfSettingsArb,
        languageArb,
        (template, settings, language) => {
          const data = {};
          const result = engine.compilePreviewHtml(template, data, settings, language);

          for (const error of result.errors) {
            expect(typeof error.message).toBe('string');
            expect(error.message.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 6.3**
   *
   * The compiledHtml always starts with `<!DOCTYPE html>` (full HTML document),
   * regardless of whether compilation succeeded or failed.
   */
  it('compiledHtml always starts with <!DOCTYPE html>', () => {
    const anyTemplateArb = fc.oneof(
      validTemplateWithKeyArb.map((t) => t.template),
      invalidTemplateArb
    );

    fc.assert(
      fc.property(
        anyTemplateArb,
        pdfSettingsArb,
        languageArb,
        (template, settings, language) => {
          const data = { title: 'test', name: 'test', value: 'test', content: 'test', label: 'test', items: ['a'], show: true };
          const result = engine.compilePreviewHtml(template, data, settings, language);

          // Always returns a full HTML document
          expect(result.compiledHtml.startsWith('<!DOCTYPE html>')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.3, 6.4, 6.5**
   *
   * compilePreviewHtml never throws — it always returns a result object
   * with compiledHtml (string) and errors (array).
   */
  it('never throws — always returns a result object', () => {
    const anyTemplateArb = fc.oneof(
      validTemplateWithKeyArb.map((t) => t.template),
      validBlockTemplateArb.map((t) => t.template),
      invalidTemplateArb,
      fc.string({ minLength: 0, maxLength: 200 }) // arbitrary random strings
    );

    fc.assert(
      fc.property(
        anyTemplateArb,
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        pdfSettingsArb,
        languageArb,
        (template, data, settings, language) => {
          // Must not throw
          const result = engine.compilePreviewHtml(template, data as Record<string, unknown>, settings, language);

          // Always returns proper structure
          expect(result).toBeDefined();
          expect(typeof result.compiledHtml).toBe('string');
          expect(Array.isArray(result.errors)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

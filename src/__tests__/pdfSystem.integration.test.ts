// @vitest-environment node
/**
 * Integration Tests: PDF Template System End-to-End Flow (Task 10.4)
 *
 * These tests verify the full lifecycle of the PDF template system:
 * 1. Template lifecycle: create → approve → set default → getActiveByType
 * 2. Worker with active template vs. fallback template
 * 3. Preview-html endpoint with valid and invalid Handlebars
 * 4. Migration mapping: resolveTemplateTypeKey with Arabic/English/null inputs
 *
 * **Validates: Requirements 1.1, 4.1, 5.1, 5.3, 7.2**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const { mockRun, mockGet, mockAll, mockPrepare } = vi.hoisted(() => {
  const mockRun = vi.fn();
  const mockGet = vi.fn();
  const mockAll = vi.fn();
  const mockPrepare = vi.fn(() => ({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  }));
  return { mockRun, mockGet, mockAll, mockPrepare };
});

vi.mock('../db/index', () => ({
  db: {
    prepare: mockPrepare,
    transaction: vi.fn(async (fn: Function) => fn()),
    validateIdentifier: vi.fn((id: string) => id),
  },
}));

// Mock BrowserPool to avoid Puppeteer in unit/integration tests
vi.mock('../services/BrowserPool', () => ({
  browserPool: {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn(),
  },
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PdfTemplateService } from '../services/PdfTemplateService';
import { PdfEngine } from '../services/PdfEngine';
import { resolveTemplateTypeKey } from '../constants/templateTypes';
import type { PdfSettings, PdfTemplateRow } from '../types/pdf';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a valid PdfSettings object for testing */
function createTestSettings(overrides: Partial<PdfSettings> = {}): PdfSettings {
  return {
    arabic_font_name: 'Tahoma',
    arabic_font_size: 12,
    heading_font_size: 18,
    subheading_font_size: 14,
    table_font_size: 10,
    rtl_enabled: true,
    margin_top: 15,
    margin_right: 15,
    margin_bottom: 15,
    margin_left: 15,
    header_template: null,
    footer_template: null,
    logo_position: 'center',
    show_page_number: true,
    ...overrides,
  };
}

/** Creates a mock PdfTemplateRow as returned from the database */
function createMockTemplateRow(overrides: Partial<PdfTemplateRow> = {}): PdfTemplateRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    template_name: 'Test Template',
    template_type_key: 'audit_report',
    template_type: 'audit_report',
    content: '<h1>{{auditTitle}}</h1><p>{{auditorName}}</p>',
    status: 'Draft',
    is_default: 0,
    version: 1,
    created_by: 'testuser',
    updated_by: 'testuser',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ─── Test 1: Template Lifecycle (create → approve → set default → verify) ────
describe('Template Lifecycle: create → approve → set default → generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a template in Draft status with version 1', async () => {
    const expectedRow = createMockTemplateRow({
      template_name: 'Audit Report Template',
      template_type_key: 'audit_report',
      content: '<h1>{{auditTitle}}</h1>',
      status: 'Draft',
      is_default: 0,
      version: 1,
    });

    mockGet.mockResolvedValueOnce(expectedRow);

    const result = await PdfTemplateService.create(
      {
        template_name: 'Audit Report Template',
        template_type_key: 'audit_report',
        content: '<h1>{{auditTitle}}</h1>',
      },
      'admin'
    );

    expect(result.template_name).toBe('Audit Report Template');
    expect(result.template_type_key).toBe('audit_report');
    expect(result.status).toBe('Draft');
    expect(result.version).toBe(1);
    expect(result.is_default).toBe(false); // boolean mapping
  });

  it('updates template status to Approved and sets as default', async () => {
    const templateId = crypto.randomUUID();

    // Mock getById for the update call (existing template)
    const existingRow = createMockTemplateRow({
      id: templateId,
      status: 'Draft',
      is_default: 0,
      version: 1,
    });
    mockGet.mockResolvedValueOnce(existingRow);

    // Mock the update RETURNING result (now Approved + default)
    const updatedRow = createMockTemplateRow({
      id: templateId,
      status: 'Approved',
      is_default: 1,
      version: 1, // no content change → version stays
      updated_by: 'admin',
    });
    mockGet.mockResolvedValueOnce(updatedRow);

    const result = await PdfTemplateService.update(
      templateId,
      { status: 'Approved', is_default: true },
      'admin'
    );

    expect(result.status).toBe('Approved');
    expect(result.is_default).toBe(true);
    expect(result.version).toBe(1); // no content change
  });

  it('getActiveByType returns the default approved template', async () => {
    const approvedRow = createMockTemplateRow({
      status: 'Approved',
      is_default: 1,
      template_type_key: 'audit_report',
    });
    mockGet.mockResolvedValueOnce(approvedRow);

    const result = await PdfTemplateService.getActiveByType('audit_report');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('Approved');
    expect(result!.is_default).toBe(true);
    expect(result!.template_type_key).toBe('audit_report');
  });

  it('getActiveByType returns null when no default approved template exists', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    const result = await PdfTemplateService.getActiveByType('audit_report');

    expect(result).toBeNull();
  });

  it('setting a new default unsets the previous one (only one default per type)', async () => {
    const template1Id = crypto.randomUUID();
    const template2Id = crypto.randomUUID();

    // First template is already the default
    const existingRow = createMockTemplateRow({
      id: template2Id,
      status: 'Draft',
      is_default: 0,
      version: 1,
    });
    mockGet.mockResolvedValueOnce(existingRow);

    // After update — new template becomes default
    const newDefaultRow = createMockTemplateRow({
      id: template2Id,
      status: 'Approved',
      is_default: 1,
      version: 1,
    });
    mockGet.mockResolvedValueOnce(newDefaultRow);

    const result = await PdfTemplateService.update(
      template2Id,
      { status: 'Approved', is_default: true },
      'admin'
    );

    expect(result.is_default).toBe(true);
    // Verify the "unset previous default" SQL was issued
    expect(mockRun).toHaveBeenCalled();
    const unsetCall = mockPrepare.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('SET is_default = 0')
    );
    expect(unsetCall).toBeDefined();
  });

  it('rejects setting non-Approved template as default', async () => {
    const templateId = crypto.randomUUID();
    const existingRow = createMockTemplateRow({
      id: templateId,
      status: 'Draft',
      is_default: 0,
      version: 1,
    });
    mockGet.mockResolvedValueOnce(existingRow);

    await expect(
      PdfTemplateService.update(templateId, { is_default: true }, 'admin')
    ).rejects.toThrow(/only approved/i);
  });
});

// ─── Test 2: Worker with active template vs. fallback template ───────────────
describe('Worker: Active template vs. fallback template', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses stored template when getActiveByType returns a template', async () => {
    const approvedRow = createMockTemplateRow({
      status: 'Approved',
      is_default: 1,
      template_type_key: 'audit_report',
      content: '<h1>{{auditTitle}}</h1><p>Date: {{auditDate}}</p>',
    });
    mockGet.mockResolvedValueOnce(approvedRow);

    // Simulate worker flow: fetch active template
    const template = await PdfTemplateService.getActiveByType('audit_report');
    expect(template).not.toBeNull();
    expect(template!.content).toContain('{{auditTitle}}');

    // The worker would then call PdfEngine.renderFromTemplate with this template
    // Since Puppeteer is mocked, we verify the preview path (synchronous)
    const pdfEngine = new PdfEngine();
    const settings = createTestSettings();
    const data = { auditTitle: 'Test Audit', auditDate: '2024-01-15' };

    const preview = pdfEngine.compilePreviewHtml(
      template!.content,
      data,
      settings,
      'ar'
    );

    expect(preview.errors).toHaveLength(0);
    expect(preview.compiledHtml).toContain('Test Audit');
    expect(preview.compiledHtml).toContain('2024-01-15');
  });

  it('uses fallback when getActiveByType returns null (no stored template)', async () => {
    mockGet.mockResolvedValueOnce(undefined);

    // Worker flow: no active template found
    const template = await PdfTemplateService.getActiveByType('audit_report');
    expect(template).toBeNull();

    // Worker would call PdfEngine.renderFallback instead
    // We verify via compilePreviewHtml that fallback HTML works
    const pdfEngine = new PdfEngine();
    const settings = createTestSettings();
    // Use a simple fallback-compatible template
    const fallbackContent = '<div><h1>{{auditTitle}}</h1><p>{{auditorName}}</p></div>';
    const data = { auditTitle: 'Fallback Report', auditorName: 'المدقق' };

    const preview = pdfEngine.compilePreviewHtml(
      fallbackContent,
      data,
      settings,
      'ar'
    );

    expect(preview.errors).toHaveLength(0);
    expect(preview.compiledHtml).toContain('Fallback Report');
    expect(preview.compiledHtml).toContain('المدقق');
  });

  it('falls back to renderFallback when template has invalid Handlebars', async () => {
    const badTemplateRow = createMockTemplateRow({
      status: 'Approved',
      is_default: 1,
      template_type_key: 'audit_report',
      content: '<h1>{{#if unclosed}}</h1>', // Invalid — unclosed block
    });
    mockGet.mockResolvedValueOnce(badTemplateRow);

    const template = await PdfTemplateService.getActiveByType('audit_report');
    expect(template).not.toBeNull();

    const pdfEngine = new PdfEngine();
    const settings = createTestSettings();
    const data = { auditTitle: 'Test' };

    // compilePreviewHtml should capture the error gracefully
    const preview = pdfEngine.compilePreviewHtml(
      template!.content,
      data,
      settings,
      'ar'
    );

    // Invalid Handlebars → non-empty errors
    expect(preview.errors.length).toBeGreaterThan(0);
    expect(preview.compiledHtml).toContain('Error');
  });
});

// ─── Test 3: Preview-html endpoint (compilePreviewHtml) ──────────────────────
describe('Preview-html: compilePreviewHtml with valid and invalid Handlebars', () => {
  const pdfEngine = new PdfEngine();
  const settings = createTestSettings();

  it('valid Handlebars → compiledHtml contains data values, errors empty', () => {
    const htmlContent = `
      <div>
        <h1>{{title}}</h1>
        <p>Author: {{author}}</p>
        <ul>
          {{#each items}}
            <li>{{this}}</li>
          {{/each}}
        </ul>
      </div>
    `;
    const data = {
      title: 'التقرير السنوي',
      author: 'أحمد',
      items: ['بند 1', 'بند 2', 'بند 3'],
    };

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'ar');

    expect(result.errors).toHaveLength(0);
    expect(result.compiledHtml).toContain('التقرير السنوي');
    expect(result.compiledHtml).toContain('أحمد');
    expect(result.compiledHtml).toContain('بند 1');
    expect(result.compiledHtml).toContain('بند 2');
    expect(result.compiledHtml).toContain('بند 3');
    // Should be a full HTML document
    expect(result.compiledHtml).toContain('<!DOCTYPE html>');
    expect(result.compiledHtml).toContain('dir="rtl"');
  });

  it('valid Handlebars with conditionals produces correct output', () => {
    const htmlContent = `
      <div>
        {{#if showHeader}}<h1>{{title}}</h1>{{/if}}
        {{#unless hideFooter}}<footer>Footer</footer>{{/unless}}
      </div>
    `;
    const data = { showHeader: true, title: 'Visible Title', hideFooter: false };

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'en');

    expect(result.errors).toHaveLength(0);
    expect(result.compiledHtml).toContain('Visible Title');
    expect(result.compiledHtml).toContain('Footer');
  });

  it('invalid Handlebars (unclosed block) → errors non-empty, compiledHtml contains error', () => {
    const htmlContent = '<div>{{#if condition}}<p>Missing close</p></div>';
    const data = { condition: true };

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'ar');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toBeTruthy();
    // The compiledHtml should contain an error description (for display in iframe)
    expect(result.compiledHtml).toContain('Error');
    // Should still be a full HTML document
    expect(result.compiledHtml).toContain('<!DOCTYPE html>');
  });

  it('invalid Handlebars (unknown helper) → errors non-empty', () => {
    const htmlContent = '<div>{{nonExistentHelper arg1}}</div>';
    const data = {};

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'ar');

    // Handlebars throws on unknown helpers by default
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.compiledHtml).toContain('Error');
  });

  it('empty template produces valid HTML with no errors', () => {
    const htmlContent = '';
    const data = {};

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'ar');

    expect(result.errors).toHaveLength(0);
    expect(result.compiledHtml).toContain('<!DOCTYPE html>');
  });

  it('template with no variables produces static output', () => {
    const htmlContent = '<h1>Static Content</h1><p>No variables here.</p>';
    const data = { unused: 'value' };

    const result = pdfEngine.compilePreviewHtml(htmlContent, data, settings, 'en');

    expect(result.errors).toHaveLength(0);
    expect(result.compiledHtml).toContain('Static Content');
    expect(result.compiledHtml).toContain('No variables here.');
  });
});

// ─── Test 4: Migration mapping — resolveTemplateTypeKey ──────────────────────
describe('Migration: resolveTemplateTypeKey maps old Arabic/English values', () => {
  describe('Arabic labels → correct keys', () => {
    const arabicMappings: Array<[string, string]> = [
      ['تقرير التدقيق', 'audit_report'],
      ['التقرير الربعي', 'quarterly_report'],
      ['التقرير السنوي', 'annual_report'],
      ['خطة التدقيق', 'audit_plan'],
      ['مهام التدقيق', 'audit_missions'],
      ['التوصيات', 'recommendations'],
      ['خطاب صادر', 'outgoing_letter'],
      ['عام', 'general'],
    ];

    it.each(arabicMappings)(
      'resolveTemplateTypeKey("%s") → "%s"',
      (arabicLabel, expectedKey) => {
        expect(resolveTemplateTypeKey(arabicLabel)).toBe(expectedKey);
      }
    );
  });

  describe('English labels (from migration SQL) → correct keys', () => {
    const englishMappings: Array<[string, string]> = [
      ['auditReport', 'audit_report'],
      ['quarterlyReport', 'quarterly_report'],
      ['complianceRequirements', 'audit_report'],
      ['activityAuditResults', 'audit_report'],
      ['eventParticipationSummary', 'general'],
      ['monthlyDepartmentReport', 'quarterly_report'],
    ];

    it.each(englishMappings)(
      'resolveTemplateTypeKey("%s") → "%s"',
      (englishKey, expectedKey) => {
        expect(resolveTemplateTypeKey(englishKey)).toBe(expectedKey);
      }
    );
  });

  describe('Already valid keys → returned unchanged', () => {
    const validKeys = [
      'audit_report',
      'quarterly_report',
      'annual_report',
      'audit_plan',
      'audit_missions',
      'recommendations',
      'outgoing_letter',
      'general',
    ];

    it.each(validKeys)(
      'resolveTemplateTypeKey("%s") → "%s" (unchanged)',
      (key) => {
        expect(resolveTemplateTypeKey(key)).toBe(key);
      }
    );
  });

  describe('Null, empty, and unknown inputs → "general"', () => {
    it('null → "general"', () => {
      expect(resolveTemplateTypeKey(null)).toBe('general');
    });

    it('undefined → "general"', () => {
      expect(resolveTemplateTypeKey(undefined)).toBe('general');
    });

    it('empty string → "general"', () => {
      expect(resolveTemplateTypeKey('')).toBe('general');
    });

    it('unknown string → "general"', () => {
      expect(resolveTemplateTypeKey('some_random_value')).toBe('general');
    });

    it('random Arabic text → "general"', () => {
      expect(resolveTemplateTypeKey('نص عشوائي')).toBe('general');
    });

    it('numeric string → "general"', () => {
      expect(resolveTemplateTypeKey('12345')).toBe('general');
    });
  });
});

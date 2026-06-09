// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  wrapWithStyles,
  sanitizeHtml,
  buildHeaderTemplate,
  buildFooterTemplate,
} from '../pdfHelpers';
import type { PdfSettings } from '../../types/pdf';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<PdfSettings> = {}): PdfSettings {
  return {
    arabic_font_name: 'Tahoma',
    arabic_font_size: 12,
    heading_font_size: 18,
    subheading_font_size: 14,
    table_font_size: 10,
    rtl_enabled: true,
    margin_top: 20,
    margin_right: 15,
    margin_bottom: 20,
    margin_left: 15,
    header_template: null,
    footer_template: null,
    logo_position: 'center',
    show_page_number: true,
    ...overrides,
  };
}

// ─── wrapWithStyles ──────────────────────────────────────────────────────────

describe('wrapWithStyles', () => {
  it('returns a full HTML document with DOCTYPE', () => {
    const result = wrapWithStyles('<p>Hello</p>', makeSettings(), 'ar');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('</html>');
  });

  it('applies dir="rtl" when language is Arabic', () => {
    const result = wrapWithStyles('<p>مرحبا</p>', makeSettings({ rtl_enabled: false }), 'ar');
    expect(result).toContain('dir="rtl"');
  });

  it('applies dir="rtl" when settings.rtl_enabled is true regardless of language', () => {
    const result = wrapWithStyles('<p>Hello</p>', makeSettings({ rtl_enabled: true }), 'en');
    expect(result).toContain('dir="rtl"');
  });

  it('applies dir="ltr" when language is English and rtl_enabled is false', () => {
    const result = wrapWithStyles('<p>Hello</p>', makeSettings({ rtl_enabled: false }), 'en');
    expect(result).toContain('dir="ltr"');
    expect(result).not.toContain('dir="rtl"');
  });

  it('includes margins from settings in mm', () => {
    const settings = makeSettings({ margin_top: 25, margin_right: 10, margin_bottom: 30, margin_left: 10 });
    const result = wrapWithStyles('<p>Test</p>', settings, 'ar');
    expect(result).toContain('25mm');
    expect(result).toContain('10mm');
    expect(result).toContain('30mm');
  });

  it('includes font size from settings', () => {
    const settings = makeSettings({ arabic_font_size: 14 });
    const result = wrapWithStyles('<p>Test</p>', settings, 'ar');
    expect(result).toContain('14pt');
  });

  it('includes the body HTML content', () => {
    const bodyHtml = '<div class="report"><h1>Report Title</h1></div>';
    const result = wrapWithStyles(bodyHtml, makeSettings(), 'ar');
    expect(result).toContain(bodyHtml);
  });

  it('includes @font-face declarations for Tahoma and Amiri', () => {
    const result = wrapWithStyles('<p>Test</p>', makeSettings(), 'ar');
    expect(result).toContain("font-family: 'Tahoma'");
    expect(result).toContain("font-family: 'Amiri'");
  });

  it('includes @media print styles', () => {
    const result = wrapWithStyles('<p>Test</p>', makeSettings(), 'ar');
    expect(result).toContain('@media print');
    expect(result).toContain('page-break-inside');
  });

  it('applies heading font size to h1-h3', () => {
    const settings = makeSettings({ heading_font_size: 22 });
    const result = wrapWithStyles('<h1>Title</h1>', settings, 'ar');
    expect(result).toContain('22pt');
  });

  it('applies table font size', () => {
    const settings = makeSettings({ table_font_size: 9 });
    const result = wrapWithStyles('<table></table>', settings, 'ar');
    expect(result).toContain('9pt');
  });
});

// ─── sanitizeHtml ────────────────────────────────────────────────────────────

describe('sanitizeHtml', () => {
  it('removes script tags', () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>Hello</p>');
  });

  it('removes iframe tags', () => {
    const input = '<div>Content</div><iframe src="http://evil.com"></iframe>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('evil.com');
    expect(result).toContain('<div>Content</div>');
  });

  it('removes object and embed tags', () => {
    const input = '<p>OK</p><object data="x"></object><embed src="y">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
  });

  it('removes form and input tags', () => {
    const input = '<form action="/hack"><input type="text"></form><p>Safe</p>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
    expect(result).toContain('<p>Safe</p>');
  });

  it('removes on-event attributes', () => {
    const input = '<div onclick="alert(1)" onmouseover="hack()">Click</div>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onmouseover');
    expect(result).toContain('Click');
  });

  it('removes onerror attribute from img', () => {
    const input = '<img src="x" onerror="alert(1)" alt="test">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('onerror');
    expect(result).toContain('alt="test"');
  });

  it('preserves allowed HTML tags', () => {
    const input = '<div><h1>Title</h1><p>Paragraph</p><ul><li>Item</li></ul></div>';
    const result = sanitizeHtml(input);
    expect(result).toContain('<div>');
    expect(result).toContain('<h1>');
    expect(result).toContain('<p>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
  });

  it('preserves table elements', () => {
    const input = '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
    const result = sanitizeHtml(input);
    expect(result).toContain('<table>');
    expect(result).toContain('<thead>');
    expect(result).toContain('<tbody>');
    expect(result).toContain('<th>');
    expect(result).toContain('<td>');
  });

  it('preserves style, class, id, and dir attributes', () => {
    const input = '<div style="color: red;" class="main" id="content" dir="rtl">Text</div>';
    const result = sanitizeHtml(input);
    // sanitize-html may normalize CSS whitespace (e.g. "color:red" vs "color: red;")
    expect(result).toMatch(/style="color:\s*red;?"/);
    expect(result).toContain('class="main"');
    expect(result).toContain('id="content"');
    expect(result).toContain('dir="rtl"');
  });

  it('preserves img with src and alt', () => {
    const input = '<img src="data:image/png;base64,ABC" alt="Logo">';
    const result = sanitizeHtml(input);
    expect(result).toContain('src="data:image/png;base64,ABC"');
    expect(result).toContain('alt="Logo"');
  });

  it('preserves links with href', () => {
    const input = '<a href="https://example.com" target="_blank">Link</a>';
    const result = sanitizeHtml(input);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('target="_blank"');
  });
});

// ─── buildHeaderTemplate ─────────────────────────────────────────────────────

describe('buildHeaderTemplate', () => {
  it('returns empty div when logo_position is none and no custom template', () => {
    const settings = makeSettings({ logo_position: 'none', header_template: null });
    const result = buildHeaderTemplate(settings);
    expect(result).toBe('<div></div>');
  });

  it('uses custom header_template when provided', () => {
    const settings = makeSettings({ header_template: '<span>Custom Header</span>' });
    const result = buildHeaderTemplate(settings);
    expect(result).toContain('Custom Header');
  });

  it('positions logo to the left', () => {
    const settings = makeSettings({ logo_position: 'left', header_template: null });
    const result = buildHeaderTemplate(settings);
    expect(result).toContain('flex-start');
  });

  it('positions logo to center', () => {
    const settings = makeSettings({ logo_position: 'center', header_template: null });
    const result = buildHeaderTemplate(settings);
    expect(result).toContain('center');
  });

  it('positions logo to the right', () => {
    const settings = makeSettings({ logo_position: 'right', header_template: null });
    const result = buildHeaderTemplate(settings);
    expect(result).toContain('flex-end');
  });
});

// ─── buildFooterTemplate ─────────────────────────────────────────────────────

describe('buildFooterTemplate', () => {
  it('returns empty div when show_page_number is false and no custom template', () => {
    const settings = makeSettings({ show_page_number: false, footer_template: null });
    const result = buildFooterTemplate(settings, 'ar');
    expect(result).toBe('<div></div>');
  });

  it('uses custom footer_template when provided', () => {
    const settings = makeSettings({ footer_template: '<span>Custom Footer</span>' });
    const result = buildFooterTemplate(settings, 'ar');
    expect(result).toContain('Custom Footer');
  });

  it('shows Arabic page number labels when language is ar', () => {
    const settings = makeSettings({ show_page_number: true, footer_template: null });
    const result = buildFooterTemplate(settings, 'ar');
    expect(result).toContain('صفحة');
    expect(result).toContain('من');
    expect(result).toContain('class="pageNumber"');
    expect(result).toContain('class="totalPages"');
  });

  it('shows English page number labels when language is en', () => {
    const settings = makeSettings({ show_page_number: true, footer_template: null });
    const result = buildFooterTemplate(settings, 'en');
    expect(result).toContain('Page');
    expect(result).toContain('of');
    expect(result).toContain('class="pageNumber"');
    expect(result).toContain('class="totalPages"');
  });

  it('applies RTL direction for Arabic footer', () => {
    const settings = makeSettings({ show_page_number: true, footer_template: null });
    const result = buildFooterTemplate(settings, 'ar');
    expect(result).toContain('direction: rtl');
  });

  it('applies LTR direction for English footer', () => {
    const settings = makeSettings({ show_page_number: true, footer_template: null });
    const result = buildFooterTemplate(settings, 'en');
    expect(result).toContain('direction: ltr');
  });
});

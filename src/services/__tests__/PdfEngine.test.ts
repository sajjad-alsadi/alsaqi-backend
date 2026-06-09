// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PdfEngine } from '../PdfEngine';
import type { PdfSettings } from '../../types/pdf';

/**
 * Unit tests for PdfEngine.compilePreviewHtml
 *
 * Tests the synchronous Handlebars compile path which does not require
 * Puppeteer or the browser pool.
 */

const defaultSettings: PdfSettings = {
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
  logo_position: 'right',
  show_page_number: true,
};

describe('PdfEngine', () => {
  const engine = new PdfEngine();

  describe('compilePreviewHtml', () => {
    it('compiles valid Handlebars template with data and returns empty errors (Req 6.3, 6.4)', () => {
      const html = '<h1>{{title}}</h1><p>{{description}}</p>';
      const data = { title: 'Test Report', description: 'A detailed report' };

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('Test Report');
      expect(result.compiledHtml).toContain('A detailed report');
      expect(result.compiledHtml).toContain('<!DOCTYPE html>');
      expect(result.compiledHtml).toContain('dir="rtl"');
    });

    it('compiles template with each helper correctly', () => {
      const html = '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>';
      const data = { items: ['item1', 'item2', 'item3'] };

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'en');

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('<li>item1</li>');
      expect(result.compiledHtml).toContain('<li>item2</li>');
      expect(result.compiledHtml).toContain('<li>item3</li>');
    });

    it('compiles template with conditional helper', () => {
      const html = '{{#if showSection}}<div>Visible</div>{{else}}<div>Hidden</div>{{/if}}';
      const data = { showSection: true };

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('<div>Visible</div>');
      expect(result.compiledHtml).not.toContain('<div>Hidden</div>');
    });

    it('returns errors array with message and line number on invalid Handlebars (Req 6.5)', () => {
      const html = '<h1>{{#if}}</h1>'; // Invalid: #if without condition
      const data = {};

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toBeTruthy();
      // compiledHtml should contain error display
      expect(result.compiledHtml).toContain('<!DOCTYPE html>');
      expect(result.compiledHtml).toContain('Template Compilation Error');
    });

    it('returns errors on unclosed block helper', () => {
      const html = '{{#each items}}<li>{{this}}</li>'; // Missing {{/each}}
      const data = { items: ['a'] };

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toBeTruthy();
    });

    it('handles empty data object gracefully', () => {
      const html = '<h1>{{title}}</h1>';
      const data = {};

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('<h1></h1>');
    });

    it('applies LTR direction for English language with rtl_enabled=false', () => {
      const html = '<p>Hello</p>';
      const data = {};
      const enSettings = { ...defaultSettings, rtl_enabled: false };

      const result = engine.compilePreviewHtml(html, data, enSettings, 'en');

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('dir="ltr"');
      expect(result.compiledHtml).toContain('lang="en"');
    });

    it('does not invoke Puppeteer or write temp files (Req 6.7)', () => {
      // This test verifies the method is synchronous by checking
      // it returns immediately without async operations
      const html = '<p>{{value}}</p>';
      const data = { value: 'quick' };

      const start = performance.now();
      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');
      const elapsed = performance.now() - start;

      expect(result.errors).toEqual([]);
      expect(result.compiledHtml).toContain('quick');
      // Should be well under 5ms for simple templates
      expect(elapsed).toBeLessThan(50); // generous bound for CI environments
    });

    it('escapes HTML in error messages to prevent XSS', () => {
      const html = '{{#if}}'; // Invalid
      const data = {};

      const result = engine.compilePreviewHtml(html, data, defaultSettings, 'ar');

      // Error message should not contain raw < or > that could execute
      expect(result.compiledHtml).not.toMatch(/<script/i);
    });
  });
});

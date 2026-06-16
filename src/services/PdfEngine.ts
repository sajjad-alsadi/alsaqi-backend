import Handlebars from 'handlebars';
import { browserPool, BrowserCrashedError } from './BrowserPool.js';
import { wrapWithStyles, sanitizeHtml } from './pdfHelpers.js';
import { FALLBACK_TEMPLATES, buildFallbackHtml } from '../constants/fallbackTemplates.js';
import logger from '../utils/logger.js';
import type { PdfSettings, PdfResult, PdfTemplate, RenderOptions } from '../types/pdf.js';
import type { TemplateTypeKey } from '../constants/templateTypes.js';

/**
 * Timeout (ms) for a single Puppeteer page.pdf() call.
 * Requirement 4.9: 30-second timeout
 */
const RENDER_TIMEOUT_MS = 30_000;

/**
 * Maximum LRU cache entries for compiled Handlebars templates.
 * Requirement 10.5
 */
const MAX_CACHE_SIZE = 100;

/**
 * Simple LRU cache for compiled Handlebars templates.
 * Key: `${templateId}:${version}`, Value: compiled template function.
 */
class TemplateLRUCache {
  private cache = new Map<string, HandlebarsTemplateDelegate>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): HandlebarsTemplateDelegate | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: HandlebarsTemplateDelegate): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first key)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * PdfEngine — Unified PDF generation engine using Puppeteer.
 *
 * Responsibilities:
 * - Compile Handlebars templates with data
 * - Apply PDF settings (margins, fonts, RTL, header/footer)
 * - Generate PDF via Puppeteer (vector text, real page numbers)
 * - Provide fast preview mode (Handlebars compile → HTML, no Puppeteer)
 * - Manage browser pool reuse
 *
 * Requirements: 4.1–4.11, 6.3–6.5, 6.7, 10.5
 */
export class PdfEngine {
  private templateCache = new TemplateLRUCache(MAX_CACHE_SIZE);

  /**
   * Renders a PDF from a stored template or fallback.
   *
   * Pipeline: compile Handlebars → sanitize → wrapWithStyles → Puppeteer page.pdf()
   *
   * - If options.template is provided and has valid Handlebars, uses it.
   * - If options.template has invalid Handlebars, falls back to built-in template + logs warning (Req 4.11).
   * - If options.template is not provided, uses built-in fallback (Req 4.5).
   * - Applies 30-second timeout with one retry (Req 4.9, 4.10).
   *
   * @returns PdfResult with buffer, pageCount, fileSize
   */
  async renderFromTemplate(options: RenderOptions): Promise<PdfResult> {
    const { data, settings, language } = options;
    let html: string;

    if (options.template) {
      try {
        html = this.compileTemplate(options.template, data);
      } catch (err) {
        // Req 4.11: On invalid Handlebars, fall back to built-in template + log warning
        const templateTypeKey = options.template.template_type_key || 'general';
        logger.warn(
          `[PdfEngine] Handlebars compilation failed for template "${options.template.id}" (type: ${templateTypeKey}). Falling back to built-in template.`,
          { error: err instanceof Error ? err.message : String(err) }
        );
        html = buildFallbackHtml(data, language, templateTypeKey);
      }
    } else {
      // Req 4.5: Use built-in fallback when no template provided
      html = buildFallbackHtml(data, language, 'general');
    }

    // Sanitize HTML to remove dangerous elements (Req 9.1)
    const sanitizedHtml = sanitizeHtml(html);

    // Wrap with full document styles (RTL, fonts, margins, print styles)
    const fullHtml = wrapWithStyles(sanitizedHtml, settings, language);

    // Generate PDF via Puppeteer with timeout and retry
    return this.renderPdf(fullHtml, settings, language);
  }

  /**
   * Renders a PDF using the built-in fallback template for the given type.
   *
   * Same pipeline as renderFromTemplate but always uses fallback.
   */
  async renderFallback(options: RenderOptions & { templateTypeKey?: TemplateTypeKey }): Promise<PdfResult> {
    const { data, settings, language } = options;
    const typeKey = options.templateTypeKey || 'general';

    const html = buildFallbackHtml(data, language, typeKey);
    const sanitizedHtml = sanitizeHtml(html);
    const fullHtml = wrapWithStyles(sanitizedHtml, settings, language);

    return this.renderPdf(fullHtml, settings, language);
  }

  /**
   * Compiles a Handlebars template with data and returns HTML for iframe preview.
   *
   * Synchronous — no Puppeteer, no temp files.
   * Must complete within 5ms (Req 6.7).
   *
   * @returns { compiledHtml: string; errors: Array<{ message: string; line?: number }> }
   */
  compilePreviewHtml(
    htmlContent: string,
    data: Record<string, unknown>,
    settings: PdfSettings,
    language: 'ar' | 'en'
  ): { compiledHtml: string; errors: Array<{ message: string; line?: number }> } {
    try {
      const compiled = Handlebars.compile(htmlContent);
      const renderedBody = compiled(data);
      const fullHtml = wrapWithStyles(renderedBody, settings, language);

      return { compiledHtml: fullHtml, errors: [] };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const lineNumber = this.extractLineNumber(errorMessage);

      // Return HTML that displays the error for the preview iframe
      const errorHtml = wrapWithStyles(
        `<div style="color: #dc2626; font-family: monospace; padding: 16px; border: 1px solid #dc2626; border-radius: 4px; background: #fef2f2;">
          <h3 style="margin: 0 0 8px;">⚠️ Template Compilation Error</h3>
          <pre style="margin: 0; white-space: pre-wrap; word-break: break-word;">${this.escapeHtml(errorMessage)}</pre>
          ${lineNumber ? `<p style="margin: 8px 0 0; font-size: 0.875em; color: #991b1b;">Line: ${lineNumber}</p>` : ''}
        </div>`,
        settings,
        language
      );

      return {
        compiledHtml: errorHtml,
        errors: [{ message: errorMessage, line: lineNumber }],
      };
    }
  }

  /**
   * Closes all browser instances and releases pool resources.
   * Delegates to BrowserPool.dispose().
   * Requirement 10.4
   */
  async dispose(): Promise<void> {
    this.templateCache.clear();
    await browserPool.dispose();
    logger.info('[PdfEngine] Disposed — template cache cleared, browser pool closed');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Compiles a template using the LRU cache (Req 10.5).
   * Cache key: `${templateId}:${version}`
   */
  private compileTemplate(template: PdfTemplate, data: Record<string, unknown>): string {
    const cacheKey = `${template.id}:${template.version}`;
    let compiled = this.templateCache.get(cacheKey);

    if (!compiled) {
      compiled = Handlebars.compile(template.content);
      this.templateCache.set(cacheKey, compiled);
    }

    return compiled(data);
  }

  /**
   * Renders HTML to PDF via Puppeteer with 30s timeout and one retry.
   *
   * Req 4.9: If first attempt exceeds 30s, retry once.
   * Req 4.10: If retry also exceeds 30s, throw error.
   */
  private async renderPdf(
    fullHtml: string,
    settings: PdfSettings,
    language: 'ar' | 'en'
  ): Promise<PdfResult> {
    // First attempt
    try {
      return await this.renderPdfAttempt(fullHtml, settings, language);
    } catch (err) {
      // If it's a timeout error, retry once
      if (this.isTimeoutError(err)) {
        logger.warn('[PdfEngine] Puppeteer render timed out, retrying once...');
        try {
          return await this.renderPdfAttempt(fullHtml, settings, language);
        } catch (retryErr) {
          if (this.isTimeoutError(retryErr)) {
            throw new Error(
              'PDF rendering timeout: Puppeteer exceeded 30 seconds on both attempts. ' +
              'The template may be too complex or contain external resources that cannot be loaded.'
            );
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Single Puppeteer render attempt with timeout.
   */
  private async renderPdfAttempt(
    fullHtml: string,
    settings: PdfSettings,
    _language: 'ar' | 'en'
  ): Promise<PdfResult> {
    const browser = await browserPool.acquire();
    let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;

    try {
      page = await browser.newPage();

      // Block external network requests (Req 9.2)
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        // Allow data: URIs and about:blank, block everything else external
        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
          request.continue();
        } else {
          // Block external HTTP/HTTPS requests
          request.abort('blockedbyclient');
        }
      });

      // Set content with timeout. The timeout timer is cleared as soon as the
      // race settles so no orphaned 30s timer lingers (which would otherwise fire
      // a late rejection / unhandledRejection). (Finding 1.38 → 2.38.)
      const setContentTimer = this.timeout(RENDER_TIMEOUT_MS, 'setContent');
      try {
        await Promise.race([
          page.setContent(fullHtml, { waitUntil: 'load' }),
          setContentTimer.promise,
        ]);
      } finally {
        setContentTimer.clear();
      }

      // Generate PDF with timeout
      const pdfOptions: Parameters<typeof page.pdf>[0] = {
        format: 'A4',
        margin: {
          top: `${settings.margin_top}mm`,
          right: `${settings.margin_right}mm`,
          bottom: `${settings.margin_bottom}mm`,
          left: `${settings.margin_left}mm`,
        },
        printBackground: true,
        displayHeaderFooter: !!(settings.header_template || settings.footer_template || settings.show_page_number),
      };

      if (settings.header_template) {
        pdfOptions.headerTemplate = settings.header_template;
      }
      if (settings.footer_template || settings.show_page_number) {
        pdfOptions.footerTemplate = settings.footer_template || '';
      }

      const pdfTimer = this.timeout(RENDER_TIMEOUT_MS, 'page.pdf');
      let pdfBuffer: Buffer;
      try {
        pdfBuffer = (await Promise.race([
          page.pdf(pdfOptions),
          pdfTimer.promise,
        ])) as Buffer;
      } finally {
        pdfTimer.clear();
      }

      const buffer = Buffer.from(pdfBuffer);

      // Postconditions: Req 4.1 (buffer.length > 0), Req 4.2 (%PDF-), Req 4.3 (fileSize === buffer.length)
      return {
        buffer,
        pageCount: 0, // TODO: add pdf-parse later for page count extraction
        fileSize: buffer.length,
      };
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          // Page may already be closed if browser crashed
        }
      }
      try {
        await browserPool.release(browser);
      } catch (releaseErr) {
        // If release throws BrowserCrashedError, the browser was already destroyed.
        // Log and continue — the pool will create a replacement on next acquire.
        if (releaseErr instanceof BrowserCrashedError) {
          logger.warn('[PdfEngine] Browser crashed during release — pool will create replacement on next acquire');
        } else {
          throw releaseErr;
        }
      }
    }
  }

  /**
   * Creates a cancellable timeout. Returns the rejecting `promise` for use in a
   * `Promise.race`, plus a `clear()` that cancels the underlying timer. Callers
   * MUST invoke `clear()` once the race settles so the timer never fires after
   * the winning operation completes (no leaked 30s timer / late rejection).
   * (Finding 1.38 → 2.38.)
   */
  private timeout(ms: number, operation: string): { promise: Promise<never>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new PdfRenderTimeoutError(
          `Puppeteer ${operation} exceeded ${ms / 1000} second timeout`
        ));
      }, ms);
    });
    return {
      promise,
      clear: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }

  /**
   * Checks if an error is a timeout error.
   */
  private isTimeoutError(err: unknown): boolean {
    return err instanceof PdfRenderTimeoutError;
  }

  /**
   * Extracts line number from Handlebars error messages.
   * Handlebars errors often include patterns like "on line N" or "Parse error on line N".
   */
  private extractLineNumber(errorMessage: string): number | undefined {
    const lineMatch = errorMessage.match(/on line (\d+)/i);
    if (lineMatch) {
      return parseInt(lineMatch[1], 10);
    }
    return undefined;
  }

  /**
   * Escapes HTML entities to prevent XSS in error display.
   */
  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

/**
 * Custom error class for Puppeteer render timeouts.
 * Used to distinguish timeout errors from other failures for retry logic.
 */
export class PdfRenderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderTimeoutError';
  }
}

/**
 * Singleton PdfEngine instance.
 * Shared across the application.
 */
export const pdfEngine = new PdfEngine();

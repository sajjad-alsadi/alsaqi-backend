/**
 * PDF Generation Worker
 *
 * Processes PDF generation jobs from the BullMQ pdf-generation queue.
 * - 30-second timeout per render, returning browser instance to pool on timeout
 * - Logs job status (success/failure) and execution duration
 * - Integrates with BrowserPool and PdfEngine for rendering
 *
 * Validates: Requirements 5.1, 5.5, 13.2, 13.3
 */

import { type Job, type Worker } from 'bullmq';
import { browserPool, BrowserCrashedError } from '../../services/BrowserPool.js';
import { sanitizeHtml, wrapWithStyles } from '../../services/pdfHelpers.js';
import { PdfTemplateService } from '../../services/PdfTemplateService.js';
import { SettingsService } from '../../services/SettingsService.js';
import { mapRowToSettings } from '../../types/pdf.js';
import { resolveTemplateTypeKey } from '../../constants/templateTypes.js';
import logger from '../../utils/logger.js';
import { queueManager, type PdfJobData } from '../queueManager.js';
import Handlebars from 'handlebars';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum time (ms) allowed for a single PDF render operation.
 * Requirement 13.2: 30-second timeout per PDF render.
 */
const PDF_RENDER_TIMEOUT_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PdfJobResult {
  /** The rendered PDF buffer as base64 (for storage) */
  pdfBase64: string;
  /** Size of the rendered PDF in bytes */
  fileSize: number;
  /** Number of pages in the rendered PDF */
  pageCount: number;
  /** Duration of the render operation in milliseconds */
  durationMs: number;
}

// ─── Worker Processor ────────────────────────────────────────────────────────

/**
 * Processes a single PDF generation job.
 *
 * Steps:
 * 1. Extract job data (templateId, payload, userId)
 * 2. Load template and settings from database
 * 3. Compile Handlebars template with payload data
 * 4. Render PDF via Puppeteer with 30s timeout
 * 5. Return PDF result (buffer as base64, fileSize, pageCount, duration)
 *
 * On timeout: browser instance is returned to pool, job fails with timeout error.
 * Requirement 13.2: 30-second timeout per PDF render, return browser to pool on timeout.
 * Requirement 5.5: Log job status (success/failure) and execution duration.
 */
export async function processPdfJob(job: Job<PdfJobData>): Promise<PdfJobResult> {
  const startTime = Date.now();
  const { requestId, templateId, payload, userId } = job.data;

  logger.info(`[PdfWorker] Processing job ${job.id} (requestId: ${requestId}, template: ${templateId}, user: ${userId})`);

  let browser: Awaited<ReturnType<typeof browserPool.acquire>> | null = null;

  try {
    // 1. Load template from database
    const resolvedTypeKey = resolveTemplateTypeKey(templateId);
    const template = await PdfTemplateService.getActiveByType(resolvedTypeKey);
    if (!template) {
      throw new Error(`Template not found for type: ${templateId}`);
    }

    // 2. Load PDF settings
    const rawSettings = await SettingsService.getPdfSettings();
    const settings = mapRowToSettings(rawSettings as any);
    const language: 'ar' | 'en' = settings.rtl_enabled ? 'ar' : 'en';

    // 3. Compile Handlebars template with payload data
    const compiled = Handlebars.compile(template.content);
    const renderedBody = compiled(payload);

    // 4. Sanitize and wrap with styles
    const sanitizedHtml = sanitizeHtml(renderedBody);
    const fullHtml = wrapWithStyles(sanitizedHtml, settings, language);

    // 5. Render PDF via Puppeteer with 30s timeout (Req 13.2)
    browser = await browserPool.acquire();

    const pdfBuffer = await renderWithTimeout(browser, fullHtml, settings, language);

    // Release browser back to pool on success
    await browserPool.release(browser);
    browser = null; // Prevent double-release in finally

    const durationMs = Date.now() - startTime;
    const result: PdfJobResult = {
      pdfBase64: pdfBuffer.toString('base64'),
      fileSize: pdfBuffer.length,
      pageCount: 0, // Page count extraction can be added later
      durationMs,
    };

    // Requirement 5.5: Log success with execution duration
    logger.info(
      `[PdfWorker] Job ${job.id} completed successfully. ` +
      `Duration: ${durationMs}ms, Size: ${result.fileSize} bytes, RequestId: ${requestId}`
    );

    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Requirement 13.4: On browser crash → remove from pool, create replacement, re-queue affected job
    if (err instanceof BrowserCrashedError) {
      // Browser has already been removed from pool and replacement will be created on next acquire.
      // BullMQ retry mechanism will re-queue this job automatically since we throw the error.
      browser = null; // Already destroyed by BrowserPool
      logger.error(
        `[PdfWorker] Job ${job.id} affected by browser crash. ` +
        `Duration: ${durationMs}ms, RequestId: ${requestId}. ` +
        `Job will be re-queued via BullMQ retry mechanism.`
      );
      throw err; // Let BullMQ retry handle re-queuing
    }

    // Requirement 13.2: Return browser to pool on timeout or other errors
    if (browser) {
      try {
        // Check if browser crashed before attempting release
        if (browserPool.isCrashed(browser)) {
          logger.warn(`[PdfWorker] Browser crashed during job ${job.id}, skipping release`);
        } else {
          await browserPool.release(browser);
        }
      } catch (releaseErr) {
        // If release throws BrowserCrashedError, the browser was destroyed.
        // The current error (timeout, template error, etc.) is the primary failure.
        if (releaseErr instanceof BrowserCrashedError) {
          logger.warn(`[PdfWorker] Browser crashed during release for job ${job.id}. Job will be retried.`);
        } else {
          logger.warn(`[PdfWorker] Failed to release browser after error: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
        }
      }
      browser = null;
    }

    // Requirement 5.5: Log failure with execution duration
    logger.error(
      `[PdfWorker] Job ${job.id} failed. ` +
      `Duration: ${durationMs}ms, Error: ${errorMessage}, RequestId: ${requestId}`
    );

    throw err;
  }
}

/**
 * Renders HTML to PDF using Puppeteer with a 30-second timeout.
 * Requirement 13.2: 30-second timeout per PDF render.
 *
 * On timeout, the page is closed and a timeout error is thrown.
 * The caller is responsible for releasing the browser back to the pool.
 */
async function renderWithTimeout(
  browser: Awaited<ReturnType<typeof browserPool.acquire>>,
  fullHtml: string,
  settings: ReturnType<typeof mapRowToSettings>,
  language: 'ar' | 'en'
): Promise<Buffer> {
  const page = await browser.newPage();

  try {
    // Block external network requests
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
        request.continue();
      } else {
        request.abort('blockedbyclient');
      }
    });

    // Race: render PDF vs. 30-second timeout
    const pdfBuffer = await Promise.race([
      renderPage(page, fullHtml, settings, language),
      createTimeout(PDF_RENDER_TIMEOUT_MS),
    ]);

    return Buffer.from(pdfBuffer);
  } finally {
    try {
      await page.close();
    } catch {
      // Page may already be closed
    }
  }
}

/**
 * Performs the actual page.setContent + page.pdf sequence.
 */
async function renderPage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof browserPool.acquire>>['newPage']>>,
  fullHtml: string,
  settings: ReturnType<typeof mapRowToSettings>,
  _language: 'ar' | 'en'
): Promise<Uint8Array> {
  await page.setContent(fullHtml, { waitUntil: 'load' });

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

  return page.pdf(pdfOptions);
}

/**
 * Creates a promise that rejects after the specified timeout.
 */
function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`PDF render timeout: exceeded ${ms / 1000} seconds`));
    }, ms);
  });
}

// ─── Worker Registration ─────────────────────────────────────────────────────

/**
 * Registers the PDF worker with the queue manager.
 * Should be called during application startup after queue initialization.
 *
 * @returns The Worker instance (for lifecycle management)
 */
export function registerPdfWorker(): Worker | null {
  if (!queueManager.isInitialized) {
    logger.warn('[PdfWorker] Queue manager not initialized. PDF worker not registered.');
    return null;
  }

  const worker = queueManager.registerPdfWorker(processPdfJob);

  logger.info('[PdfWorker] PDF generation worker registered and listening for jobs.');
  return worker;
}

export default { processPdfJob, registerPdfWorker };

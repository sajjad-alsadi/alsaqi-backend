/**
 * PDF Generation Worker
 *
 * Processes PDF generation jobs from the BullMQ pdf-generation queue.
 * - Configurable per-job timeout (PDF_JOB_TIMEOUT_S: 5..300s, default 30s), racing
 *   processing against the deadline and returning the browser to the pool on timeout
 * - Logs job status (success/failure) and execution duration
 * - Integrates with BrowserPool and PdfEngine for rendering
 *
 * Validates: Requirements 5.1, 5.5, 13.2, 13.3, 22.1, 22.2, 22.3, 22.4, 22.5
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
 * Inclusive lower bound (seconds) for the configurable PDF job timeout. Req 22.1.
 */
export const PDF_TIMEOUT_MIN_S = 5;

/**
 * Inclusive upper bound (seconds) for the configurable PDF job timeout. Req 22.1.
 */
export const PDF_TIMEOUT_MAX_S = 300;

/**
 * Documented default PDF job timeout (seconds), applied to absent, non-numeric,
 * or out-of-range configuration values. Req 22.1, 22.2.
 */
export const PDF_TIMEOUT_DEFAULT_S = 30;

/**
 * Maximum time (ms) allowed for post-timeout cleanup of a single resource
 * (page close, browser release). Requirements 22.3, 22.4: abort and release/close
 * within 1 second of reaching the limit.
 */
const CLEANUP_DEADLINE_MS = 1_000;

// ─── Pure Configuration Helper ─────────────────────────────────────────────────

/**
 * Parses the configured maximum PDF job execution time (in seconds).
 *
 * Pure helper: returns an integer within [{@link PDF_TIMEOUT_MIN_S},
 * {@link PDF_TIMEOUT_MAX_S}], falling back to {@link PDF_TIMEOUT_DEFAULT_S} (30)
 * for absent, non-numeric, or out-of-range input.
 *
 * Requirements 22.1, 22.2.
 *
 * @param raw The raw configured value (e.g. `process.env.PDF_JOB_TIMEOUT_S`).
 * @returns A timeout in seconds guaranteed to sit within the accepted range.
 */
export function parsePdfTimeout(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) {
    return PDF_TIMEOUT_DEFAULT_S;
  }

  let parsed: number;
  if (typeof raw === 'number') {
    parsed = raw;
  } else {
    const trimmed = raw.trim();
    // Strict integer check: reject empty, floats, hex, and trailing garbage.
    if (trimmed.length === 0 || !/^[+-]?\d+$/.test(trimmed)) {
      return PDF_TIMEOUT_DEFAULT_S;
    }
    parsed = Number(trimmed);
  }

  if (!Number.isInteger(parsed)) {
    return PDF_TIMEOUT_DEFAULT_S;
  }

  if (parsed < PDF_TIMEOUT_MIN_S || parsed > PDF_TIMEOUT_MAX_S) {
    return PDF_TIMEOUT_DEFAULT_S;
  }

  return parsed;
}

// ─── Types & Errors ────────────────────────────────────────────────────────────

/**
 * Raised when a PDF generation job exceeds its configured maximum execution time.
 * Carries the elapsed time and the configured maximum so the failure reason can
 * report both. Requirement 22.5.
 */
export class PdfTimeoutError extends Error {
  /** Elapsed execution time (ms) measured from the start of job processing. */
  readonly elapsedMs: number;
  /** Configured maximum execution time (ms). */
  readonly configuredMaxMs: number;

  constructor(elapsedMs: number, configuredMaxMs: number) {
    super(
      `PDF generation job timed out: elapsed ${elapsedMs}ms exceeded the configured ` +
      `maximum execution time of ${configuredMaxMs}ms (${Math.round(configuredMaxMs / 1000)}s)`
    );
    this.name = 'PdfTimeoutError';
    this.elapsedMs = elapsedMs;
    this.configuredMaxMs = configuredMaxMs;
  }
}

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

  // Requirement 22.1, 22.2: resolve the configured maximum execution time
  // (5..300s, default 30s) measured from the start of job processing.
  const configuredMaxMs = parsePdfTimeout(process.env.PDF_JOB_TIMEOUT_S) * 1000;

  logger.info(`[PdfWorker] Processing job ${job.id} (requestId: ${requestId}, template: ${templateId}, user: ${userId}, timeout: ${configuredMaxMs}ms)`);

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

    // 5. Render PDF via Puppeteer, racing against the configured timeout (Req 22.1, 22.3)
    browser = await browserPool.acquire();

    const pdfBuffer = await renderWithTimeout(browser, fullHtml, settings, language, configuredMaxMs, startTime);

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

    // Requirement 13.2 / 22.4: Return browser to pool on timeout or other errors,
    // bounding the release to CLEANUP_DEADLINE_MS so a hung browser cannot stall the worker.
    if (browser) {
      const browserToRelease = browser;
      await runWithin(CLEANUP_DEADLINE_MS, async () => {
        try {
          // Check if browser crashed before attempting release
          if (browserPool.isCrashed(browserToRelease)) {
            logger.warn(`[PdfWorker] Browser crashed during job ${job.id}, skipping release`);
          } else {
            await browserPool.release(browserToRelease);
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
      });
      browser = null;
    }

    // Requirement 22.5: a timeout failure reason must include elapsed and configured max time.
    if (err instanceof PdfTimeoutError) {
      logger.error(
        `[PdfWorker] Job ${job.id} timed out. ` +
        `Elapsed: ${err.elapsedMs}ms, ConfiguredMax: ${err.configuredMaxMs}ms, RequestId: ${requestId}`
      );
      throw err;
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
 * Renders HTML to PDF using Puppeteer, racing the render against the configured
 * maximum execution time. Requirements 22.1, 22.3, 22.4, 22.5.
 *
 * The timeout deadline is measured from the start of job processing (`startTime`)
 * so time already spent loading templates/settings counts toward the limit. On
 * timeout a {@link PdfTimeoutError} is thrown (carrying elapsed + configured max),
 * the in-flight render is aborted, and the page is closed within
 * {@link CLEANUP_DEADLINE_MS}. The caller releases the browser back to the pool.
 */
async function renderWithTimeout(
  browser: Awaited<ReturnType<typeof browserPool.acquire>>,
  fullHtml: string,
  settings: ReturnType<typeof mapRowToSettings>,
  language: 'ar' | 'en',
  configuredMaxMs: number,
  startTime: number
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

    // Race: render PDF vs. the remaining time before the configured deadline.
    const remainingMs = startTime + configuredMaxMs - Date.now();
    const pdfBuffer = await Promise.race([
      renderPage(page, fullHtml, settings, language),
      createTimeout(remainingMs, startTime, configuredMaxMs),
    ]);

    return Buffer.from(pdfBuffer);
  } finally {
    // Requirement 22.4: close the page within 1 second (abort the render).
    await runWithin(CLEANUP_DEADLINE_MS, async () => {
      try {
        await page.close();
      } catch {
        // Page may already be closed
      }
    });
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
 * Creates a promise that rejects with a {@link PdfTimeoutError} once the configured
 * deadline is reached. Requirements 22.3, 22.5.
 *
 * @param remainingMs Time left before the deadline (clamped to >= 0).
 * @param startTime   Epoch ms marking the start of job processing (for elapsed time).
 * @param configuredMaxMs The configured maximum execution time in ms.
 */
function createTimeout(remainingMs: number, startTime: number, configuredMaxMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new PdfTimeoutError(Date.now() - startTime, configuredMaxMs));
    }, Math.max(0, remainingMs));
  });
}

/**
 * Runs an async cleanup operation, bounding it to `ms` milliseconds so a hung
 * resource (page/browser) cannot stall the worker. Requirements 22.3, 22.4.
 *
 * Resolves when the operation finishes or the deadline elapses, whichever comes
 * first; never rejects.
 */
async function runWithin(ms: number, op: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([op().catch(() => {}), deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

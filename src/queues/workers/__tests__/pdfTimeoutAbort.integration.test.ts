// @vitest-environment node
// Feature: backend-security-hardening
// Integration test: PDF job timeout abort and cleanup (Task 12.9)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Integration test for PDF timeout abort and cleanup.
 *
 * **Validates: Requirements 22.3, 22.4, 22.5**
 *
 * Exercises `processPdfJob` end-to-end (with bullmq, BrowserPool,
 * PdfTemplateService, SettingsService and logger mocked) against a render that
 * hangs forever, forcing the configured timeout to fire:
 *
 * - Req 22.3: the job is aborted within 1 second of reaching the configured
 *   maximum execution time (the in-flight render is abandoned).
 * - Req 22.4: the browser is released back to the pool and the page is closed
 *   within 1 second of the abort — even if those cleanup steps themselves hang.
 * - Req 22.5: the failure (a PdfTimeoutError) reports both the elapsed execution
 *   time and the configured maximum execution time.
 */

// ─── Shared, hoisted mock state (referenced by vi.mock factories below) ───────
const h = vi.hoisted(() => {
  const state = {
    pageCloseHangs: false,
    releaseHangs: false,
    closeCalls: 0,
    newPageCalls: 0,
    releaseCalls: 0,
    released: [] as unknown[],
  };

  // A page whose render (page.pdf) never resolves, forcing a timeout.
  const page = {
    setRequestInterception: async (_: boolean) => {},
    on: (_event: string, _handler: (...args: unknown[]) => void) => {},
    setContent: async (_html: string, _opts?: unknown) => {},
    // Hang forever: the render never completes, so only the timeout can win.
    pdf: (_opts?: unknown) => new Promise<Uint8Array>(() => {}),
    close: () => {
      state.closeCalls++;
      // Optionally hang to prove the worker bounds page-close cleanup to 1s.
      return state.pageCloseHangs ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };

  const browser = {
    newPage: async () => {
      state.newPageCalls++;
      return page;
    },
  };

  const browserPool = {
    acquire: async () => browser,
    release: async (b: unknown) => {
      state.releaseCalls++;
      state.released.push(b);
      // Optionally hang to prove the worker bounds browser-release cleanup to 1s.
      if (state.releaseHangs) {
        await new Promise<void>(() => {});
      }
    },
    isCrashed: (_b: unknown) => false,
  };

  class BrowserCrashedError extends Error {
    constructor(message = 'crashed') {
      super(message);
      this.name = 'BrowserCrashedError';
    }
  }

  return { state, page, browser, browserPool, BrowserCrashedError };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

// bullmq: importing the worker module pulls in queueManager → never touch Redis.
vi.mock('bullmq', () => {
  class Mock {
    on = vi.fn();
    add = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    getJob = vi.fn().mockResolvedValue(null);
  }
  return { Queue: Mock, Worker: Mock, QueueEvents: Mock };
});

vi.mock('../../../services/BrowserPool.js', () => ({
  browserPool: h.browserPool,
  BrowserCrashedError: h.BrowserCrashedError,
}));

vi.mock('../../../services/PdfTemplateService.js', () => ({
  PdfTemplateService: {
    getActiveByType: vi.fn(async () => ({
      id: 'tpl-1',
      template_name: 'Test',
      template_type_key: 'finding',
      content: '<p>{{title}}</p>',
      status: 'Approved',
      is_default: true,
      version: 1,
      created_by: 'u',
      updated_by: 'u',
      created_at: '',
      updated_at: '',
    })),
  },
}));

vi.mock('../../../services/SettingsService.js', () => ({
  SettingsService: {
    getPdfSettings: vi.fn(async () => ({
      id: 1,
      arabic_font_name: 'Cairo',
      arabic_font_size: 12,
      heading_font_size: 18,
      subheading_font_size: 14,
      table_font_size: 10,
      rtl_enabled: 0,
      margin_top: 10,
      margin_right: 10,
      margin_bottom: 10,
      margin_left: 10,
      header_template: null,
      footer_template: null,
      logo_position: 'none',
      show_page_number: 0,
    })),
  },
}));

// Silence logger file output during the test.
vi.mock('../../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processPdfJob, PdfTimeoutError } from '../pdfWorker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Drain the pending microtask queue so awaited promises settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function makeJob() {
  return {
    id: 'job-timeout-1',
    data: {
      requestId: 'req-1',
      templateId: 'finding',
      payload: { title: 'hello' },
      userId: 'user-1',
    },
  } as any;
}

// PDF_JOB_TIMEOUT_S is clamped to [5,300]s; 5 is the smallest configurable max.
const TIMEOUT_S = 5;
const TIMEOUT_MS = TIMEOUT_S * 1000;

describe('PDF timeout abort and cleanup (Req 22.3, 22.4, 22.5)', () => {
  const originalTimeoutEnv = process.env.PDF_JOB_TIMEOUT_S;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.PDF_JOB_TIMEOUT_S = String(TIMEOUT_S);
    h.state.pageCloseHangs = false;
    h.state.releaseHangs = false;
    h.state.closeCalls = 0;
    h.state.newPageCalls = 0;
    h.state.releaseCalls = 0;
    h.state.released = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTimeoutEnv === undefined) {
      delete process.env.PDF_JOB_TIMEOUT_S;
    } else {
      process.env.PDF_JOB_TIMEOUT_S = originalTimeoutEnv;
    }
  });

  it('aborts a hung render with a PdfTimeoutError and cleans up the browser/page (Req 22.3, 22.4, 22.5)', async () => {
    const promise = processPdfJob(makeJob());
    // Avoid an unhandled-rejection warning while we drive the fake clock.
    promise.catch(() => {});

    // Let template load, settings load, browser acquire, newPage and setContent
    // settle so the timeout timer gets scheduled.
    await flushMicrotasks();

    // Advance to (just past) the configured maximum execution time → timeout fires.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    // Allow the post-timeout cleanup (page close + browser release) to run.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    // Req 22.5: failure is a timeout carrying elapsed + configured max.
    const err = (await promise.then(
      () => {
        throw new Error('processPdfJob resolved but a timeout was expected');
      },
      (e) => e
    )) as PdfTimeoutError;

    expect(err).toBeInstanceOf(PdfTimeoutError);
    expect(err.configuredMaxMs).toBe(TIMEOUT_MS);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT_MS);
    // Failure reason text must mention both the elapsed and configured max time.
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).toContain(`${err.elapsedMs}ms`);
    expect(err.message).toContain(`${TIMEOUT_MS}ms`);
    expect(err.message).toContain(`${TIMEOUT_S}s`);

    // Req 22.4: page was closed and the browser released back to the pool.
    expect(h.state.newPageCalls).toBe(1);
    expect(h.state.closeCalls).toBeGreaterThanOrEqual(1);
    expect(h.state.releaseCalls).toBe(1);
    expect(h.state.released[0]).toBe(h.browser);
  });

  it('still aborts and does not hang when page close and browser release themselves hang (Req 22.3, 22.4)', async () => {
    // Force both cleanup steps to hang; the worker must bound each to ~1s.
    h.state.pageCloseHangs = true;
    h.state.releaseHangs = true;

    const promise = processPdfJob(makeJob());
    promise.catch(() => {});

    await flushMicrotasks();

    // Reach the timeout.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    // Page-close cleanup deadline (~1s).
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    // Browser-release cleanup deadline (~1s).
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const err = (await promise.then(
      () => {
        throw new Error('processPdfJob resolved but a timeout was expected');
      },
      (e) => e
    )) as PdfTimeoutError;

    // Despite the hung cleanup, the job is still aborted with a timeout failure
    // rather than stalling the worker indefinitely.
    expect(err).toBeInstanceOf(PdfTimeoutError);
    expect(h.state.closeCalls).toBeGreaterThanOrEqual(1);
    expect(h.state.releaseCalls).toBe(1);
  });
});

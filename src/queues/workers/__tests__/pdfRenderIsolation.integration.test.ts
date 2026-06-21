// @vitest-environment node
/**
 * Integration Test: Puppeteer PDF Render Isolation (Task 9.4)
 *
 * Requirement 5.5 / 5.6 concern the API_Container memory limit, which cannot be
 * fully exercised in-process. This test asserts the *rendering isolation /
 * error-handling contract* that the limit relies on:
 *
 *   - 5.5 (happy path): rendering the worst-case supported document completes
 *     successfully and the per-render resources (page) are cleaned up.
 *   - 5.6 (bound exceeded): when a single PDF render exceeds its configured
 *     time/resource bound, the in-flight render is terminated, a handled error
 *     is returned to the caller (NOT an unhandled process crash), the per-render
 *     page is closed and the browser is released back to the pool, and a
 *     SUBSEQUENT render still succeeds — proving the service (API_Container)
 *     stays available for later requests.
 *
 * The render path under test is the BullMQ PDF worker (`processPdfJob`), which
 * owns the per-render isolation guard: it acquires a browser, races the render
 * against the configured deadline, and closes the page + releases the browser
 * in a bounded `finally` block regardless of outcome.
 *
 * **Validates: Requirements 5.5, 5.6**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PdfJobData } from '../../queueManager.js';

// ─── Hoisted mock factories ──────────────────────────────────────────────────

const {
  acquireSpy,
  releaseSpy,
  isCrashedSpy,
  pageCloseSpy,
  pagePdfSpy,
  setContentSpy,
  getMockBrowser,
} = vi.hoisted(() => {
  const pageCloseSpy = vi.fn(async () => {});
  // page.pdf is reconfigured per-test (resolve fast, or hang forever).
  const pagePdfSpy = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF"
  const setContentSpy = vi.fn(async () => {});

  const mockPage = {
    setRequestInterception: vi.fn(async () => {}),
    on: vi.fn(),
    setContent: setContentSpy,
    pdf: pagePdfSpy,
    close: pageCloseSpy,
  };

  const mockBrowser = {
    connected: true,
    newPage: vi.fn(async () => mockPage),
  };

  const acquireSpy = vi.fn(async () => mockBrowser);
  const releaseSpy = vi.fn(async () => {});
  const isCrashedSpy = vi.fn(() => false);

  return {
    acquireSpy,
    releaseSpy,
    isCrashedSpy,
    pageCloseSpy,
    pagePdfSpy,
    setContentSpy,
    getMockBrowser: () => mockBrowser,
  };
});

// Mock the BrowserPool so no real Puppeteer/Chromium is launched. This is the
// shared resource that must survive a single render exceeding its bound.
vi.mock('../../../services/BrowserPool.js', () => {
  class BrowserCrashedError extends Error {
    constructor(message = 'Browser instance crashed during job processing') {
      super(message);
      this.name = 'BrowserCrashedError';
    }
  }
  return {
    BrowserCrashedError,
    browserPool: {
      acquire: acquireSpy,
      release: releaseSpy,
      isCrashed: isCrashedSpy,
    },
  };
});

// Mock template + settings services (DB-free).
vi.mock('../../../services/PdfTemplateService.js', () => ({
  PdfTemplateService: {
    getActiveByType: vi.fn(async () => ({
      id: 'tmpl-1',
      content: '<h1>{{title}}</h1>',
      template_type_key: 'general',
      version: 1,
    })),
  },
}));

vi.mock('../../../services/SettingsService.js', () => ({
  SettingsService: {
    getPdfSettings: vi.fn(async () => ({
      arabic_font_name: 'Tahoma',
      arabic_font_size: 12,
      heading_font_size: 18,
      subheading_font_size: 14,
      table_font_size: 10,
      rtl_enabled: 1,
      margin_top: 15,
      margin_right: 15,
      margin_bottom: 15,
      margin_left: 15,
      header_template: null,
      footer_template: null,
      logo_position: 'center',
      show_page_number: 1,
    })),
  },
}));

// Mock the queue manager module to avoid pulling in Redis/BullMQ connections.
vi.mock('../../queueManager.js', () => ({
  queueManager: { isInitialized: false, registerPdfWorker: vi.fn() },
  QUEUE_NAMES: {},
}));

// Quiet logger.
vi.mock('../../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processPdfJob, PdfTimeoutError } from '../pdfWorker.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<PdfJobData> = {}): Job<PdfJobData> {
  return {
    id: 'job-1',
    data: {
      requestId: 'req-1',
      templateId: 'general',
      payload: { title: 'Worst-case supported document' },
      userId: 'user-1',
      ...overrides,
    },
  } as unknown as Job<PdfJobData>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Puppeteer PDF render isolation (Req 5.5 / 5.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a render returns a valid PDF buffer quickly.
    pagePdfSpy.mockImplementation(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    setContentSpy.mockImplementation(async () => {});
    pageCloseSpy.mockImplementation(async () => {});
    acquireSpy.mockImplementation(async () => getMockBrowser());
    releaseSpy.mockImplementation(async () => {});
    isCrashedSpy.mockReturnValue(false);
    // Generous default deadline so the happy-path render never trips the timeout.
    process.env.PDF_JOB_TIMEOUT_S = '30';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PDF_JOB_TIMEOUT_S;
  });

  it('5.5: worst-case supported document renders successfully within the bound and cleans up the page', async () => {
    const result = await processPdfJob(makeJob());

    expect(result).toBeDefined();
    expect(result.fileSize).toBeGreaterThan(0);
    expect(typeof result.pdfBase64).toBe('string');
    expect(result.pdfBase64.length).toBeGreaterThan(0);

    // Per-render resource isolation: the page is closed and the browser is
    // returned to the pool so it can serve subsequent renders.
    expect(pageCloseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('5.6: a single render exceeding its bound is terminated, returns a handled error, and releases resources', async () => {
    vi.useFakeTimers();

    // Simulate a render that never completes (e.g. a document so large it would
    // blow the memory/time budget). The worker must terminate it via its
    // configured deadline rather than hanging or crashing the process.
    pagePdfSpy.mockImplementation(() => new Promise<Uint8Array>(() => {}));
    process.env.PDF_JOB_TIMEOUT_S = '5'; // 5s configured bound

    const jobPromise = processPdfJob(makeJob());
    // Attach a catch immediately so the rejection is always handled (no
    // unhandledRejection that would otherwise destabilise the process).
    const settled = jobPromise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    // Advance past the configured deadline to fire the timeout + run cleanup.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000); // cleanup deadline window

    const outcome = await settled;

    // The caller receives a handled error — the process did not crash.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err).toBeInstanceOf(PdfTimeoutError);
      const tErr = outcome.err as PdfTimeoutError;
      // Failure reason carries elapsed + configured max (Req 22.5 contract).
      expect(tErr.configuredMaxMs).toBe(5_000);
      expect(tErr.elapsedMs).toBeGreaterThanOrEqual(0);
    }

    // The in-flight render's page was closed (render terminated / resources freed).
    expect(pageCloseSpy).toHaveBeenCalled();
    // The browser was returned to the pool so the container stays serviceable.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('5.6: API_Container stays available — a subsequent render succeeds after one render exceeds its bound', async () => {
    // ── First render: exceeds its bound and fails (handled) ──
    vi.useFakeTimers();
    pagePdfSpy.mockImplementationOnce(() => new Promise<Uint8Array>(() => {}));
    process.env.PDF_JOB_TIMEOUT_S = '5';

    const firstSettled = processPdfJob(makeJob({ requestId: 'req-first' })).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const firstOutcome = await firstSettled;

    expect(firstOutcome.ok).toBe(false);
    expect(releaseSpy).toHaveBeenCalledTimes(1); // browser returned to pool

    vi.useRealTimers();

    // ── Second render: normal document, must succeed (service still available) ──
    pagePdfSpy.mockImplementation(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    process.env.PDF_JOB_TIMEOUT_S = '30';

    const secondResult = await processPdfJob(makeJob({ requestId: 'req-second' }));

    expect(secondResult).toBeDefined();
    expect(secondResult.fileSize).toBeGreaterThan(0);
    // A fresh browser was acquired for the subsequent request and released again.
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });
});

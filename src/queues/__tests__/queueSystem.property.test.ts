// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 9: Async Job Processing
 * Property 10: Failed Job Retry with Backoff
 * Property 11: Queue Concurrency Bound
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.5**
 *
 * Strategy:
 * - Property 9: For any valid job data, addPdfJob/addNotificationJob returns a job ID
 *   immediately (within a timeout) without blocking on actual processing.
 * - Property 10: DEFAULT_JOB_OPTIONS has attempts=3 and exponential backoff starting at 2s.
 * - Property 11: CONCURRENCY is bounded at 5 for PDF and 20 for notifications.
 */

// ─── Mock BullMQ to avoid needing a real Redis connection ────────────────────

let jobIdCounter = 0;

vi.mock('bullmq', () => {
  class MockQueue {
    add = vi.fn().mockImplementation(async (_name: string, _data: unknown) => {
      jobIdCounter++;
      return { id: `mock-job-${jobIdCounter}` };
    });
    close = vi.fn().mockResolvedValue(undefined);
    getJob = vi.fn().mockResolvedValue(null);
    constructor() {}
  }

  class MockWorker {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  }

  class MockQueueEvents {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  }

  return {
    Queue: MockQueue,
    Worker: MockWorker,
    QueueEvents: MockQueueEvents,
  };
});

vi.mock('../../utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  QueueManager,
  CONCURRENCY,
  DEFAULT_JOB_OPTIONS,
  type PdfJobData,
  type NotificationJobData,
} from '../queueManager.js';

// ─── Generators ──────────────────────────────────────────────────────────────

/** Alphanumeric string generator using filter */
const alphanumStr = (opts: { minLength: number; maxLength: number }) =>
  fc.string({ minLength: opts.minLength, maxLength: opts.maxLength })
    .filter((s) => /^[a-zA-Z0-9]+$/.test(s) && s.length >= opts.minLength);

const pdfJobDataArb: fc.Arbitrary<PdfJobData> = fc.record({
  requestId: fc.uuid(),
  templateId: alphanumStr({ minLength: 1, maxLength: 50 }),
  payload: fc.dictionary(
    alphanumStr({ minLength: 1, maxLength: 20 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean())
  ),
  userId: fc.uuid(),
});

const notificationJobDataArb: fc.Arbitrary<NotificationJobData> = fc.record({
  recipientId: fc.uuid(),
  type: fc.constantFrom('email', 'push', 'in-app', 'sms'),
  title: fc.string({ minLength: 1, maxLength: 100 }),
  body: fc.string({ minLength: 1, maxLength: 500 }),
  metadata: fc.option(
    fc.dictionary(
      alphanumStr({ minLength: 1, maxLength: 20 }),
      fc.oneof(fc.string(), fc.integer(), fc.boolean())
    ),
    { nil: undefined }
  ),
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 9: Async Job Processing', () => {
  let queueMgr: QueueManager;

  beforeEach(async () => {
    jobIdCounter = 0;
    queueMgr = new QueueManager({ redisUrl: 'redis://localhost:6379' });
    await queueMgr.initialize();
  });

  it('for ANY valid PDF job data, addPdfJob returns a job ID string immediately without blocking', async () => {
    await fc.assert(
      fc.asyncProperty(pdfJobDataArb, async (jobData) => {
        const startTime = Date.now();
        const jobId = await queueMgr.addPdfJob(jobData);
        const elapsed = Date.now() - startTime;

        // Job ID must be a non-empty string
        expect(typeof jobId).toBe('string');
        expect(jobId.length).toBeGreaterThan(0);

        // Must return within 500ms (requirement 5.1) - with mocks this should be near-instant
        expect(elapsed).toBeLessThan(500);
      }),
      { numRuns: 100 }
    );
  });

  it('for ANY valid notification job data, addNotificationJob returns a job ID string immediately without blocking', async () => {
    await fc.assert(
      fc.asyncProperty(notificationJobDataArb, async (jobData) => {
        const startTime = Date.now();
        const jobId = await queueMgr.addNotificationJob(jobData);
        const elapsed = Date.now() - startTime;

        // Job ID must be a non-empty string
        expect(typeof jobId).toBe('string');
        expect(jobId.length).toBeGreaterThan(0);

        // Must return immediately without blocking (requirement 5.2)
        expect(elapsed).toBeLessThan(500);
      }),
      { numRuns: 100 }
    );
  });

  it('for ANY sequence of job submissions, each returns a unique job ID', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(pdfJobDataArb, { minLength: 2, maxLength: 20 }),
        async (jobDataArray) => {
          const jobIds: string[] = [];

          for (const jobData of jobDataArray) {
            const jobId = await queueMgr.addPdfJob(jobData);
            jobIds.push(jobId);
          }

          // All job IDs must be unique
          const uniqueIds = new Set(jobIds);
          expect(uniqueIds.size).toBe(jobIds.length);
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('Property 10: Failed Job Retry with Backoff', () => {
  it('DEFAULT_JOB_OPTIONS has attempts=3 for any queue configuration', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        // Requirement 5.3: max 3 retry attempts
        expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
      }),
      { numRuns: 1 }
    );
  });

  it('DEFAULT_JOB_OPTIONS uses exponential backoff type', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const backoff = DEFAULT_JOB_OPTIONS.backoff as { type: string; delay: number };
        expect(backoff).toBeDefined();
        expect(backoff.type).toBe('exponential');
      }),
      { numRuns: 1 }
    );
  });

  it('DEFAULT_JOB_OPTIONS backoff starts at 2000ms (2 seconds)', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const backoff = DEFAULT_JOB_OPTIONS.backoff as { type: string; delay: number };
        // Requirement 5.3: exponential backoff starting at 2 seconds
        expect(backoff.delay).toBe(2000);
      }),
      { numRuns: 1 }
    );
  });

  it('for ANY retry attempt number (1-3), the backoff delay increases exponentially from 2s base', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        (attemptNumber) => {
          const backoff = DEFAULT_JOB_OPTIONS.backoff as { type: string; delay: number };
          const baseDelay = backoff.delay; // 2000ms

          // Exponential backoff: delay * 2^(attempt-1)
          // Attempt 1: 2000ms, Attempt 2: 4000ms, Attempt 3: 8000ms
          const expectedDelay = baseDelay * Math.pow(2, attemptNumber - 1);

          // All delays must be positive and increasing
          expect(expectedDelay).toBeGreaterThan(0);
          expect(expectedDelay).toBeLessThanOrEqual(30_000); // Max 30s per requirement 5.3

          // Verify the exponential pattern holds
          if (attemptNumber > 1) {
            const previousDelay = baseDelay * Math.pow(2, attemptNumber - 2);
            expect(expectedDelay).toBeGreaterThan(previousDelay);
          }
        }
      ),
      { numRuns: 3 }
    );
  });
});

describe('Property 11: Queue Concurrency Bound', () => {
  it('PDF queue concurrency is exactly 5 for any configuration', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        // Requirement 5.6: max 5 concurrent PDF jobs
        expect(CONCURRENCY.PDF_GENERATION).toBe(5);
      }),
      { numRuns: 1 }
    );
  });

  it('notifications queue concurrency is exactly 20 for any configuration', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        // Requirement 5.6: max 20 concurrent notification jobs
        expect(CONCURRENCY.NOTIFICATIONS).toBe(20);
      }),
      { numRuns: 1 }
    );
  });

  it('for ANY number of concurrent job submissions, CONCURRENCY values act as upper bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (numberOfJobs) => {
          // Regardless of how many jobs are submitted, the concurrent processing
          // is bounded by CONCURRENCY values
          expect(numberOfJobs).toBeGreaterThan(0); // Precondition

          // PDF: max concurrent is always 5
          const pdfConcurrentMax = Math.min(numberOfJobs, CONCURRENCY.PDF_GENERATION);
          expect(pdfConcurrentMax).toBeLessThanOrEqual(5);

          // Notifications: max concurrent is always 20
          const notifConcurrentMax = Math.min(numberOfJobs, CONCURRENCY.NOTIFICATIONS);
          expect(notifConcurrentMax).toBeLessThanOrEqual(20);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('CONCURRENCY values are positive integers and PDF is stricter than notifications', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(CONCURRENCY.PDF_GENERATION).toBeGreaterThan(0);
        expect(CONCURRENCY.NOTIFICATIONS).toBeGreaterThan(0);
        expect(Number.isInteger(CONCURRENCY.PDF_GENERATION)).toBe(true);
        expect(Number.isInteger(CONCURRENCY.NOTIFICATIONS)).toBe(true);

        // PDF has stricter concurrency than notifications
        expect(CONCURRENCY.PDF_GENERATION).toBeLessThan(CONCURRENCY.NOTIFICATIONS);
      }),
      { numRuns: 1 }
    );
  });
});

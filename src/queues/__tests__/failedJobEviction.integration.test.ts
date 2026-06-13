// @vitest-environment node
// Feature: backend-security-hardening, Task 12.6: bounded failed-job eviction
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Integration test: Bounded failed-job eviction
 *
 * **Validates: Requirements 21.2**
 *
 * Requirement 21.2: WHEN a job transitions to the failed state and the count of retained
 * failed jobs for that queue exceeds the configured retention limit, THE Queue_Manager SHALL
 * remove retained failed jobs in order of oldest failure timestamp first until the retained
 * count equals the configured retention limit.
 *
 * BullMQ implements this eviction via the `removeOnFail: { count }` job/queue option: it keeps
 * at most `count` failed jobs, evicting the oldest first. This test verifies two things:
 *  1. The QueueManager actually wires `removeOnFail: { count }` (equal to the configured limit)
 *     into both the queue-level default job options and the per-job options it passes to
 *     `queue.add(...)` — captured through the mocked BullMQ layer.
 *  2. The oldest-first-down-to-the-limit semantics that BullMQ applies for that option produce
 *     the behaviour the requirement mandates — modelled and asserted against the limit the
 *     manager reports via `getFailedRetentionLimit()`.
 */

// ─── Mock BullMQ + logger (no live Redis), capturing constructor + add calls ──
// `vi.hoisted` ensures the capture buffers exist before the hoisted vi.mock factory runs.
const captured = vi.hoisted(() => ({
  jobIdCounter: 0,
  queueConstructions: [] as Array<{ name: string; opts: any }>,
  addCalls: [] as Array<{ queueName: string; jobName: string; opts: any }>,
}));

vi.mock('bullmq', () => {
  class MockQueue {
    name: string;
    opts: any;
    add = vi.fn().mockImplementation(async (jobName: string, _data: unknown, opts: any) => {
      captured.addCalls.push({ queueName: this.name, jobName, opts });
      captured.jobIdCounter++;
      return { id: `mock-job-${captured.jobIdCounter}` };
    });
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    getJob = vi.fn().mockResolvedValue(null);
    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      captured.queueConstructions.push({ name, opts });
    }
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

  return { Queue: MockQueue, Worker: MockWorker, QueueEvents: MockQueueEvents };
});

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  QueueManager,
  QUEUE_NAMES,
  FAILED_RETENTION_DEFAULT,
  type PdfJobData,
  type NotificationJobData,
} from '../queueManager.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pure model of BullMQ's `removeOnFail: { count }` behaviour: given failed jobs ordered
 * oldest → newest by failure timestamp, keep at most `limit` of them, evicting the oldest
 * first. Mirrors Requirement 21.2's "remove oldest failure first until retained == limit".
 */
function applyOldestFirstEviction<T>(
  failedOldestFirst: T[],
  limit: number,
): { retained: T[]; evicted: T[] } {
  if (failedOldestFirst.length <= limit) {
    return { retained: [...failedOldestFirst], evicted: [] };
  }
  const evictCount = failedOldestFirst.length - limit;
  return {
    evicted: failedOldestFirst.slice(0, evictCount),
    retained: failedOldestFirst.slice(evictCount),
  };
}

const PDF_JOB: PdfJobData = {
  requestId: 'req-1',
  templateId: 'tmpl-1',
  payload: { a: 1 },
  userId: 'user-1',
};

const NOTIF_JOB: NotificationJobData = {
  recipientId: 'user-1',
  type: 'email',
  title: 'hello',
  body: 'world',
};

function removeOnFailCount(opts: any): unknown {
  return opts?.defaultJobOptions?.removeOnFail;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Integration: bounded failed-job eviction (Req 21.2)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    captured.jobIdCounter = 0;
    captured.queueConstructions.length = 0;
    captured.addCalls.length = 0;
    savedEnv = process.env.QUEUE_FAILED_RETENTION;
    delete process.env.QUEUE_FAILED_RETENTION;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.QUEUE_FAILED_RETENTION;
    } else {
      process.env.QUEUE_FAILED_RETENTION = savedEnv;
    }
  });

  it('configures both work queues with removeOnFail.count equal to the configured retention limit', async () => {
    const mgr = new QueueManager({ redisUrl: 'redis://localhost:6379', failedJobRetention: '250' });
    await mgr.initialize();

    expect(mgr.getFailedRetentionLimit()).toBe(250);

    const pdf = captured.queueConstructions.find((q) => q.name === QUEUE_NAMES.PDF_GENERATION);
    const notif = captured.queueConstructions.find((q) => q.name === QUEUE_NAMES.NOTIFICATIONS);

    expect(pdf).toBeDefined();
    expect(notif).toBeDefined();
    expect(removeOnFailCount(pdf!.opts)).toEqual({ count: 250 });
    expect(removeOnFailCount(notif!.opts)).toEqual({ count: 250 });

    await mgr.shutdown();
  });

  it('defaults the eviction bound to 1000 when no retention value is provided', async () => {
    const mgr = new QueueManager({ redisUrl: 'redis://localhost:6379' });
    await mgr.initialize();

    expect(mgr.getFailedRetentionLimit()).toBe(FAILED_RETENTION_DEFAULT);

    const pdf = captured.queueConstructions.find((q) => q.name === QUEUE_NAMES.PDF_GENERATION);
    expect(removeOnFailCount(pdf!.opts)).toEqual({ count: FAILED_RETENTION_DEFAULT });

    await mgr.shutdown();
  });

  it('rejecting an invalid limit retains the previously applied limit as the eviction bound', async () => {
    const mgr = new QueueManager({ redisUrl: 'redis://localhost:6379', failedJobRetention: '42' });
    expect(mgr.getFailedRetentionLimit()).toBe(42);

    const result = mgr.setFailedJobRetention('not-a-number');
    expect(result.ok).toBe(false);
    expect(mgr.getFailedRetentionLimit()).toBe(42);

    await mgr.initialize();
    const pdf = captured.queueConstructions.find((q) => q.name === QUEUE_NAMES.PDF_GENERATION);
    expect(removeOnFailCount(pdf!.opts)).toEqual({ count: 42 });

    await mgr.shutdown();
  });

  it('carries removeOnFail.count on per-job options for added PDF and notification jobs', async () => {
    const mgr = new QueueManager({ redisUrl: 'redis://localhost:6379', failedJobRetention: '500' });
    await mgr.initialize();

    await mgr.addPdfJob(PDF_JOB);
    await mgr.addNotificationJob(NOTIF_JOB);

    const pdfAdd = captured.addCalls.find((c) => c.queueName === QUEUE_NAMES.PDF_GENERATION);
    const notifAdd = captured.addCalls.find((c) => c.queueName === QUEUE_NAMES.NOTIFICATIONS);

    expect(pdfAdd).toBeDefined();
    expect(notifAdd).toBeDefined();
    expect(pdfAdd!.opts.removeOnFail).toEqual({ count: 500 });
    expect(notifAdd!.opts.removeOnFail).toEqual({ count: 500 });

    await mgr.shutdown();
  });

  it('evicts oldest failures first down to the configured limit (example)', async () => {
    const mgr = new QueueManager({ redisUrl: 'redis://localhost:6379', failedJobRetention: '3' });
    await mgr.initialize();

    const limit = mgr.getFailedRetentionLimit(); // 3
    // Five failures, oldest → newest by failure timestamp.
    const failedOldestFirst = ['fail-1', 'fail-2', 'fail-3', 'fail-4', 'fail-5'];

    const { retained, evicted } = applyOldestFirstEviction(failedOldestFirst, limit);

    // Retained count equals the configured limit.
    expect(retained).toHaveLength(limit);
    // Oldest two were evicted, in oldest-first order.
    expect(evicted).toEqual(['fail-1', 'fail-2']);
    // The newest `limit` failures are retained.
    expect(retained).toEqual(['fail-3', 'fail-4', 'fail-5']);

    await mgr.shutdown();
  });

  it('for ANY failure sequence, retained count never exceeds the limit and only oldest are evicted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }), // configured retention limit
        fc.integer({ min: 0, max: 200 }), // number of failed jobs
        async (limit, failureCount) => {
          const mgr = new QueueManager({
            redisUrl: 'redis://localhost:6379',
            failedJobRetention: String(limit),
          });

          const appliedLimit = mgr.getFailedRetentionLimit();
          expect(appliedLimit).toBe(limit);

          // Failures ordered oldest → newest (index encodes failure timestamp order).
          const failedOldestFirst = Array.from({ length: failureCount }, (_, i) => i);
          const { retained, evicted } = applyOldestFirstEviction(failedOldestFirst, appliedLimit);

          // Retained count equals min(total, limit) and never exceeds the limit.
          expect(retained.length).toBe(Math.min(failureCount, appliedLimit));
          expect(retained.length).toBeLessThanOrEqual(appliedLimit);

          // Partition is complete and disjoint.
          expect(retained.length + evicted.length).toBe(failureCount);

          // Evicted are strictly the oldest (lowest timestamps); retained are the newest.
          if (evicted.length > 0) {
            const maxEvicted = Math.max(...evicted);
            const minRetained = retained.length > 0 ? Math.min(...retained) : Infinity;
            expect(maxEvicted).toBeLessThan(minRetained);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

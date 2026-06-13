/**
 * BullMQ Queue Manager
 *
 * Configures BullMQ with Redis connection and defines queues for background job processing.
 * - pdf-generation queue (concurrency: 5)
 * - notifications queue (concurrency: 20)
 * - Retry: max 3 attempts, exponential backoff (2s start, 30s max)
 * - Stalled job detection: 5-minute timeout, re-queue on stall
 * - Dead letter queue for exhausted retries
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6, 5.7
 */

import { Queue, Worker, QueueEvents, type JobsOptions, type ConnectionOptions } from 'bullmq';
import logger from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PdfJobData {
  /** Unique identifier for the PDF generation request */
  requestId: string;
  /** Template name or ID to use for PDF generation */
  templateId: string;
  /** Data to inject into the template */
  payload: Record<string, unknown>;
  /** User ID who requested the PDF */
  userId: string;
}

export interface NotificationJobData {
  /** Recipient user ID */
  recipientId: string;
  /** Notification type (e.g., 'email', 'push', 'in-app') */
  type: string;
  /** Notification title */
  title: string;
  /** Notification body/message */
  body: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface QueueManagerOptions {
  /** Redis connection URL (defaults to process.env.REDIS_URL) */
  redisUrl?: string;
  /**
   * Raw failed-job retention value (defaults to process.env.QUEUE_FAILED_RETENTION).
   * Parsed and validated via {@link parseFailedJobRetention}; an invalid value is
   * rejected and the default retention limit is retained.
   */
  failedJobRetention?: string;
}

/**
 * Result of parsing a failed-job retention configuration value.
 * On success, carries the validated retention `limit` (1..100000).
 * On failure, carries a human-readable `reason` describing why it was rejected.
 *
 * Validates: Requirements 21.1, 21.3
 */
export type FailedJobRetentionResult =
  | { ok: true; limit: number }
  | { ok: false; reason: string };

// ─── Constants ───────────────────────────────────────────────────────────────

/** Queue names */
export const QUEUE_NAMES = {
  PDF_GENERATION: 'pdf-generation',
  NOTIFICATIONS: 'notifications',
  DEAD_LETTER: 'dead-letter',
} as const;

/** Concurrency limits per queue */
export const CONCURRENCY = {
  PDF_GENERATION: 5,
  NOTIFICATIONS: 20,
} as const;

/** Default job options with retry and backoff configuration */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000, // 2 seconds initial delay
  },
  removeOnComplete: {
    count: 1000, // Keep last 1000 completed jobs for querying
  },
  removeOnFail: false, // Keep failed jobs for inspection
};

// ─── Failed-Job Retention (Requirement 21) ─────────────────────────────────────

/** Inclusive lower bound for the failed-job retention limit (Req 21.1). */
export const FAILED_RETENTION_MIN = 1;

/** Inclusive upper bound for the failed-job retention limit (Req 21.1). */
export const FAILED_RETENTION_MAX = 100_000;

/** Default failed-job retention limit applied when no value is provided (Req 21.1). */
export const FAILED_RETENTION_DEFAULT = 1000;

/** Matches a base-10 integer with no decimal point, exponent, or stray characters. */
const FAILED_RETENTION_INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Pure parser for the failed-job retention limit (Requirements 21.1, 21.3).
 *
 * - An unset value (`undefined`) or one that trims to empty resolves to the
 *   documented default of {@link FAILED_RETENTION_DEFAULT} (Req 21.1).
 * - A present value must be an integer within
 *   {@link FAILED_RETENTION_MIN}..{@link FAILED_RETENTION_MAX}; non-numeric or
 *   out-of-range values are rejected with a descriptive reason (Req 21.3).
 *
 * No side effects so it can be unit- and property-tested in isolation.
 */
export function parseFailedJobRetention(raw: string | undefined): FailedJobRetentionResult {
  if (raw === undefined) {
    return { ok: true, limit: FAILED_RETENTION_DEFAULT };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, limit: FAILED_RETENTION_DEFAULT };
  }

  if (!FAILED_RETENTION_INTEGER_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: `QUEUE_FAILED_RETENTION must be an integer ${FAILED_RETENTION_MIN}..${FAILED_RETENTION_MAX}; received "${raw}"`,
    };
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < FAILED_RETENTION_MIN || value > FAILED_RETENTION_MAX) {
    return {
      ok: false,
      reason: `QUEUE_FAILED_RETENTION must be an integer ${FAILED_RETENTION_MIN}..${FAILED_RETENTION_MAX}; received "${raw}"`,
    };
  }

  return { ok: true, limit: value };
}

/**
 * Stalled job interval in milliseconds (5 minutes).
 * Jobs not completing within this time are considered stalled and re-queued.
 */
const STALLED_INTERVAL_MS = 5 * 60 * 1000; // 300,000ms = 5 minutes

/**
 * Maximum number of times a job can be stalled before being marked as failed.
 * Set to 1 so stalled jobs get one re-queue attempt before failing.
 */
const MAX_STALLED_COUNT = 1;

// ─── Queue Manager ───────────────────────────────────────────────────────────

export class QueueManager {
  private pdfQueue: Queue<PdfJobData> | null = null;
  private notificationsQueue: Queue<NotificationJobData> | null = null;
  private deadLetterQueue: Queue | null = null;
  private queueEvents: QueueEvents[] = [];
  private workers: Worker[] = [];
  private readonly redisConnection: ConnectionOptions;
  private initialized = false;
  /**
   * Currently applied, validated failed-job retention limit (Req 21.1, 21.3).
   * Seeded with the documented default and only ever replaced by a valid value,
   * so an invalid configuration retains the previously applied valid limit.
   */
  private failedRetentionLimit: number = FAILED_RETENTION_DEFAULT;

  constructor(options: QueueManagerOptions = {}) {
    const redisUrl = options.redisUrl || process.env.REDIS_URL || '';

    if (!redisUrl) {
      logger.warn('[QueueManager] REDIS_URL is not defined. Queue system will not be available.');
    }

    // Parse Redis URL into connection options for BullMQ
    this.redisConnection = this.parseRedisUrl(redisUrl);

    // Apply the configured failed-job retention limit. An invalid value is
    // rejected and the default limit is retained (Req 21.3).
    const rawRetention = options.failedJobRetention ?? process.env.QUEUE_FAILED_RETENTION;
    const result = this.setFailedJobRetention(rawRetention);
    if (!result.ok) {
      logger.warn(
        `[QueueManager] Invalid failed-job retention configuration: ${result.reason}. ` +
        `Retaining previously applied limit of ${this.failedRetentionLimit}.`
      );
    }
  }

  /**
   * Parse a Redis URL into BullMQ-compatible connection options.
   */
  private parseRedisUrl(url: string): ConnectionOptions {
    if (!url) {
      return { host: 'localhost', port: 6379 };
    }

    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname || 'localhost',
        port: parseInt(parsed.port, 10) || 6379,
        password: parsed.password || undefined,
        username: parsed.username || undefined,
        ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
      };
    } catch {
      // If URL parsing fails, assume it's a host:port format
      logger.warn('[QueueManager] Could not parse REDIS_URL, falling back to localhost:6379');
      return { host: 'localhost', port: 6379 };
    }
  }

  /**
   * Apply a failed-job retention configuration value (Requirements 21.1, 21.3).
   *
   * On a valid value (an integer in {@link FAILED_RETENTION_MIN}..
   * {@link FAILED_RETENTION_MAX}, or unset → default), the applied limit is
   * updated and an `ok` result is returned. On an invalid value the previously
   * applied valid limit is retained and an error result is returned; the queue
   * configuration is otherwise rejected by the caller.
   */
  setFailedJobRetention(raw: string | undefined): FailedJobRetentionResult {
    const result = parseFailedJobRetention(raw);
    if (result.ok) {
      this.failedRetentionLimit = result.limit;
    }
    return result;
  }

  /** The currently applied, validated failed-job retention limit (Req 21.1). */
  getFailedRetentionLimit(): number {
    return this.failedRetentionLimit;
  }

  /**
   * Build the default job options for this manager, binding the bounded
   * failed-job retention so BullMQ keeps at most the configured number of
   * failed jobs and evicts the oldest first (Req 21.1, 21.2).
   */
  private buildJobOptions(overrides?: Partial<JobsOptions>): JobsOptions {
    return {
      ...DEFAULT_JOB_OPTIONS,
      removeOnFail: { count: this.failedRetentionLimit },
      ...overrides,
    };
  }

  /**
   * Initialize all queues and queue event listeners.
   * Must be called before adding jobs.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('[QueueManager] Already initialized.');
      return;
    }

    try {
      // Create the dead letter queue first
      this.deadLetterQueue = new Queue(QUEUE_NAMES.DEAD_LETTER, {
        connection: this.redisConnection,
      });

      // Create the PDF generation queue
      this.pdfQueue = new Queue<PdfJobData>(QUEUE_NAMES.PDF_GENERATION, {
        connection: this.redisConnection,
        defaultJobOptions: this.buildJobOptions(),
      });

      // Create the notifications queue
      this.notificationsQueue = new Queue<NotificationJobData>(QUEUE_NAMES.NOTIFICATIONS, {
        connection: this.redisConnection,
        defaultJobOptions: this.buildJobOptions(),
      });

      // Set up queue event listeners for monitoring
      await this.setupQueueEvents();

      this.initialized = true;
      logger.info('[QueueManager] All queues initialized successfully.');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[QueueManager] Failed to initialize queues: ${errorMessage}`);
      throw err;
    }
  }

  /**
   * Set up QueueEvents listeners for dead letter queue handling and logging.
   */
  private async setupQueueEvents(): Promise<void> {
    // PDF queue events
    const pdfEvents = new QueueEvents(QUEUE_NAMES.PDF_GENERATION, {
      connection: this.redisConnection,
    });

    pdfEvents.on('failed', async ({ jobId, failedReason }) => {
      logger.error(`[QueueManager] PDF job ${jobId} failed: ${failedReason}`);
      await this.moveToDeadLetterIfExhausted(
        QUEUE_NAMES.PDF_GENERATION,
        jobId,
        failedReason
      );
    });

    pdfEvents.on('stalled', ({ jobId }) => {
      logger.warn(`[QueueManager] PDF job ${jobId} stalled - will be re-queued.`);
    });

    pdfEvents.on('completed', ({ jobId }) => {
      logger.info(`[QueueManager] PDF job ${jobId} completed successfully.`);
    });

    this.queueEvents.push(pdfEvents);

    // Notifications queue events
    const notifEvents = new QueueEvents(QUEUE_NAMES.NOTIFICATIONS, {
      connection: this.redisConnection,
    });

    notifEvents.on('failed', async ({ jobId, failedReason }) => {
      logger.error(`[QueueManager] Notification job ${jobId} failed: ${failedReason}`);
      await this.moveToDeadLetterIfExhausted(
        QUEUE_NAMES.NOTIFICATIONS,
        jobId,
        failedReason
      );
    });

    notifEvents.on('stalled', ({ jobId }) => {
      logger.warn(`[QueueManager] Notification job ${jobId} stalled - will be re-queued.`);
    });

    notifEvents.on('completed', ({ jobId }) => {
      logger.info(`[QueueManager] Notification job ${jobId} completed successfully.`);
    });

    this.queueEvents.push(notifEvents);
  }

  /**
   * Check if a failed job has exhausted all retries and move it to the dead letter queue.
   * Requirement 5.4: Exhausted retries → move to dead letter queue with failure reason.
   */
  private async moveToDeadLetterIfExhausted(
    sourceQueueName: string,
    jobId: string,
    failedReason: string
  ): Promise<void> {
    try {
      const sourceQueue = sourceQueueName === QUEUE_NAMES.PDF_GENERATION
        ? this.pdfQueue
        : this.notificationsQueue;

      if (!sourceQueue || !this.deadLetterQueue) return;

      const job = await sourceQueue.getJob(jobId);
      if (!job) return;

      // Check if all attempts are exhausted
      const attemptsMade = job.attemptsMade;
      const maxAttempts = job.opts?.attempts ?? 3;

      if (attemptsMade >= maxAttempts) {
        // Move to dead letter queue
        await this.deadLetterQueue.add('dead-letter-job', {
          originalQueue: sourceQueueName,
          originalJobId: jobId,
          originalData: job.data,
          failedReason,
          attemptsMade,
          failedAt: new Date().toISOString(),
        });

        logger.error(
          `[QueueManager] Job ${jobId} from "${sourceQueueName}" exhausted all ${maxAttempts} retries. ` +
          `Moved to dead letter queue. Reason: ${failedReason}`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[QueueManager] Error moving job ${jobId} to dead letter queue: ${errorMessage}`);
    }
  }

  // ─── Job Addition Methods ─────────────────────────────────────────────────

  /**
   * Add a PDF generation job to the queue.
   * Returns the job ID within 500ms (requirement 5.1).
   *
   * @param data - PDF job data including template and payload
   * @param options - Optional job-specific options to override defaults
   * @returns The job ID
   */
  async addPdfJob(data: PdfJobData, options?: Partial<JobsOptions>): Promise<string> {
    if (!this.pdfQueue) {
      throw new Error('[QueueManager] PDF queue not initialized. Call initialize() first.');
    }

    const job = await this.pdfQueue.add('generate-pdf', data, this.buildJobOptions(options));

    logger.info(`[QueueManager] PDF job ${job.id} added to queue for request ${data.requestId}.`);
    return job.id!;
  }

  /**
   * Add a notification job to the queue.
   * Returns the job ID immediately (requirement 5.2).
   *
   * @param data - Notification job data
   * @param options - Optional job-specific options to override defaults
   * @returns The job ID
   */
  async addNotificationJob(data: NotificationJobData, options?: Partial<JobsOptions>): Promise<string> {
    if (!this.notificationsQueue) {
      throw new Error('[QueueManager] Notifications queue not initialized. Call initialize() first.');
    }

    const job = await this.notificationsQueue.add('send-notification', data, this.buildJobOptions(options));

    logger.info(
      `[QueueManager] Notification job ${job.id} added to queue for recipient ${data.recipientId}.`
    );
    return job.id!;
  }

  // ─── Worker Registration ──────────────────────────────────────────────────

  /**
   * Register a worker for the PDF generation queue.
   * Configures stalled job detection (5 min) and concurrency (5).
   *
   * @param processor - The function to process PDF jobs
   * @returns The created worker instance
   */
  registerPdfWorker(processor: (job: any) => Promise<any>): Worker {
    const worker = new Worker(QUEUE_NAMES.PDF_GENERATION, processor, {
      connection: this.redisConnection,
      concurrency: CONCURRENCY.PDF_GENERATION,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    });

    worker.on('error', (err) => {
      logger.error(`[QueueManager] PDF worker error: ${err.message}`);
    });

    this.workers.push(worker);
    logger.info(`[QueueManager] PDF worker registered (concurrency: ${CONCURRENCY.PDF_GENERATION}).`);
    return worker;
  }

  /**
   * Register a worker for the notifications queue.
   * Configures stalled job detection (5 min) and concurrency (20).
   *
   * @param processor - The function to process notification jobs
   * @returns The created worker instance
   */
  registerNotificationWorker(processor: (job: any) => Promise<any>): Worker {
    const worker = new Worker(QUEUE_NAMES.NOTIFICATIONS, processor, {
      connection: this.redisConnection,
      concurrency: CONCURRENCY.NOTIFICATIONS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    });

    worker.on('error', (err) => {
      logger.error(`[QueueManager] Notification worker error: ${err.message}`);
    });

    this.workers.push(worker);
    logger.info(`[QueueManager] Notification worker registered (concurrency: ${CONCURRENCY.NOTIFICATIONS}).`);
    return worker;
  }

  // ─── Queue Access ─────────────────────────────────────────────────────────

  /** Get the PDF generation queue instance */
  getPdfQueue(): Queue<PdfJobData> | null {
    return this.pdfQueue;
  }

  /** Get the notifications queue instance */
  getNotificationsQueue(): Queue<NotificationJobData> | null {
    return this.notificationsQueue;
  }

  /** Get the dead letter queue instance */
  getDeadLetterQueue(): Queue | null {
    return this.deadLetterQueue;
  }

  /** Whether the queue manager has been initialized */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Get the Redis connection options used by this manager */
  getConnectionOptions(): ConnectionOptions {
    return this.redisConnection;
  }

  // ─── Graceful Shutdown ────────────────────────────────────────────────────

  /**
   * Gracefully shut down all queues, workers, and event listeners.
   * Waits for active jobs to complete before closing.
   */
  async shutdown(): Promise<void> {
    logger.info('[QueueManager] Initiating graceful shutdown...');

    // Close all workers (waits for active jobs to finish)
    await Promise.all(
      this.workers.map(async (worker) => {
        try {
          await worker.close();
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`[QueueManager] Error closing worker: ${errorMessage}`);
        }
      })
    );
    this.workers = [];

    // Close all queue event listeners
    await Promise.all(
      this.queueEvents.map(async (events) => {
        try {
          await events.close();
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`[QueueManager] Error closing queue events: ${errorMessage}`);
        }
      })
    );
    this.queueEvents = [];

    // Close all queues
    const queues = [this.pdfQueue, this.notificationsQueue, this.deadLetterQueue].filter(Boolean);
    await Promise.all(
      queues.map(async (queue) => {
        try {
          await queue!.close();
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`[QueueManager] Error closing queue: ${errorMessage}`);
        }
      })
    );

    this.pdfQueue = null;
    this.notificationsQueue = null;
    this.deadLetterQueue = null;
    this.initialized = false;

    logger.info('[QueueManager] All queues shut down gracefully.');
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

/** Singleton queue manager instance for application-wide use */
export const queueManager = new QueueManager();

export default queueManager;

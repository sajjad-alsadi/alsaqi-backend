/**
 * Notification Worker
 *
 * Processes notification jobs from the BullMQ notifications queue.
 * Handles delivery of in-app notifications (database insert + WebSocket push).
 * Logs job success/failure and execution duration.
 *
 * Validates: Requirements 5.2, 5.5
 */

import { Job } from 'bullmq';
import logger from '../../utils/logger.js';
import type { NotificationJobData } from '../queueManager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationJobResult {
  /** Whether the notification was delivered successfully */
  success: boolean;
  /** Number of recipients who received the notification */
  recipientCount: number;
  /** Duration of processing in milliseconds */
  durationMs: number;
  /** Job ID for reference */
  jobId: string;
  /** ISO timestamp of completion */
  completedAt: string;
}

// ─── Worker Processor ────────────────────────────────────────────────────────

/**
 * Process a notification job from the queue.
 *
 * This is the processor function registered with the BullMQ worker.
 * It handles:
 * - In-app notification delivery (DB insert + WebSocket)
 * - Logging job status (success/failure) and execution duration
 *
 * Requirement 5.5: Log job status and execution duration.
 */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<NotificationJobResult> {
  const startTime = Date.now();
  const jobId = job.id || 'unknown';

  logger.info(`[NotificationWorker] Processing job ${jobId} - type: ${job.data.type}, recipient: ${job.data.recipientId}`);

  try {
    // Dynamically import NotificationService to avoid circular dependencies
    const { NotificationService } = await import('../../services/NotificationService.js');

    const { recipientId, type, title, body, metadata } = job.data;

    // Deliver the notification via the existing NotificationService
    await NotificationService.create(
      recipientId,
      type,
      body,
      metadata?.relatedModule as string || 'system',
      metadata?.link as string || '/',
      {
        actorId: metadata?.actorId as string | undefined,
        entityId: metadata?.entityId as string | undefined,
        entityType: metadata?.entityType as string | undefined,
        data: metadata?.data as Record<string, any> | undefined,
        wss: metadata?.wss,
        title: title || undefined,
      }
    );

    const durationMs = Date.now() - startTime;

    // Requirement 5.5: Log job success with execution duration
    logger.info(
      `[NotificationWorker] Job ${jobId} completed successfully in ${durationMs}ms - ` +
      `type: ${type}, recipient: ${recipientId}`
    );

    return {
      success: true,
      recipientCount: 1,
      durationMs,
      jobId,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Requirement 5.5: Log job failure with execution duration
    logger.error(
      `[NotificationWorker] Job ${jobId} failed after ${durationMs}ms - ` +
      `type: ${job.data.type}, recipient: ${job.data.recipientId}, error: ${errorMessage}`
    );

    throw error; // Re-throw to trigger BullMQ retry mechanism
  }
}

// ─── Worker Registration ─────────────────────────────────────────────────────

/**
 * Initialize and register the notification worker with the queue manager.
 * Call this during application startup to begin processing notification jobs.
 *
 * @param queueMgr - The queue manager instance to register with
 * @returns The registered worker instance
 */
export function startNotificationWorker(queueMgr: import('../queueManager.js').QueueManager) {
  const worker = queueMgr.registerNotificationWorker(processNotificationJob);

  logger.info('[NotificationWorker] Worker started and listening for notification jobs.');

  return worker;
}

export default processNotificationJob;

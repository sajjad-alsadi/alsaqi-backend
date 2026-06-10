/**
 * Notification Queue Service
 *
 * Provides an async notification delivery interface that enqueues notifications
 * via BullMQ instead of processing them synchronously.
 * Returns a job ID to the caller immediately.
 *
 * Validates: Requirements 5.2, 5.5
 */

import logger from '../utils/logger.js';
import { queueManager, type NotificationJobData } from './queueManager.js';
import type { CreateNotificationOptions } from '../services/NotificationService.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EnqueueNotificationResult {
  /** The BullMQ job ID returned immediately to the caller */
  jobId: string;
  /** Whether the job was successfully enqueued */
  enqueued: boolean;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a notification for async delivery via the BullMQ notifications queue.
 * Returns a job ID to the caller immediately (requirement 5.2).
 *
 * If the queue system is not initialized or not available, falls back to
 * synchronous delivery via NotificationService.create() and returns a
 * generated fallback ID.
 *
 * @param recipientId - Target user ID or 'all' or array of user IDs
 * @param type - Notification event type (e.g., 'task_assigned', 'comment_added')
 * @param title - Short notification title
 * @param body - Notification message/description
 * @param options - Additional options (actorId, entityId, wss, etc.)
 * @returns Object with the job ID and enqueue status
 */
export async function enqueueNotification(
  recipientId: string | string[] | 'all',
  type: string,
  title: string,
  body: string,
  options?: CreateNotificationOptions & { relatedModule?: string; link?: string }
): Promise<EnqueueNotificationResult> {
  // If queueManager is not initialized, fall back to synchronous delivery
  if (!queueManager.isInitialized) {
    logger.warn('[NotificationQueueService] Queue not initialized, falling back to synchronous delivery.');
    try {
      const { NotificationService } = await import('../services/NotificationService.js');
      await NotificationService.create(
        recipientId,
        type,
        body,
        options?.relatedModule || 'system',
        options?.link || '/',
        options
      );
      const fallbackId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      return { jobId: fallbackId, enqueued: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[NotificationQueueService] Synchronous fallback failed: ${errorMessage}`);
      throw error;
    }
  }

  try {
    // Handle multiple recipients by enqueuing separate jobs for each
    const recipients = resolveRecipients(recipientId);

    // For single recipient, enqueue directly
    if (recipients.length === 1) {
      const jobData: NotificationJobData = {
        recipientId: recipients[0],
        type,
        title,
        body,
        metadata: {
          actorId: options?.actorId,
          entityId: options?.entityId,
          entityType: options?.entityType,
          data: options?.data,
          relatedModule: options?.relatedModule || 'system',
          link: options?.link || '/',
          // Note: wss (WebSocket server) cannot be serialized to Redis;
          // the worker will handle WebSocket push if wss is available at process time
        },
      };

      const jobId = await queueManager.addNotificationJob(jobData);

      logger.info(
        `[NotificationQueueService] Notification enqueued - jobId: ${jobId}, type: ${type}, recipient: ${recipients[0]}`
      );

      return { jobId, enqueued: true };
    }

    // For multiple recipients, enqueue one job per recipient and return the first job ID
    const jobIds: string[] = [];
    for (const recipient of recipients) {
      const jobData: NotificationJobData = {
        recipientId: recipient,
        type,
        title,
        body,
        metadata: {
          actorId: options?.actorId,
          entityId: options?.entityId,
          entityType: options?.entityType,
          data: options?.data,
          relatedModule: options?.relatedModule || 'system',
          link: options?.link || '/',
        },
      };

      const jobId = await queueManager.addNotificationJob(jobData);
      jobIds.push(jobId);
    }

    logger.info(
      `[NotificationQueueService] ${jobIds.length} notification jobs enqueued - type: ${type}, firstJobId: ${jobIds[0]}`
    );

    // Return the first job ID as reference (caller can track the batch)
    return { jobId: jobIds[0], enqueued: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[NotificationQueueService] Failed to enqueue notification: ${errorMessage}`);

    // Fall back to synchronous delivery on queue failure
    logger.warn('[NotificationQueueService] Falling back to synchronous delivery after enqueue failure.');
    try {
      const { NotificationService } = await import('../services/NotificationService.js');
      await NotificationService.create(
        recipientId,
        type,
        body,
        options?.relatedModule || 'system',
        options?.link || '/',
        options
      );
      const fallbackId = `sync-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      return { jobId: fallbackId, enqueued: false };
    } catch (fallbackError) {
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger.error(`[NotificationQueueService] Synchronous fallback also failed: ${fallbackMsg}`);
      throw fallbackError;
    }
  }
}

/**
 * Resolve recipient identifiers to an array of user IDs.
 * For 'all', returns a single-element array with 'all' so the worker
 * can handle the broadcast resolution at processing time.
 */
function resolveRecipients(recipientId: string | string[] | 'all'): string[] {
  if (recipientId === 'all') {
    // Let the worker resolve 'all' at processing time to avoid
    // stale user lists in the queue
    return ['all'];
  }
  if (Array.isArray(recipientId)) {
    return recipientId;
  }
  return [recipientId];
}

export default { enqueueNotification };

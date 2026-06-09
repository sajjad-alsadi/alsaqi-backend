/**
 * Report Generation Routes
 *
 * POST /reports/generate   - Create report record, queue BullMQ job, respond 202
 * GET  /reports/:reportId/status - Return status, downloadUrl (if ready), errorMessage (if failed)
 *
 * Implements 5-minute timeout: reports stuck in 'pending' are marked 'failed' on status poll.
 *
 * Requirements: 5.7, 8.1, 8.4, 8.5, 8.6
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ValidationError } from '../utils/errors.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Reports in 'pending' for longer than this are marked 'failed' with timeout message */
const REPORT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const TIMEOUT_ERROR_MESSAGE = 'Report generation timed out after 5 minutes. Please try again.';

// ─── Validation ──────────────────────────────────────────────────────────────

const generateReportSchema = z.object({
  auditId: z.string().min(1, 'auditId is required'),
  templateTypeKey: z.string().optional().default('audit_report'),
  title: z.string().optional(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal interface for the QueueService required by this route.
 * Matches the enqueue signature from src/server/services/queue.service.ts.
 */
export interface ReportQueueService {
  enqueue(
    type: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ jobId: string }>;
}

/**
 * Minimal interface for the StorageService required by this route.
 */
export interface ReportStorageService {
  getPresignedUrl(key: string, bucket: string, expiresInSeconds: number): Promise<string>;
}

// ─── Route Factory ───────────────────────────────────────────────────────────

export const createReportsRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any,
  queueService?: ReportQueueService | null,
  storageService?: ReportStorageService | null,
) => {
  const router = express.Router();

  /**
   * POST /reports/generate
   *
   * Creates a report record with status 'pending', queues a BullMQ generate-pdf job,
   * and responds with 202 Accepted containing the reportId.
   *
   * Requirements: 5.7, 8.1
   */
  router.post(
    '/generate',
    authenticate,
    asyncHandler(async (req: any, res: any) => {
      const validation = generateReportSchema.safeParse(req.body);
      if (!validation.success) {
        throw new ValidationError('Invalid report generation request', validation.error.format());
      }

      const { auditId, templateTypeKey, title } = validation.data;

      // Create a report record with status 'pending'
      const reportId = uuidv4();
      const reportTitle = title || `Generated Report - ${templateTypeKey}`;

      await db.prepare(
        `INSERT INTO audit_reports (id, audit_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(reportId, auditId, reportTitle, 'pending');

      // Queue BullMQ generate-pdf job
      if (queueService) {
        try {
          await queueService.enqueue('generate-pdf', {
            reportId,
            auditId,
            template: templateTypeKey,
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          });
        } catch (queueError: any) {
          // Log but don't fail the request — report will time out
          if (logError) {
            logError('reports', `Failed to queue generate-pdf job: ${queueError?.message}`);
          }
        }
      }

      // Respond 202 with reportId (Requirement 5.7, 8.1)
      return res.status(202).json({ reportId });
    }),
  );

  /**
   * GET /reports/:reportId/status
   *
   * Returns the current report status.
   * - If 'ready': includes downloadUrl
   * - If 'failed': includes errorMessage
   * - If 'pending': returns status only (no downloadUrl/errorMessage)
   *
   * Also implements 5-minute timeout check (Requirement 8.5):
   * If the report has been in 'pending' for > 5 minutes, it is marked 'failed'.
   *
   * Requirements: 8.4, 8.5, 8.6
   */
  router.get(
    '/:reportId/status',
    authenticate,
    asyncHandler(async (req: any, res: any) => {
      const { reportId } = req.params;

      const report = await db.prepare(
        `SELECT id, status, content, error, created_at FROM audit_reports WHERE id = ?`
      ).get(reportId);

      if (!report) {
        return res.status(404).json({ error: 'Report not found' });
      }

      // Check 5-minute timeout for pending reports (Requirement 8.5)
      if (report.status === 'pending') {
        const createdAt = new Date(report.created_at).getTime();
        const now = Date.now();

        if (now - createdAt > REPORT_TIMEOUT_MS) {
          // Mark report as failed due to timeout
          await db.prepare(
            `UPDATE audit_reports SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).run('failed', TIMEOUT_ERROR_MESSAGE, reportId);

          return res.json({
            status: 'failed',
            errorMessage: TIMEOUT_ERROR_MESSAGE,
          });
        }

        // Still pending — return status only (Requirement 8.6)
        return res.json({ status: 'pending' });
      }

      // Report is 'ready' — include downloadUrl (Requirement 8.4)
      if (report.status === 'ready') {
        let downloadUrl: string | undefined;

        // The 'content' column stores the storage key (set by generate-pdf worker)
        if (report.content) {
          if (storageService) {
            try {
              downloadUrl = await storageService.getPresignedUrl(report.content, 'reports', 3600);
            } catch {
              // Fallback: relative download URL
              downloadUrl = `/api/v1/reports/${reportId}/download`;
            }
          } else {
            downloadUrl = `/api/v1/reports/${reportId}/download`;
          }
        }

        return res.json({
          status: 'ready',
          downloadUrl,
        });
      }

      // Report is 'failed' — include errorMessage (Requirement 8.4)
      if (report.status === 'failed') {
        return res.json({
          status: 'failed',
          errorMessage: report.error || 'Report generation failed.',
        });
      }

      // Unknown status — return as-is
      return res.json({ status: report.status });
    }),
  );

  return router;
};

import express from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import { PdfTemplateService } from '../services/PdfTemplateService';
import { pdfEngine } from '../services/PdfEngine.js';
import { SettingsService } from '../services/SettingsService';
import { mapRowToSettings } from '../types/pdf';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';
import queueManager from '../queues/queueManager.js';
import logger from '../utils/logger.js';
import type { PdfSettings, PdfTemplate } from '../types/pdf';

const templateSchema = z.object({
  template_name: z.string(),
  template_type: z.string(),
  content: z.string(),
  status: z.enum(['Draft', 'Approved', 'Archived']).optional(),
  is_default: z.union([z.boolean(), z.number()]).optional()
});

const previewSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  sampleData: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Rate limiter for preview endpoints.
 * Requirement 9.4: 10 preview requests per minute per user.
 */
const previewRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per window per user
  message: { error: 'Rate limit exceeded. Maximum 10 preview requests per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => {
    // Key by authenticated user ID for per-user limiting
    return req.user?.id || 'anonymous';
  },
});

export const createPdfTemplatesRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/pdf-templates`, authenticate, checkPermission('Settings', 'View'), asyncHandler(async (req, res) => {
    const templates = await PdfTemplateService.getAll();
    res.json(templates);
  }));

  router.get(`/pdf-templates/active`, authenticate, asyncHandler(async (req, res) => {
    const { type } = req.query;
    if (!type) {
      return res.status(400).json({ error: "Type is required" });
    }
    const template = await PdfTemplateService.getActiveByType(type as string);
    if (!template) {
      return res.status(404).json({ error: "No active template found" });
    }
    res.json(template);
  }));

  // ─── Preview Endpoints ──────────────────────────────────────────────────

  /**
   * POST /pdf-templates/preview-html
   * Compiles Handlebars template with sample data and returns HTML for iframe preview.
   * Requirements: 6.3, 9.4
   */
  router.post(`/pdf-templates/preview-html`, authenticate, previewRateLimiter, asyncHandler(async (req, res) => {
    const validation = previewSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid request', details: validation.error.format() });
    }

    const { content, sampleData } = validation.data;

    // Fetch current PDF settings and convert to service-layer format
    const rawSettings = await SettingsService.getPdfSettings();
    const settings: PdfSettings = mapRowToSettings(rawSettings as any);

    // Determine language (default to Arabic for this system)
    const language: 'ar' | 'en' = settings.rtl_enabled ? 'ar' : 'en';

    // Compile preview HTML (synchronous, no Puppeteer)
    const result = pdfEngine.compilePreviewHtml(content, sampleData, settings, language);

    res.json({
      compiledHtml: result.compiledHtml,
      errors: result.errors,
    });
  }));

  /**
   * POST /pdf-templates/preview-pdf
   * Enqueues a PDF generation job and returns 202 with job ID.
   *
   * Requirements:
   * - 5.1: Return job ID within 500ms
   * - 13.3: Process via queue system, respond immediately with HTTP 202 + job ID
   *
   * Falls back to inline rendering if the queue is not available.
   */
  router.post(`/pdf-templates/preview-pdf`, authenticate, previewRateLimiter, asyncHandler(async (req, res) => {
    const validation = previewSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid request', details: validation.error.format() });
    }

    const { content, sampleData } = validation.data;
    const userId = (req as any).user?.id || 'anonymous';

    // Requirement 13.3: Process via queue system, respond with 202 + job ID
    if (queueManager.isInitialized) {
      const requestId = uuidv4();

      try {
        // Requirement 5.1: Enqueue and return job ID within 500ms
        const jobId = await queueManager.addPdfJob({
          requestId,
          templateId: 'general', // Preview uses general template type
          payload: { ...sampleData, __previewContent: content },
          userId,
        });

        logger.info(`[PdfTemplates] PDF preview job enqueued. JobId: ${jobId}, RequestId: ${requestId}, UserId: ${userId}`);

        // Requirement 5.1, 13.3: Return 202 Accepted with job ID
        return res.status(202).json({
          jobId,
          requestId,
          status: 'queued',
          message: 'PDF generation job has been queued for processing.',
        });
      } catch (queueErr) {
        // If queueing fails, log and fall back to inline rendering
        logger.warn(
          `[PdfTemplates] Failed to enqueue PDF job, falling back to inline rendering: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`
        );
      }
    }

    // Fallback: Inline rendering when queue is not available
    const rawSettings = await SettingsService.getPdfSettings();
    const settings: PdfSettings = mapRowToSettings(rawSettings as any);
    const language: 'ar' | 'en' = settings.rtl_enabled ? 'ar' : 'en';

    const tempTemplate: PdfTemplate = {
      id: 'preview',
      template_name: 'Preview',
      template_type_key: 'general',
      content,
      status: 'Draft',
      is_default: false,
      version: 0,
      created_by: 'preview',
      updated_by: 'preview',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await pdfEngine.renderFromTemplate({
      template: tempTemplate,
      data: sampleData,
      settings,
      language,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.setHeader('Content-Length', result.fileSize.toString());
    res.send(result.buffer);
  }));

  // ─── CRUD Endpoints ─────────────────────────────────────────────────────

  router.get(`/pdf-templates/:id`, authenticate, checkPermission('Settings', 'View'), asyncHandler(async (req, res) => {
    const template = await PdfTemplateService.getById(req.params.id as string);
    res.json(template);
  }));

  router.post(`/pdf-templates`, authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const validation = templateSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid template data", validation.error.format());
    }
    const username = (req as any).user.username;
    const template = await PdfTemplateService.create(validation.data, username);
    res.json(template);
  }));

  router.put(`/pdf-templates/:id`, authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const validation = templateSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid template data", validation.error.format());
    }
    const username = (req as any).user.username;
    const template = await PdfTemplateService.update(req.params.id as string, validation.data, username);
    res.json(template);
  }));

  router.delete(`/pdf-templates/:id`, authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const username = (req as any).user.username;
    await PdfTemplateService.delete(req.params.id as string, username);
    res.json({ success: true });
  }));

  return router;
};

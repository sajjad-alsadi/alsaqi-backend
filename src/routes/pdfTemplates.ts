import express from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { PdfTemplateService } from '../services/PdfTemplateService';
import { pdfEngine } from '../services/PdfEngine.js';
import { SettingsService } from '../services/SettingsService';
import { mapRowToSettings } from '../types/pdf';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';
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
   * Generates a real PDF via Puppeteer and returns it as a downloadable blob.
   * Requirements: 6.6, 9.4
   */
  router.post(`/pdf-templates/preview-pdf`, authenticate, previewRateLimiter, asyncHandler(async (req, res) => {
    const validation = previewSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid request', details: validation.error.format() });
    }

    const { content, sampleData } = validation.data;

    // Fetch current PDF settings and convert to service-layer format
    const rawSettings = await SettingsService.getPdfSettings();
    const settings: PdfSettings = mapRowToSettings(rawSettings as any);

    // Determine language
    const language: 'ar' | 'en' = settings.rtl_enabled ? 'ar' : 'en';

    // Create a temporary PdfTemplate object for rendering
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

    // Render PDF via Puppeteer (30-second timeout handled internally by PdfEngine)
    const result = await pdfEngine.renderFromTemplate({
      template: tempTemplate,
      data: sampleData,
      settings,
      language,
    });

    // Return PDF as blob
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

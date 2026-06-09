import express from 'express';
import { z } from 'zod';
import { SettingsService } from '../services/SettingsService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const pdfSettingsSchema = z.object({
  arabic_font_name: z.string().min(1),
  arabic_font_size: z.coerce.number().min(8).max(72),
  heading_font_size: z.coerce.number().min(8).max(72),
  subheading_font_size: z.coerce.number().min(8).max(72),
  table_font_size: z.coerce.number().min(8).max(72),
  rtl_enabled: z.coerce.number().min(0).max(1),
  margin_top: z.coerce.number().min(0).max(100),
  margin_right: z.coerce.number().min(0).max(100),
  margin_bottom: z.coerce.number().min(0).max(100),
  margin_left: z.coerce.number().min(0).max(100),
  header_template: z.string().optional().nullable(),
  footer_template: z.string().optional().nullable(),
  logo_position: z.enum(['Left', 'Center', 'Right', 'None', 'left', 'center', 'right', 'none']),
  show_page_number: z.coerce.number().min(0).max(1)
});

const appSettingsSchema = z.object({
  app_name: z.string().min(1).max(255),
  app_version: z.string().min(1).max(50),
  app_description: z.string().optional().nullable(),
  company_name: z.string().min(1).max(255),
  system_owner: z.string().optional().nullable(),
  developer_name: z.string().optional().nullable(),
  release_date: z.string().optional().nullable(),
  last_update_date: z.string().optional().nullable(),
  support_email: z.string().email().optional().nullable().or(z.literal('')),
  support_phone: z.string().optional().nullable(),
  official_website: z.string().url().optional().nullable().or(z.literal('')),
  copyright_notice: z.string().optional().nullable(),
  system_environment: z.string().optional().nullable(),
  database_type: z.string().optional().nullable(),
  build_number: z.string().optional().nullable(),
  app_status: z.string().optional().nullable()
});

export const createAppSettingsRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get('/pdf-settings', authenticate, asyncHandler(async (req, res) => {
    const settings = await SettingsService.getPdfSettings();
    res.json(settings);
  }));

  router.put('/pdf-settings', authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const validation = pdfSettingsSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid PDF settings", validation.error.format());
    }
    await SettingsService.updatePdfSettings(validation.data);
    res.json({ success: true });
  }));

  router.get('/app-settings', authenticate, asyncHandler(async (req, res) => {
    const settings = await SettingsService.getAppSettings();
    res.json(settings);
  }));

  router.put('/app-settings', authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const validation = appSettingsSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid App settings", validation.error.format());
    }
    await SettingsService.updateAppSettings(validation.data);
    res.json({ success: true });
  }));

  return router;
};

import express from 'express';
import { z } from 'zod';
import { SettingsService } from '../services/SettingsService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const userManagementSettingsSchema = z.object({
  failed_login_threshold: z.coerce.number().int().min(1).max(20).optional(),
  inactive_account_threshold_days: z.coerce.number().int().min(1).max(365).optional(),
  password_min_length: z.coerce.number().int().min(6).max(32).optional(),
  session_timeout_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  password_require_uppercase: z.coerce.number().int().min(0).max(1).optional(),
  password_require_lowercase: z.coerce.number().int().min(0).max(1).optional(),
  password_require_numbers: z.coerce.number().int().min(0).max(1).optional(),
  password_require_symbols: z.coerce.number().int().min(0).max(1).optional(),
  password_expiry_days: z.coerce.number().int().min(0).max(365).optional(),
  enforce_single_session: z.coerce.number().int().min(0).max(1).optional(),
  two_factor_auth: z.coerce.number().int().min(0).max(1).optional()
});

export const createSettingsRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  // Public endpoint for session timeout (needed by all authenticated users for idle timeout)
  router.get(`/session-config`, authenticate, asyncHandler(async (req, res) => {
    const settings = await SettingsService.getUserManagementSettings();
    res.json({ session_timeout_minutes: settings.session_timeout_minutes || 30 });
  }));

  router.get(`/user-management-settings`, authenticate, checkPermission('Settings', 'View'), asyncHandler(async (req, res) => {
    const settings = await SettingsService.getUserManagementSettings();
    res.json(settings);
  }));

  router.put(`/user-management-settings`, authenticate, checkPermission('Settings', 'Edit'), asyncHandler(async (req, res) => {
    const validation = userManagementSettingsSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid user management settings", validation.error.format());
    }
    await SettingsService.updateUserManagementSettings(validation.data);
    res.json({ success: true });
  }));

  return router;
};

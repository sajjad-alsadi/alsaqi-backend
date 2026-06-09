import express from 'express';
import { z } from 'zod';
import { ProfileService } from '../services/ProfileService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const profileSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  department: z.string().optional().nullable(),
  profile_picture: z.string().optional().nullable(),
});

const preferencesSchema = z.object({
  language: z.string().optional(),
  dashboard_layout: z.string().optional(),
  notifications_enabled: z.boolean().optional(),
  theme: z.string().optional(),
});

export const createProfileRoutes = (
  db: any,
  authenticate: any,
  authorize: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/profile`, authenticate, asyncHandler(async (req, res) => {
    const user = await ProfileService.getProfile((req as any).user.id);
    res.json(user);
  }));

  router.put(`/profile`, authenticate, asyncHandler(async (req, res) => {
    const validation = profileSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Validation failed", validation.error.format());
    }
    await ProfileService.updateProfile((req as any).user.id, validation.data, (req as any).user.username);
    res.json({ success: true });
  }));

  router.put(`/preferences`, authenticate, asyncHandler(async (req, res) => {
    const validation = preferencesSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Validation failed", validation.error.format());
    }
    await ProfileService.updatePreferences((req as any).user.id, validation.data, (req as any).user.username);
    res.json({ success: true });
  }));

  return router;
};

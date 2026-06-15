import express from 'express';
import { z } from 'zod';
import { JobTitleService } from '../services/JobTitleService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const jobTitleSchema = z.object({
  name:         z.string().min(1).max(255),
  department:   z.string().min(1),
  job_level:    z.string().min(1),
  description:  z.string().optional().nullable(),
  reporting_to: z.string().uuid().optional().nullable().or(z.literal('')),
  status:       z.string().optional().nullable(),
});

export const createJobTitleRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/`, authenticate, asyncHandler(async (req, res) => {
    const data = await JobTitleService.getAll();
    res.json(data);
  }));

  router.post(`/`, authenticate, checkPermission('OrgStructure', 'Create'), asyncHandler(async (req, res) => {
    const validation = jobTitleSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid job title data", validation.error.format());
    }
    const result = await JobTitleService.create(validation.data, (req as any).user.username);
    res.json(result);
  }));

  router.put(`/:id`, authenticate, checkPermission('OrgStructure', 'Edit'), asyncHandler(async (req, res) => {
    const validation = jobTitleSchema.partial().safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid job title data", validation.error.format());
    }
    await JobTitleService.update(req.params.id as string, validation.data, (req as any).user.username);
    res.json({ success: true });
  }));

  router.delete(`/:id`, authenticate, checkPermission('OrgStructure', 'Delete'), asyncHandler(async (req, res) => {
    await JobTitleService.delete(req.params.id as string, (req as any).user.username);
    res.json({ success: true });
  }));

  return router;
};

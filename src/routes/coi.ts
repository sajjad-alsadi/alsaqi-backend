import express from 'express';
import { z } from 'zod';
import { CoiService } from '../services/CoiService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const coiCreateSchema = z.object({
  description: z.string().min(1).max(2000),
  related_party: z.string().min(1).max(255),
});

const coiUpdateSchema = z.object({
  status: z.enum(['Pending', 'Approved', 'Rejected', 'Closed']),
  reviewer_notes: z.string().optional().nullable(),
});

export const createCoiRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get('/coi', authenticate, asyncHandler(async (req, res) => {
    const records = await CoiService.getAll();
    res.json(records);
  }));

  router.post('/coi', authenticate, asyncHandler(async (req, res) => {
    const validation = coiCreateSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid COI data", validation.error.format());
    }
    const result = await CoiService.create((req as any).user.id as string, (req as any).user.username, validation.data);
    res.status(201).json(result);
  }));

  router.put('/coi/:id', authenticate, checkPermission('IntegrityManagement', 'Edit'), asyncHandler(async (req, res) => {
    const validation = coiUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid COI status update", validation.error.format());
    }
    await CoiService.updateStatus(req.params.id as string, validation.data, (req as any).user.username);
    res.json({ success: true });
  }));

  return router;
};

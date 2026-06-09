import express from 'express';
import { z } from 'zod';
import { PolicyService } from '../services/PolicyService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const policySchema = z.object({
  title: z.string().min(1).max(255),
  department: z.string().optional().nullable(),
  version: z.string().optional().nullable(),
  file_url: z.string().optional().nullable(),
  status: z.enum(['Active', 'Inactive', 'Draft', 'Archived']).optional(),
  content: z.string().optional().nullable(), // For system policies
});

export const createPoliciesRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get('/policies', authenticate, asyncHandler(async (req, res) => {
    const records = await PolicyService.getAll();
    res.json(records);
  }));

  router.get('/policies/:id', authenticate, asyncHandler(async (req, res) => {
    const record = await PolicyService.getById(req.params.id as string);
    res.json(record);
  }));

  router.get('/policies/:id/file', authenticate, asyncHandler(async (req, res) => {
    const record = await PolicyService.getFile(req.params.id as string);
    res.json(record);
  }));

  router.post('/policies', authenticate, checkPermission('Policies', 'Create'), asyncHandler(async (req, res) => {
    const validation = policySchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid policy data", validation.error.format());
    }
    const result = await PolicyService.create(validation.data, (req as any).user.username);
    res.status(201).json(result);
  }));

  router.put('/policies/:id', authenticate, checkPermission('Policies', 'Edit'), asyncHandler(async (req, res) => {
    const validation = policySchema.partial().safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid policy data", validation.error.format());
    }
    await PolicyService.update(req.params.id as string, validation.data, (req as any).user.username);
    res.json({ success: true });
  }));

  router.delete('/policies/:id', authenticate, checkPermission('Policies', 'Delete'), asyncHandler(async (req, res) => {
    await PolicyService.delete(req.params.id as string, (req as any).user.username);
    res.json({ success: true });
  }));

  return router;
};

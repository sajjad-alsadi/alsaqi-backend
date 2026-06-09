// src/server/routes/departments.ts
import express from 'express';
import { z } from 'zod';
import { DepartmentService } from '../services/DepartmentService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const departmentSchema = z.object({
  // Legacy field — maps to name_ar for backward compatibility
  name:              z.string().min(1).max(255).optional(),
  // Full fields
  entity_code:       z.string().min(1).max(50).optional(),
  name_ar:           z.string().min(1).max(255).optional(),
  name_en:           z.string().max(255).optional().nullable(),
  entity_type:       z.string().optional().nullable(),
  parent_id:         z.string().uuid().optional().nullable(),
  manager_name:      z.string().optional().nullable(),
  description:       z.string().optional().nullable(),
  location:          z.string().optional().nullable(),
  cost_center_code:  z.string().optional().nullable(),
  status:            z.enum(['Active', 'Inactive', 'Archived']).optional(),
}).refine(d => d.name_ar || d.name, {
  message: 'name_ar or name is required',
});

export const createDepartmentRoutes = (
  db: any, authenticate: any, checkPermission: any, logError: any
) => {
  const router = express.Router();

  // Flat list — used by all existing dropdowns
  router.get('/', authenticate, asyncHandler(async (_req, res) => {
    res.json(await DepartmentService.getAll());
  }));

  // Tree view — used by the new OrgStructure UI
  router.get('/tree', authenticate, asyncHandler(async (_req, res) => {
    res.json(await DepartmentService.getTree());
  }));

  router.post('/', authenticate, checkPermission('Departments', 'Create'), asyncHandler(async (req, res) => {
    const parsed = departmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.format());
    const d = parsed.data;
    // Support legacy {name} and full {name_ar, entity_code}
    const result = await DepartmentService.create({
      entity_code:      d.entity_code ?? `DEPT-${Date.now()}`,
      name_ar:          d.name_ar ?? d.name!,
      name_en:          d.name_en ?? undefined,
      entity_type:      d.entity_type ?? 'Department',
      parent_id:        d.parent_id ?? null,
      manager_name:     d.manager_name ?? undefined,
      description:      d.description ?? undefined,
      location:         d.location ?? undefined,
      cost_center_code: d.cost_center_code ?? undefined,
    }, (req as any).user.username);
    res.json(result);
  }));

  router.put('/:id', authenticate, checkPermission('Departments', 'Edit'), asyncHandler(async (req, res) => {
    const parsed = departmentSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.format());
    const d = parsed.data;
    const result = await DepartmentService.update(String(req.params.id), {
      name_ar:          d.name_ar ?? d.name,
      name_en:          d.name_en ?? undefined,
      entity_type:      d.entity_type ?? undefined,
      parent_id:        d.parent_id,
      manager_name:     d.manager_name ?? undefined,
      description:      d.description ?? undefined,
      location:         d.location ?? undefined,
      cost_center_code: d.cost_center_code ?? undefined,
      status:           d.status ?? undefined,
    }, (req as any).user.username);
    res.json(result);
  }));

  router.delete('/:id', authenticate, checkPermission('Departments', 'Delete'), asyncHandler(async (req, res) => {
    await DepartmentService.delete(String(req.params.id), (req as any).user.username);
    res.json({ success: true });
  }));

  return router;
};

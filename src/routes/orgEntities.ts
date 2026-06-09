import express from 'express';
import { z } from 'zod';
import { OrgService } from '../services/OrgService';
import { AuthService } from '../services/AuthService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const orgEntitySchema = z.object({
  entity_code: z.string().min(1).max(50),
  name_ar: z.string().min(1).max(255),
  name_en: z.string().optional().nullable(),
  parent_id: z.string().uuid().optional().nullable(),
  entity_type: z.string().optional().nullable(),
  is_active: z.coerce.number().optional().default(1),
});

export const createOrgEntitiesRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get("/org-entities", authenticate, asyncHandler(async (req, res) => {
    const entities = await OrgService.getOrgEntities();
    res.json(entities);
  }));

  router.post("/org-entities", authenticate, checkPermission('OrgStructure', 'Create'), asyncHandler(async (req, res) => {
    const validation = orgEntitySchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid org entity data", validation.error.format());
    }
    const lastInsertRowid = await OrgService.createOrgEntity(validation.data);

    await AuthService.logAudit((req as any).user.username, "Create Org Entity", "Org Structure", `Created entity: ${req.body.name_ar} (${req.body.entity_code})`);

    res.json({ id: lastInsertRowid });
  }));

  router.put("/org-entities/:id", authenticate, checkPermission('OrgStructure', 'Edit'), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const validation = orgEntitySchema.partial().safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid org entity data", validation.error.format());
    }
    await OrgService.updateOrgEntity(id, validation.data);

    await AuthService.logAudit((req as any).user.username, "Update Org Entity", "Org Structure", `Updated entity ID: ${id}`);

    res.json({ success: true });
  }));

  router.delete("/org-entities/:id", authenticate, checkPermission('OrgStructure', 'Delete'), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    await OrgService.deleteOrgEntity(id);
    
    await AuthService.logAudit((req as any).user.username, "Delete Org Entity", "Org Structure", `Deleted entity ID: ${id}`);
    
    res.json({ success: true });
  }));

  return router;
};

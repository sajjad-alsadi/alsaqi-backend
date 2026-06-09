import express from 'express';
import { z } from 'zod';
import { RoleService } from '../services/RoleService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';
import { invalidateUserCache, clearPermissionCache } from '../middleware/auth';

const updatePermissionsSchema = z.object({
  permissionIds: z.array(z.string().min(1))
});

export const createRoleRoutes = (
  db: any,
  authenticate: any,
  authorize: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/roles`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const rolesWithPermissions = await RoleService.getAllRoles();
    res.json(rolesWithPermissions);
  }));

  router.get(`/roles/:id/permissions`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const perms = await RoleService.getRolePermissions(req.params.id as string);
    res.json(perms);
  }));

  router.post(`/roles/:id/permissions`, authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const validation = updatePermissionsSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid permissions data", validation.error.format());
    }
    const { permissionIds } = validation.data;
    await RoleService.updateRolePermissions(req.params.id as string, permissionIds);
    clearPermissionCache();
    res.json({ success: true });
  }));

  router.get(`/permissions`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const perms = await RoleService.getAllPermissions();
    res.json(perms);
  }));

  return router;
};

import express from 'express';
import { RoleService } from '../services/RoleService';
import { asyncHandler } from '../utils/asyncHandler';

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

  router.get(`/permissions`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const perms = await RoleService.getAllPermissions();
    res.json(perms);
  }));

  return router;
};

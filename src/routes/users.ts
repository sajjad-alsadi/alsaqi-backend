import express from 'express';
import { z } from 'zod';
import { UserService } from '../services/UserService';
import { AuthService } from '../services/AuthService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError, NotFoundError } from '../utils/errors';
import { validateSchema, validateIdParam } from '../middleware/validate';
import { invalidateUserCache } from '../middleware/auth';
import { UserRole, AccessScope } from '@alsaqi/shared';
import { DEFAULT_PASSWORD_MIN_LENGTH } from '../services/passwordPolicy';
import { createSuccessResponse, createErrorResponse, computePagination } from '../utils/responseEnvelope.js';
import { lastAdminGuard } from '../middleware/lastAdminGuard.js';

const userSchema = z.object({
  username: z.string().min(3).max(50).optional(),
  password: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100).optional(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  department: z.string().optional().nullable(),
  job_title_id: z.string().optional().nullable(),
  // Constrain role to the schema role enum so an out-of-enum value is rejected with HTTP 400
  // before reaching the DB layer, instead of surfacing a raw constraint violation (Req 2.3).
  role: z.nativeEnum(UserRole),
  unit: z.string().optional().nullable(),
  reporting_manager_id: z.string().optional().nullable(),
  // Constrain access_scope to the schema-permitted values ('Global','Department','Unit'),
  // while still allowing it to be omitted or null (Req 2.3).
  access_scope: z.nativeEnum(AccessScope).optional().nullable(),
  phone_number: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.string().optional()
});

export const createUserRoutes = (
  db: any,
  authenticate: any,
  authorize: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/init`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const data = await UserService.getInitData();
    res.json(createSuccessResponse({ data }));
  }));

  router.get(`/`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const result = await UserService.getUsers(req.query);
    res.json(createSuccessResponse({
      data: result.data,
      pagination: computePagination({ page, pageSize, total: result.total }),
    }));
  }));

  router.get(`/summary`, authenticate, checkPermission('UserManagement', 'View'), asyncHandler(async (req, res) => {
    const summary = await UserService.getUserSummary();
    res.json(createSuccessResponse({ data: summary }));
  }));

  router.get(`/list`, authenticate, asyncHandler(async (req, res) => {
    const data = await UserService.getActiveUsers();
    res.json(createSuccessResponse({ data }));
  }));

  router.get(`/:id`, authenticate, checkPermission('UserManagement', 'View'), validateIdParam(), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const user = await UserService.getUserById(id);
    if (!user) throw new NotFoundError("User not found");
    res.json(createSuccessResponse({ data: user }));
  }));

  router.post(`/`, authenticate, checkPermission('UserManagement', 'Create'), validateSchema(userSchema), asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      throw new ValidationError("Username and password are required for new users");
    }

    const user = await UserService.createUser(req.body);
    
    await AuthService.logAudit((req as any).user.username, "Created User", "User Management", `Created user ${user.username} with role ${user.role}`);
      
    res.json(createSuccessResponse({ data: user }));
  }));

  router.put(`/:id`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), validateSchema(userSchema), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    
    const { oldUser } = await UserService.updateUser(id, req.body);
    const { role, status, access_scope } = req.body;
    
    // Log critical changes
    if (oldUser.role !== role || oldUser.status !== status || oldUser.access_scope !== access_scope) {
      await UserService.logPermissionChange(id, (req as any).user.id, oldUser.role, role || oldUser.role, "Profile update");
      
      // Notify the affected user about permission change
      try {
        const { NotificationService } = await import('../services/NotificationService');
        const actorName = (req as any).user.name || (req as any).user.username;
        let changeDesc = '';
        if (oldUser.role !== role) changeDesc += `Role: ${oldUser.role} → ${role}. `;
        if (oldUser.status !== status) changeDesc += `Status: ${oldUser.status} → ${status}. `;
        if (oldUser.access_scope !== access_scope) changeDesc += `Access scope changed. `;
        
        await NotificationService.create(
          id,
          'permission_changed',
          JSON.stringify({ key: 'notifications.permissionsChanged', params: { actor: actorName, details: changeDesc } }),
          'Security',
          '/settings',
          {
            actorId: (req as any).user.id,
            entityId: id,
            entityType: 'user',
            title: JSON.stringify({ key: 'notifications.permissionsChanged' }),
            wss: (req.app as any).wss,
            data: { old_role: oldUser.role, new_role: role, old_status: oldUser.status, new_status: status }
          }
        );
      } catch (e) {
        console.error("[Users] Permission change notification failed:", e);
      }
    }

    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Updated User", "User Management", `Updated user ID ${id}`);
      
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  router.post(`/:id/suspend`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), lastAdminGuard(db) as any, asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const currentStatus = await UserService.getStatus(id);
    const newStatus = currentStatus === 'Suspended' ? 'Active' : 'Suspended';
    const username = await UserService.setStatus(id, newStatus);
    
    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, `${newStatus === 'Suspended' ? 'Suspended' : 'Activated'} User`, "User Management", `Changed status for user ${username} to ${newStatus}`);
      
    res.json(createSuccessResponse({ data: { success: true, status: newStatus } }));
  }));

  router.post(`/:id/archive`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), lastAdminGuard(db) as any, asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const username = await UserService.setStatus(id, 'Archived');
    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Archive", "User Management", `Archived user: ${username}`);
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  router.post(`/:id/activate`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const username = await UserService.activateUser(id);
    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Activate", "User Management", `Activated user: ${username}`);
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  router.delete(`/:id`, authenticate, checkPermission('UserManagement', 'Delete'), validateIdParam(), lastAdminGuard(db) as any, asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const username = await UserService.deleteUser(id);
    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Deleted User", "User Management", `Deleted user ${username}`);
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  router.post(`/:id/unlock`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const username = await UserService.unlockUser(id);
    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Unlocked User", "User Management", `Unlocked user ${username} and reset failed attempts`);
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  const resetPasswordSchema = z.object({
    newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100)
  });

  router.post(`/:id/reset-password`, authenticate, checkPermission('UserManagement', 'Edit'), validateIdParam(), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const validation = resetPasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid password data", validation.error.format());
    }
    const { newPassword } = validation.data;
    const username = await UserService.resetPassword(id, newPassword);

    await invalidateUserCache(id);
    await AuthService.logAudit((req as any).user.username, "Reset Password", "User Management", `Reset password for user ${username}`);
      
    res.json(createSuccessResponse({ data: { success: true } }));
  }));

  return router;
};

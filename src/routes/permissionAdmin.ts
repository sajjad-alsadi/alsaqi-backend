import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { ModuleRegistry } from '../permissions/registry';
import { PermissionService } from '../services/PermissionService';
import { PermissionAuditService } from '../services/PermissionAuditService';
import { PermissionAction, PermissionUpdate } from '../permissions/types';
import { permissionAdminRateLimiter } from '../middleware/permissionAdminRateLimiter';

/**
 * Permission Admin API - Role Management, Permission Matrix, User Override & Audit Log Endpoints
 *
 * Role management:
 * - GET /roles - list all roles (built-in + custom)
 * - POST /roles - create custom role
 * - PUT /roles/:id - update custom role name/description
 * - DELETE /roles/:id - delete custom role (if no users assigned)
 *
 * Permission matrix:
 * - GET /roles/:id/permissions - return complete permission matrix for a role
 * - POST /roles/:id/permissions - update custom role permissions
 * - GET /permissions/modules - return all registered modules with metadata
 * - GET /permissions/me - return authenticated user's effective permissions
 *
 * User-level overrides:
 * - GET /users/:id/permissions - return user's permission overrides
 * - PUT /users/:id/permissions - replace all overrides for user
 *
 * Audit logs:
 * - GET /audit-logs/permissions - paginated, filterable audit log entries
 *
 * Requirements: 7.1-7.11, 8.1-8.7, 9.1-9.6, 12.1-12.6
 */

// ─── Validation Schemas ────────────────────────────────────────────────────

const createRoleSchema = z.object({
  name: z
    .string()
    .min(2, 'Role name must be at least 2 characters')
    .max(100, 'Role name must not exceed 100 characters'),
  description: z
    .string()
    .max(500, 'Role description must not exceed 500 characters')
    .optional()
    .default(''),
});

const updateRoleSchema = z.object({
  name: z
    .string()
    .min(2, 'Role name must be at least 2 characters')
    .max(100, 'Role name must not exceed 100 characters')
    .optional(),
  description: z
    .string()
    .max(500, 'Role description must not exceed 500 characters')
    .optional(),
});

const permissionUpdateSchema = z.object({
  permissions: z.array(
    z.object({
      module: z.string().min(1, 'Module name is required'),
      action: z.string().min(1, 'Action is required'),
      granted: z.boolean(),
    })
  ),
});

const userPermissionOverrideSchema = z.object({
  overrides: z.array(
    z.object({
      module: z.string().min(1, 'Module name is required'),
      action: z.string().min(1, 'Action is required'),
      isAllowed: z.boolean(),
    })
  ),
});

// ─── Route Factory ─────────────────────────────────────────────────────────

export const createPermissionAdminRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  // Apply rate limiting to all permission admin endpoints (Req 13.4, 13.5)
  // 100 requests per 15-minute sliding window per authenticated user
  router.use(permissionAdminRateLimiter);

  // ═══════════════════════════════════════════════════════════════════════════
  // ROLE MANAGEMENT ENDPOINTS (Req 7.1-7.11)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /roles - List all roles ───────────────────────────────────────

  router.get(
    '/roles',
    authenticate,
    checkPermission('UserManagement', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const roles = await db
        .prepare(
          `SELECT id, name, description, is_custom, created_at
           FROM roles
           ORDER BY is_custom ASC, name ASC`
        )
        .all();

      const result = roles.map((role: any) => ({
        id: role.id,
        name: role.name,
        description: role.description || '',
        isCustom: role.is_custom === true || role.is_custom === 1,
        createdAt: role.created_at,
      }));

      res.json(result);
    })
  );

  // ─── POST /roles - Create custom role ──────────────────────────────────

  router.post(
    '/roles',
    authenticate,
    checkPermission('UserManagement', 'Create'),
    asyncHandler(async (req: any, res: any) => {
      const validation = createRoleSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: validation.error.flatten().fieldErrors,
        });
      }

      const { name, description } = validation.data;

      // Check for case-insensitive name conflict
      const existing = await db
        .prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)')
        .get(name);

      if (existing) {
        return res.status(409).json({
          error: `A role with the name '${name}' already exists`,
          code: 'CONFLICT',
        });
      }

      // Insert the new custom role and log audit entry in a transaction (Req 12.3, 12.6)
      let result: any;

      try {
        await db.transaction(async () => {
          result = await db
            .prepare(
              `INSERT INTO roles (name, description, is_custom, created_at, updated_at)
               VALUES (?, ?, true, NOW(), NOW())
               RETURNING id, name, description, is_custom, created_at`
            )
            .get(name, description);

          // Audit log: custom role created (Req 12.3)
          await PermissionAuditService.logPermissionChange({
            eventType: 'custom_role_created',
            actorUserId: req.user.id,
            targetRoleId: result.id,
            oldState: null,
            newState: { name, description },
          });
        });
      } catch (err: any) {
        // If audit log write fails, the transaction rolls back (Req 12.6)
        logError?.(err);
        return res.status(500).json({
          error: 'Operation could not be completed due to audit logging failure',
          code: 'INTERNAL_ERROR',
        });
      }

      res.status(201).json({
        id: result.id,
        name: result.name,
        description: result.description || '',
        isCustom: true,
        createdAt: result.created_at,
      });
    })
  );

  // ─── PUT /roles/:id - Update custom role ───────────────────────────────

  router.put(
    '/roles/:id',
    authenticate,
    checkPermission('UserManagement', 'Edit'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if role exists
      const role = await db
        .prepare('SELECT id, name, description, is_custom, created_at FROM roles WHERE id = ?')
        .get(id);

      if (!role) {
        return res.status(404).json({
          error: 'Role not found',
          code: 'NOT_FOUND',
        });
      }

      // Reject modification of built-in roles
      if (!(role.is_custom === true || role.is_custom === 1)) {
        return res.status(403).json({
          error: 'Built-in roles cannot be modified',
          code: 'FORBIDDEN',
        });
      }

      const validation = updateRoleSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: validation.error.flatten().fieldErrors,
        });
      }

      const { name, description } = validation.data;

      // If name is being changed, check for case-insensitive conflict
      if (name !== undefined) {
        const existing = await db
          .prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?')
          .get(name, id);

        if (existing) {
          return res.status(409).json({
            error: `A role with the name '${name}' already exists`,
            code: 'CONFLICT',
          });
        }
      }

      // Build update query dynamically
      const updates: string[] = [];
      const params: any[] = [];

      if (name !== undefined) {
        updates.push('name = ?');
        params.push(name);
      }
      if (description !== undefined) {
        updates.push('description = ?');
        params.push(description);
      }

      if (updates.length === 0) {
        // Nothing to update, return current state
        return res.json({
          id: role.id,
          name: role.name,
          description: role.description || '',
          isCustom: true,
          createdAt: role.created_at,
        });
      }

      updates.push('updated_at = NOW()');
      params.push(id);

      const updated = await db
        .prepare(
          `UPDATE roles SET ${updates.join(', ')} WHERE id = ?
           RETURNING id, name, description, is_custom, created_at`
        )
        .get(...params);

      res.json({
        id: updated.id,
        name: updated.name,
        description: updated.description || '',
        isCustom: true,
        createdAt: updated.created_at,
      });
    })
  );

  // ─── DELETE /roles/:id - Delete custom role ────────────────────────────

  router.delete(
    '/roles/:id',
    authenticate,
    checkPermission('UserManagement', 'Delete'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if role exists
      const role = await db
        .prepare('SELECT id, name, description, is_custom FROM roles WHERE id = ?')
        .get(id);

      if (!role) {
        return res.status(404).json({
          error: 'Role not found',
          code: 'NOT_FOUND',
        });
      }

      // Reject deletion of built-in roles
      if (!(role.is_custom === true || role.is_custom === 1)) {
        return res.status(403).json({
          error: 'Built-in roles cannot be deleted',
          code: 'FORBIDDEN',
        });
      }

      // Check if any users are assigned to this role (fetch up to 101 to detect overflow)
      const assignedUsers = await db
        .prepare('SELECT id FROM users WHERE role_id = ? LIMIT 101')
        .all(id);

      if (assignedUsers.length > 0) {
        const userIds = assignedUsers.slice(0, 100).map((u: any) => u.id);
        return res.status(409).json({
          error: 'Cannot delete role with assigned users',
          code: 'CONFLICT',
          affectedUserIds: userIds,
          totalAffected: assignedUsers.length > 100 ? assignedUsers.length - 1 : assignedUsers.length,
        });
      }

      // Delete role and log audit entry in a transaction (Req 12.3, 12.6)
      try {
        await db.transaction(async () => {
          await db
            .prepare('DELETE FROM role_permissions WHERE role_id = ?::uuid')
            .run(id);
          await db
            .prepare('DELETE FROM roles WHERE id = ?::uuid')
            .run(id);

          // Audit log: custom role deleted (Req 12.3)
          await PermissionAuditService.logPermissionChange({
            eventType: 'custom_role_deleted',
            actorUserId: req.user.id,
            targetRoleId: id,
            oldState: { name: role.name, description: role.description || '' },
            newState: null,
          });
        });
      } catch (err: any) {
        logError?.(err);
        return res.status(500).json({
          error: 'Operation could not be completed due to audit logging failure',
          code: 'INTERNAL_ERROR',
        });
      }

      res.status(200).json({
        message: 'Role deleted successfully',
        id: role.id,
        name: role.name,
      });
    })
  );


  // ═══════════════════════════════════════════════════════════════════════════
  // PERMISSION MATRIX ENDPOINTS (Req 8.1-8.7)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /roles/:id/permissions - Get role's complete permission matrix ─

  router.get(
    '/roles/:id/permissions',
    authenticate,
    checkPermission('UserManagement', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if role exists (Req 8.6)
      const role = await db
        .prepare('SELECT id, name, is_custom FROM roles WHERE id = ?')
        .get(id);

      if (!role) {
        return res.status(404).json({
          error: 'Role not found',
          code: 'NOT_FOUND',
        });
      }

      // Get the role's permission matrix via PermissionService (Req 8.1)
      const rolePermissions = await PermissionService.getRolePermissions(id);

      // Build complete matrix with ALL registered modules and boolean per action
      const allModules = ModuleRegistry.getAllModules();
      const matrix: Record<string, Record<string, boolean>> = {};

      for (const moduleDef of allModules) {
        const grantedActions = rolePermissions.permissions[moduleDef.name] || [];
        const moduleMatrix: Record<string, boolean> = {};

        for (const action of moduleDef.actions) {
          moduleMatrix[action] = grantedActions.includes(action);
        }

        matrix[moduleDef.name] = moduleMatrix;
      }

      res.json({
        roleId: id,
        roleName: role.name,
        isCustom: role.is_custom === true || role.is_custom === 1,
        permissions: matrix,
      });
    })
  );

  // ─── POST /roles/:id/permissions - Update role's permission matrix ─────

  router.post(
    '/roles/:id/permissions',
    authenticate,
    checkPermission('UserManagement', 'Edit'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if role exists (Req 8.6)
      const role = await db
        .prepare('SELECT id, name, is_custom FROM roles WHERE id = ?')
        .get(id);

      if (!role) {
        return res.status(404).json({
          error: 'Role not found',
          code: 'NOT_FOUND',
        });
      }

      // Reject modification of built-in roles (Req 8.3)
      if (!(role.is_custom === true || role.is_custom === 1)) {
        return res.status(403).json({
          error: 'Built-in role permissions cannot be modified',
          code: 'FORBIDDEN',
        });
      }

      // Validate request body
      const validation = permissionUpdateSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: validation.error.flatten().fieldErrors,
        });
      }

      const { permissions } = validation.data;

      // Validate each permission update against ModuleRegistry (Req 8.7)
      for (const perm of permissions) {
        const moduleDef = ModuleRegistry.getModule(perm.module);
        if (!moduleDef) {
          return res.status(400).json({
            error: `Invalid module: '${perm.module}' is not registered in the system`,
            code: 'VALIDATION_ERROR',
            module: perm.module,
          });
        }

        if (!moduleDef.actions.includes(perm.action as PermissionAction)) {
          return res.status(400).json({
            error: `Invalid action: '${perm.action}' is not supported by module '${perm.module}'. Supported actions: ${moduleDef.actions.join(', ')}`,
            code: 'VALIDATION_ERROR',
            module: perm.module,
            action: perm.action,
          });
        }
      }

      // Capture old state for audit log (Req 12.1)
      const oldRolePermissions = await PermissionService.getRolePermissions(id);
      const oldMatrix = oldRolePermissions.permissions;

      // Update role permissions via PermissionService (Req 8.2)
      // This also invalidates cache for all users with this role
      await PermissionService.updateRolePermissions(
        id,
        permissions as PermissionUpdate[]
      );

      // Build new state for audit log
      const newPermissions: Record<string, string[]> = {};
      for (const [mod, actions] of Object.entries(oldMatrix)) {
        newPermissions[mod] = [...actions];
      }
      for (const perm of permissions) {
        if (!newPermissions[perm.module]) {
          newPermissions[perm.module] = [];
        }
        if (perm.granted) {
          if (!newPermissions[perm.module].includes(perm.action)) {
            newPermissions[perm.module].push(perm.action);
          }
        } else {
          newPermissions[perm.module] = newPermissions[perm.module].filter(
            (a) => a !== perm.action
          );
        }
      }

      // Audit log: role permission change (Req 12.1, 12.6)
      // If audit log write fails, roll back the permission change
      try {
        await PermissionAuditService.logPermissionChange({
          eventType: 'role_permission_change',
          actorUserId: req.user.id,
          targetRoleId: id,
          oldState: oldMatrix,
          newState: newPermissions,
        });
      } catch (auditErr: any) {
        // Roll back: restore old permissions (Req 12.6)
        try {
          const rollbackPermissions: PermissionUpdate[] = permissions.map((p) => ({
            module: p.module,
            action: p.action as PermissionAction,
            granted: !p.granted, // reverse the change
          }));
          await PermissionService.updateRolePermissions(id, rollbackPermissions);
        } catch (rollbackErr: any) {
          logError?.(rollbackErr);
        }
        logError?.(auditErr);
        return res.status(500).json({
          error: 'Operation could not be completed due to audit logging failure',
          code: 'INTERNAL_ERROR',
        });
      }

      res.json({
        message: 'Role permissions updated successfully',
        roleId: id,
        roleName: role.name,
        updatedCount: permissions.length,
      });
    })
  );

  // ─── GET /permissions/modules - Get all registered modules ─────────────

  router.get(
    '/permissions/modules',
    authenticate,
    checkPermission('UserManagement', 'View'),
    asyncHandler(async (req: any, res: any) => {
      // Return all registered modules with metadata (Req 8.4)
      const allModules = ModuleRegistry.getAllModules();

      const result = allModules.map((mod) => ({
        name: mod.name,
        label: mod.label,
        actions: mod.actions,
      }));

      res.json(result);
    })
  );

  // ─── GET /permissions/me - Get current user's effective permissions ────

  router.get(
    '/permissions/me',
    authenticate,
    asyncHandler(async (req: any, res: any) => {
      // Return authenticated user's effective permissions (Req 8.5)
      const userId = req.user.id;
      const userPermissions = await PermissionService.getUserPermissions(userId);

      res.json({
        userId: userPermissions.userId,
        role: userPermissions.role,
        roleId: userPermissions.roleId,
        isCustomRole: userPermissions.isCustomRole,
        permissions: userPermissions.permissions,
        overrides: userPermissions.overrides,
      });
    })
  );


  // ═══════════════════════════════════════════════════════════════════════════
  // USER-LEVEL PERMISSION OVERRIDE ENDPOINTS (Req 9.1-9.6)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /users/:id/permissions - Get user permission overrides ────────

  router.get(
    '/users/:id/permissions',
    authenticate,
    checkPermission('UserManagement', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if user exists (Req 9.4)
      const user = await db
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(id);

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      // Get all user permission overrides (Req 9.1)
      const overrides = await db
        .prepare(
          `SELECT p.module, p.action, up.is_allowed
           FROM user_permissions up
           JOIN permissions p ON up.permission_id = p.id
           WHERE up.user_id = ?`
        )
        .all(id);

      const result = overrides.map((o: any) => ({
        module: o.module,
        action: o.action,
        isAllowed: o.is_allowed === 1 || o.is_allowed === true,
      }));

      res.json(result);
    })
  );

  // ─── PUT /users/:id/permissions - Replace all user permission overrides ─

  router.put(
    '/users/:id/permissions',
    authenticate,
    checkPermission('UserManagement', 'Edit'),
    asyncHandler(async (req: any, res: any) => {
      const { id } = req.params;

      // Check if user exists (Req 9.4)
      const user = await db
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(id);

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          code: 'NOT_FOUND',
        });
      }

      // Validate request body
      const validation = userPermissionOverrideSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: validation.error.flatten().fieldErrors,
        });
      }

      const { overrides } = validation.data;

      // Validate each override against ModuleRegistry (Req 9.5, 9.3)
      for (const override of overrides) {
        const moduleDef = ModuleRegistry.getModule(override.module);
        if (!moduleDef) {
          return res.status(400).json({
            error: `Unrecognized module: '${override.module}'`,
            code: 'VALIDATION_ERROR',
            module: override.module,
          });
        }

        if (!moduleDef.actions.includes(override.action as PermissionAction)) {
          return res.status(400).json({
            error: `Action '${override.action}' is not supported by module '${override.module}'. Supported actions: ${moduleDef.actions.join(', ')}`,
            code: 'VALIDATION_ERROR',
            module: override.module,
            action: override.action,
          });
        }
      }

      // Capture old state for audit log (Req 12.2)
      const oldOverrides = await db
        .prepare(
          `SELECT p.module, p.action, up.is_allowed
           FROM user_permissions up
           JOIN permissions p ON up.permission_id = p.id
           WHERE up.user_id = ?`
        )
        .all(id);

      const oldState = oldOverrides.map((o: any) => ({
        module: o.module,
        action: o.action,
        isAllowed: o.is_allowed === 1 || o.is_allowed === true,
      }));

      // Replace all overrides and log audit entry in a transaction (Req 9.2, 9.6, 12.2, 12.6)
      try {
        await db.transaction(async () => {
          // Delete all existing overrides for this user
          await db
            .prepare('DELETE FROM user_permissions WHERE user_id = ?::uuid')
            .run(id);

          // Insert new overrides (empty array = remove all, which is valid per Req 9.6)
          for (const override of overrides) {
            const permRecord = await db
              .prepare('SELECT id FROM permissions WHERE module = ? AND action = ?')
              .get(override.module, override.action);

            if (permRecord) {
              const isAllowed = override.isAllowed ? 1 : 0;
              await db
                .prepare(
                  'INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES (?::uuid, ?::uuid, ?)'
                )
                .run(id, permRecord.id, isAllowed);
            }
          }

          // Audit log: user override change (Req 12.2)
          await PermissionAuditService.logPermissionChange({
            eventType: 'user_override_change',
            actorUserId: req.user.id,
            targetUserId: id,
            oldState: oldState,
            newState: overrides,
          });
        });
      } catch (err: any) {
        logError?.(err);
        return res.status(500).json({
          error: 'Operation could not be completed due to audit logging failure',
          code: 'INTERNAL_ERROR',
        });
      }

      // Invalidate cache for this user (Req 9.2)
      PermissionService.invalidateCache(id);

      res.json({
        message: 'User permission overrides updated successfully',
        userId: id,
        overridesCount: overrides.length,
      });
    })
  );


  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIT LOG ENDPOINTS (Req 12.4, 12.5)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /audit-logs/permissions - Get paginated, filterable audit logs ─

  router.get(
    '/audit-logs/permissions',
    authenticate,
    checkPermission('UserManagement', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const {
        actorUserId,
        targetRoleId,
        targetUserId,
        eventType,
        startDate,
        endDate,
        page,
        limit,
      } = req.query;

      // Validate eventType if provided
      const validEventTypes = [
        'role_permission_change',
        'user_override_change',
        'custom_role_created',
        'custom_role_deleted',
      ];
      if (eventType && !validEventTypes.includes(eventType)) {
        return res.status(400).json({
          error: `Invalid event type: '${eventType}'. Valid types: ${validEventTypes.join(', ')}`,
          code: 'VALIDATION_ERROR',
        });
      }

      // Validate date formats if provided
      if (startDate && isNaN(Date.parse(startDate))) {
        return res.status(400).json({
          error: 'Invalid startDate format. Use ISO 8601 format.',
          code: 'VALIDATION_ERROR',
        });
      }
      if (endDate && isNaN(Date.parse(endDate))) {
        return res.status(400).json({
          error: 'Invalid endDate format. Use ISO 8601 format.',
          code: 'VALIDATION_ERROR',
        });
      }

      const result = await PermissionAuditService.getAuditLogs({
        actorUserId,
        targetRoleId,
        targetUserId,
        eventType,
        startDate,
        endDate,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      res.json(result);
    })
  );

  return router;
};

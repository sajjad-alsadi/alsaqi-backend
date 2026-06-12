/**
 * User management validation schemas.
 * Used by both API (request validation / response assertions) and Frontend.
 *
 * Authored against the live response shapes of the user-management endpoints
 * (FIX-BE-5, Requirement 5.4):
 *   - GET  /users/summary              -> `UserService.getUserSummary`
 *   - GET  /user-management-settings   -> `SettingsService.getUserManagementSettings`
 *   - PUT  /user-management-settings   -> request body (mirror of settings route)
 *   - GET  /login-history              -> `LogService.getLoginHistory`
 *   - GET  /audit-trail                -> `LogService.getAuditTrail`
 *   - GET  /permissions                -> `RoleService.getAllPermissions`
 *   - GET  /roles/:id/permissions      -> permission-matrix read (permissionAdmin.ts)
 *   - POST /roles/:id/permissions      -> permission-matrix update (permissionAdmin.ts)
 *   - GET  /users/init                 -> `UserService.getInitData`
 *
 * Read-heavy endpoints expose RESPONSE-validation schemas (used to assert a
 * live HTTP 200 body conforms to the documented contract, Requirements 5.7/5.8).
 * Write endpoints expose REQUEST-body schemas plus their inferred input types.
 *
 * Response schemas that wrap raw database rows use `.passthrough()` so that
 * additional server-managed columns do not cause false validation failures
 * while the documented fields are still enforced.
 */
import { z } from 'zod';

// ─── Shared pagination envelope ───────────────────────────────────────────────

export const PaginationSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

/** Build a paginated response schema for a given item schema. */
const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    pagination: PaginationSchema,
  });

// ─── GET /users/summary ───────────────────────────────────────────────────────

/** Response shape of `UserService.getUserSummary` (aggregate counts). */
export const UserSummaryResponseSchema = z.object({
  total: z.number(),
  active: z.number(),
  suspended: z.number(),
  archived: z.number(),
  admins: z.number(),
  inactive: z.number(),
});

export type UserSummaryResponse = z.infer<typeof UserSummaryResponseSchema>;

// ─── /user-management-settings ─────────────────────────────────────────────────

/**
 * Response shape of `SettingsService.getUserManagementSettings`.
 * Documented fields are validated; server-managed extras pass through.
 */
export const UserManagementSettingsResponseSchema = z
  .object({
    failed_login_threshold: z.number().optional(),
    inactive_account_threshold_days: z.number().optional(),
    password_min_length: z.number().optional(),
    password_require_uppercase: z.number().optional(),
    password_require_lowercase: z.number().optional(),
    password_require_numbers: z.number().optional(),
    password_require_symbols: z.number().optional(),
    password_expiry_days: z.number().optional(),
    enforce_single_session: z.number().optional(),
    session_timeout_minutes: z.number().optional(),
  })
  .passthrough();

export type UserManagementSettingsResponse = z.infer<
  typeof UserManagementSettingsResponseSchema
>;

/**
 * Request body schema for `PUT /user-management-settings`.
 * Mirrors the validation performed in `src/routes/settings.ts`.
 */
export const UpdateUserManagementSettingsSchema = z.object({
  failed_login_threshold: z.coerce.number().int().min(1).max(20).optional(),
  inactive_account_threshold_days: z.coerce.number().int().min(1).max(365).optional(),
  password_min_length: z.coerce.number().int().min(6).max(32).optional(),
  session_timeout_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  password_require_uppercase: z.coerce.number().int().min(0).max(1).optional(),
  password_require_lowercase: z.coerce.number().int().min(0).max(1).optional(),
  password_require_numbers: z.coerce.number().int().min(0).max(1).optional(),
  password_require_symbols: z.coerce.number().int().min(0).max(1).optional(),
  password_expiry_days: z.coerce.number().int().min(0).max(365).optional(),
  enforce_single_session: z.coerce.number().int().min(0).max(1).optional(),
  two_factor_auth: z.coerce.number().int().min(0).max(1).optional(),
});

export type UpdateUserManagementSettingsInput = z.infer<
  typeof UpdateUserManagementSettingsSchema
>;

// ─── GET /login-history ─────────────────────────────────────────────────────────

/** A single login-history row from `LogService.getLoginHistory`. */
export const LoginHistoryEntrySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    user_id: z.union([z.string(), z.number()]).nullable(),
    login_time: z.string(),
    ip_address: z.string().nullable().optional(),
    user_agent: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    user_name: z.string().nullable().optional(),
  })
  .passthrough();

export type LoginHistoryEntry = z.infer<typeof LoginHistoryEntrySchema>;

export const LoginHistoryResponseSchema = paginated(LoginHistoryEntrySchema);
export type LoginHistoryResponse = z.infer<typeof LoginHistoryResponseSchema>;

// ─── GET /audit-trail ───────────────────────────────────────────────────────────

/** A single audit-trail row from `LogService.getAuditTrail`. */
export const AuditTrailEntrySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    user: z.string().nullable(),
    action: z.string(),
    module: z.string(),
    details: z.string().nullable().optional(),
    timestamp: z.string(),
  })
  .passthrough();

export type AuditTrailEntry = z.infer<typeof AuditTrailEntrySchema>;

export const AuditTrailResponseSchema = paginated(AuditTrailEntrySchema);
export type AuditTrailResponse = z.infer<typeof AuditTrailResponseSchema>;

// ─── GET /permissions ───────────────────────────────────────────────────────────

/** A single permission row from `RoleService.getAllPermissions`. */
export const PermissionSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    module: z.string(),
    action: z.string(),
  })
  .passthrough();

export type Permission = z.infer<typeof PermissionSchema>;

/** Response of `GET /permissions` (a flat array of permissions). */
export const PermissionsResponseSchema = z.array(PermissionSchema);
export type PermissionsResponse = z.infer<typeof PermissionsResponseSchema>;

// ─── GET /roles/:id/permissions (matrix read) ────────────────────────────────────

/** Per-module action grant map, e.g. `{ View: true, Edit: false }`. */
export const PermissionMatrixSchema = z.record(z.string(), z.record(z.string(), z.boolean()));

/** Response of `GET /roles/:id/permissions`. */
export const RolePermissionMatrixResponseSchema = z.object({
  roleId: z.union([z.string(), z.number()]),
  roleName: z.string(),
  isCustom: z.boolean(),
  permissions: PermissionMatrixSchema,
});

export type RolePermissionMatrixResponse = z.infer<
  typeof RolePermissionMatrixResponseSchema
>;

// ─── POST /roles/:id/permissions (matrix update) ─────────────────────────────────

/**
 * Request body schema for `POST /roles/:id/permissions`.
 * Mirrors the `permissionUpdateSchema` enforced in `src/routes/permissionAdmin.ts`.
 */
export const UpdateRolePermissionsSchema = z.object({
  permissions: z.array(
    z.object({
      module: z.string().min(1, 'Module name is required'),
      action: z.string().min(1, 'Action is required'),
      granted: z.boolean(),
    })
  ),
});

export type UpdateRolePermissionsInput = z.infer<typeof UpdateRolePermissionsSchema>;

/** Response of a successful `POST /roles/:id/permissions` update. */
export const RolePermissionUpdateResultSchema = z.object({
  message: z.string(),
  roleId: z.union([z.string(), z.number()]),
  roleName: z.string(),
  updatedCount: z.number(),
});

export type RolePermissionUpdateResult = z.infer<
  typeof RolePermissionUpdateResultSchema
>;

// ─── GET /users/init (composite bootstrap payload) ───────────────────────────────

/** A role with its resolved permission list, as embedded in the init payload. */
export const RoleWithPermissionsSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    permissions: z.array(PermissionSchema),
  })
  .passthrough();

/**
 * Response shape of `UserService.getInitData`.
 * Nested DB-row collections pass through unknown columns while the documented
 * structural fields (summary, paginated lists, settings) are enforced.
 */
export const UserManagementInitResponseSchema = z
  .object({
    summary: UserSummaryResponseSchema,
    roles: z.array(RoleWithPermissionsSchema),
    permissions: z.array(PermissionSchema),
    sessions: z.array(z.record(z.string(), z.unknown())),
    settings: UserManagementSettingsResponseSchema.nullable(),
    loginHistory: LoginHistoryResponseSchema,
    auditTrail: AuditTrailResponseSchema,
    resetRequests: z.array(z.record(z.string(), z.unknown())),
    departments: z.array(z.record(z.string(), z.unknown())),
    jobTitles: z.array(z.record(z.string(), z.unknown())),
    users: paginated(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export type UserManagementInitResponse = z.infer<
  typeof UserManagementInitResponseSchema
>;

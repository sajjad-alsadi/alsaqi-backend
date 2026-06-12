/**
 * Endpoint contract interfaces for the User Management module.
 *
 * Covers the endpoints that previously lacked a typed shared contract
 * (FIX-BE-5, Requirement 5.4):
 *   - GET  /users/init
 *   - GET  /users/summary
 *   - GET  /user-management-settings  (+ PUT for the write op)
 *   - GET  /login-history
 *   - GET  /audit-trail
 *   - GET  /permissions
 *   - GET  /roles/:id/permissions     (matrix read)
 *   - POST /roles/:id/permissions     (matrix update)
 *
 * Each contract is authored against the live response shapes observed in the
 * corresponding services/routes:
 *   - `UserService.getInitData` / `getUserSummary` (src/services/UserService.ts)
 *   - `SettingsService.getUserManagementSettings` (src/services/SettingsService.ts)
 *   - `LogService.getLoginHistory` / `getAuditTrail` (src/services/LogService.ts)
 *   - `RoleService.getAllPermissions` (src/services/RoleService.ts)
 *   - the permission-matrix handlers in src/routes/permissionAdmin.ts
 */
import type {
  Permission,
  Role,
  UserSession,
  UserManagementSettings,
  JobTitle,
} from '../models';

/**
 * Standard paginated list envelope returned by the user-management list
 * endpoints (login-history, audit-trail, users).
 */
export interface Paginated<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/**
 * A single login-history entry as returned by `LogService.getLoginHistory`.
 */
export interface LoginHistoryEntry {
  id: string | number;
  user_id: string | number | null;
  login_time: string;
  ip_address?: string | null;
  user_agent?: string | null;
  status?: string | null;
  user_name?: string | null;
}

/**
 * A single audit-trail entry as returned by `LogService.getAuditTrail`.
 */
export interface AuditTrailEntry {
  id: string | number;
  user: string | null;
  action: string;
  module: string;
  details?: string | null;
  timestamp: string;
}

/**
 * Aggregate user counts returned by `UserService.getUserSummary`.
 */
export interface UserSummary {
  total: number;
  active: number;
  suspended: number;
  archived: number;
  admins: number;
  inactive: number;
}

/**
 * A role with its resolved permission list, as embedded in the init payload.
 */
export interface RoleWithPermissions extends Role {
  permissions: Permission[];
}

/**
 * Composite bootstrap payload returned by `UserService.getInitData`.
 */
export interface UserManagementInitData {
  summary: UserSummary;
  roles: RoleWithPermissions[];
  permissions: Permission[];
  sessions: UserSession[];
  settings: UserManagementSettings;
  loginHistory: Paginated<LoginHistoryEntry>;
  auditTrail: Paginated<AuditTrailEntry>;
  resetRequests: Array<Record<string, unknown>>;
  departments: Array<Record<string, unknown>>;
  jobTitles: JobTitle[];
  users: Paginated<Record<string, unknown>>;
}

/**
 * Per-action grant state for a module, e.g. `{ View: true, Edit: false }`.
 */
export type PermissionMatrix = Record<string, Record<string, boolean>>;

/**
 * Complete permission matrix for a role, returned by
 * `GET /roles/:id/permissions`.
 */
export interface RolePermissionMatrix {
  roleId: string | number;
  roleName: string;
  isCustom: boolean;
  permissions: PermissionMatrix;
}

/**
 * A single permission delta in a `POST /roles/:id/permissions` request.
 */
export interface PermissionUpdate {
  module: string;
  action: string;
  granted: boolean;
}

/**
 * Result of a `POST /roles/:id/permissions` update.
 */
export interface RolePermissionUpdateResult {
  message: string;
  roleId: string | number;
  roleName: string;
  updatedCount: number;
}

export interface UserManagementEndpoints {
  'GET /users/init': {
    response: UserManagementInitData;
  };
  'GET /users/summary': {
    response: UserSummary;
  };
  'GET /user-management-settings': {
    response: UserManagementSettings;
  };
  'PUT /user-management-settings': {
    body: Partial<UserManagementSettings>;
    response: { success: boolean };
  };
  'GET /login-history': {
    query: { page?: number; pageSize?: number };
    response: Paginated<LoginHistoryEntry>;
  };
  'GET /audit-trail': {
    query: { page?: number; pageSize?: number; module?: string; action?: string; username?: string };
    response: Paginated<AuditTrailEntry>;
  };
  'GET /permissions': {
    response: Permission[];
  };
  'GET /roles/:id/permissions': {
    params: { id: string };
    response: RolePermissionMatrix;
  };
  'POST /roles/:id/permissions': {
    params: { id: string };
    body: { permissions: PermissionUpdate[] };
    response: RolePermissionUpdateResult;
  };
}

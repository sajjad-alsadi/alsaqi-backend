/**
 * Core types and interfaces for the permission system.
 * This file defines the foundational types used across the Module Registry,
 * PermissionService, middleware, and frontend hook.
 */

/**
 * The five supported permission actions a module can authorize.
 */
export type PermissionAction = 'View' | 'Create' | 'Edit' | 'Delete' | 'Approve';

/**
 * Navigation/sidebar configuration for a module.
 */
export interface NavigationConfig {
  /** Icon identifier (e.g., Lucide icon name) */
  icon: string;
  /** Route path - must start with '/' */
  path: string;
  /** Display order in sidebar */
  order: number;
  /** Parent module name for nested navigation */
  parent?: string;
}

/**
 * Declarative definition of a permission module.
 * Single source of truth for module metadata used by DB seeder,
 * middleware, frontend navigation, and admin UI.
 */
export interface ModuleDefinition {
  /** Unique module identifier - PascalCase, 1-50 chars. Used in DB, middleware, and frontend. */
  name: string;
  /** Human-readable bilingual label for UI display */
  label: { en: string; ar: string };
  /** Which actions this module supports */
  actions: PermissionAction[];
  /** Default permissions per role (used for DB seeding & offline fallback) */
  defaults: Record<string, PermissionAction[]>;
  /** Sidebar/navigation configuration */
  navigation?: NavigationConfig;
  /** Whether files can be scoped to this module for file-level permission checks */
  fileScope?: boolean;
}

/**
 * A user's effective permissions as returned by the /permissions/me endpoint.
 * Combines role-level defaults with user-specific overrides.
 */
export interface UserPermissionSet {
  userId: string;
  role: string;
  roleId: string;
  isCustomRole: boolean;
  /** Effective permissions: role defaults + user overrides merged. Module name → allowed actions. */
  permissions: Record<string, PermissionAction[]>;
  /** User-specific overrides (grants or denials beyond role) */
  overrides: Array<{
    module: string;
    action: PermissionAction;
    isAllowed: boolean;
  }>;
}

/**
 * A role's complete permission matrix.
 * Maps each registered module to its granted actions for this role.
 */
export interface RolePermissionSet {
  roleId: string;
  roleName: string;
  isCustom: boolean;
  /** Module name → granted actions */
  permissions: Record<string, PermissionAction[]>;
}

/**
 * Represents a single permission change in a role update request.
 */
export interface PermissionUpdate {
  /** Module name from the registry */
  module: string;
  /** Action to grant or revoke */
  action: PermissionAction;
  /** Whether the permission is granted (true) or revoked (false) */
  granted: boolean;
}

/**
 * Result of the auto-seeding process.
 * Reports what was added vs. what already existed.
 */
export interface SeedResult {
  /** Permission keys (module:action) that were newly inserted */
  added: string[];
  /** Permission keys (module:action) that already existed and were skipped */
  skipped: string[];
  /** Total number of modules processed */
  total: number;
}

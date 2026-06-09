/**
 * @alsaqi/shared - Shared constants
 * Error codes, module names, and API version used by both API and frontend.
 */

// ─── Error Codes ────────────────────────────────────────────────────────────────

/**
 * Standard error codes returned in the API error response envelope.
 * These codes are used consistently across both server and client
 * for error identification and handling.
 */
export const ErrorCodes = {
  /** Input validation failed (HTTP 400) */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Authentication required or token invalid (HTTP 401) */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated but lacking permission (HTTP 403) */
  FORBIDDEN: 'FORBIDDEN',
  /** Requested resource does not exist (HTTP 404) */
  NOT_FOUND: 'NOT_FOUND',
  /** Unhandled server error (HTTP 500) */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** Too many requests in the sliding window (HTTP 429) */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  /** CSRF token missing or invalid on state-changing request (HTTP 403) */
  CSRF_VALIDATION_FAILED: 'CSRF_VALIDATION_FAILED',
  /** Resource state conflict, e.g. duplicate name (HTTP 409) */
  CONFLICT: 'CONFLICT',
  /** Generic bad request (HTTP 400) */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Database operation failed (HTTP 500) */
  DATABASE_ERROR: 'DATABASE_ERROR',
  /** Security policy violation (HTTP 403) */
  SECURITY_ERROR: 'SECURITY_ERROR',
  /** Request body exceeds maximum allowed size (HTTP 413) */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** Permission denied for resource access (HTTP 403) */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Idempotency key missing or malformed (HTTP 400) */
  INVALID_IDEMPOTENCY_KEY: 'INVALID_IDEMPOTENCY_KEY',
  /** Concurrent request with the same idempotency key (HTTP 409) */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ─── Module Names ───────────────────────────────────────────────────────────────

/**
 * Module identifiers used across the application for permissions,
 * routing, and feature organization.
 */
export const ModuleNames = {
  AUTH: 'auth',
  AUDIT_PLANS: 'auditPlans',
  AUDIT_PROGRAMS: 'auditPrograms',
  FINDINGS: 'findings',
  TASKS: 'tasks',
  USERS: 'users',
  DEPARTMENTS: 'departments',
  NOTIFICATIONS: 'notifications',
  RISK_REGISTER: 'riskRegister',
  CORRESPONDENCE: 'correspondence',
  RECOMMENDATIONS: 'recommendations',
} as const;

export type ApiModuleName = (typeof ModuleNames)[keyof typeof ModuleNames];

/** Array of all module name values for iteration/validation */
export const MODULE_NAME_LIST: ApiModuleName[] = Object.values(ModuleNames);

// ─── API Version ────────────────────────────────────────────────────────────────

/**
 * Current API version string (semver).
 * Included in every response via the `meta.version` field and `X-API-Version` header.
 * Used by the client to detect version mismatches and prompt page refresh.
 */
export const API_VERSION = '1.0.0';

// ─── Role Group Constants ───────────────────────────────────────────────────────

import { UserRole } from '../types/enums';

/** Roles with admin-level access (Admin, Manager) */
export const ADMIN_ROLES = [UserRole.ADMIN, UserRole.MANAGER] as const;

/** Roles with compliance-level access */
export const COMPLIANCE_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.COMPLIANCE_OFFICER] as const;

/** Roles considered as staff (not just viewers) */
export const STAFF_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.INTERNAL_AUDITOR, UserRole.VIEWER] as const;

/**
 * Maps frontend module names to their corresponding DB module names.
 * Frontend may use different naming conventions (e.g. 'UserManagement')
 * while the DB stores shorter names (e.g. 'User').
 */
export const PERMISSION_MODULE_MAP: Record<string, string> = {
  UserManagement: 'User',
  Settings: 'Settings',
  AuditPlans: 'Audit',
  RiskRegister: 'Risk',
  FraudLog: 'Fraud',
  Dashboard: 'Audit',
  Correspondence: 'Correspondence',
  Notifications: 'Notifications',
  Departments: 'Departments',
  Recommendations: 'Recommendations',
};

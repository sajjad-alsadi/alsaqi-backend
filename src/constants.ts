/**
 * API-specific constants that extend the shared constants.
 * Re-exports shared constants and adds server-only constants.
 */

// Re-export everything from shared package
export { UserRole } from '@alsaqi/shared';
import { UserRole } from '@alsaqi/shared';

// Role Constants to prevent DRY violations across services
export const ADMIN_ROLES = [UserRole.ADMIN, UserRole.MANAGER] as const;
export const COMPLIANCE_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.COMPLIANCE_OFFICER] as const;
export const STAFF_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.INTERNAL_AUDITOR, UserRole.VIEWER] as const;

/**
 * Maps frontend MODULES values to backend DB permissions.module values.
 * Used to bridge the gap between frontend route/module names and the
 * permission module names stored in the database.
 */
export const PERMISSION_MODULE_MAP: Record<string, string> = {
  'UserManagement': 'User',
  'Settings': 'Setting',
  'AuditPlans': 'Audit',
  'AuditReports': 'Audit',
  'AuditCharter': 'Audit',
  'AuditTasks': 'Audit',
  'AuditProgramLibrary': 'Audit',
  'RiskRegister': 'Risk',
  'FraudLog': 'Finding',
  'SystemErrorLogs': 'Setting',
  'ConflictOfInterest': 'Audit',
  'InternalPolicies': 'Audit',
  'ExecutiveReports': 'Audit',
  'OrgStructure': 'Setting',
  'AuditTrail': 'Setting',
  'Dashboard': 'Audit',
};

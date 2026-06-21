/**
 * API-specific constants that extend the shared constants.
 * Re-exports shared constants and adds server-only constants.
 *
 * `@alsaqi/shared` is the single source of truth (Requirement 8.1/8.2).
 * Maps and correspondence constants are re-exported from the package
 * rather than duplicated here, so the API and the frontend always
 * resolve each constant to the same value.
 */

// Re-export everything from shared package
export { UserRole } from '@alsaqi/shared';
import { UserRole } from '@alsaqi/shared';

// Single source of truth: re-export from @alsaqi/shared without an
// independently-edited local copy. Previously a duplicated table lived here
// and had drifted (e.g. Settings -> 'Setting', FraudLog -> 'Finding'); the
// canonical values are now the shared package's (Settings -> 'Settings',
// FraudLog -> 'Fraud').
export {
  PERMISSION_MODULE_MAP,
  // Correspondence module constants (status/field/referral/link enums)
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
  PRIORITIES,
  CLASSIFICATIONS,
  METHODS,
  ENTITY_TYPES,
  REFERRAL_STATUSES,
  LINK_TYPES,
} from '@alsaqi/shared';

// Role Constants to prevent DRY violations across services
export const ADMIN_ROLES = [UserRole.ADMIN, UserRole.MANAGER] as const;
export const COMPLIANCE_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.COMPLIANCE_OFFICER] as const;
export const STAFF_ROLES = [UserRole.ADMIN, UserRole.MANAGER, UserRole.INTERNAL_AUDITOR, UserRole.VIEWER] as const;

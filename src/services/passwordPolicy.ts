import { db } from '../db/index';
import { ValidationError } from '../utils/errors';

/**
 * Single source of truth for the configurable password policy.
 *
 * Centralizes the policy enforcement that previously lived as a private method on
 * `PasswordService`, so every password-setting path (self-service change/update, admin
 * `resetPassword`, and admin `updateUser`-with-password) shares ONE implementation
 * (Requirement 2.11).
 */

/**
 * The default minimum password length, used when no configured policy is available.
 * This is the single policy-derived minimum applied across all password-setting
 * endpoints (Requirement 2.12), replacing the previous ad-hoc `min(6)`/`min(8)` values.
 */
export const DEFAULT_PASSWORD_MIN_LENGTH = 8;

/**
 * Validate a password against the system-configured policy
 * (`user_management_settings`): minimum length plus optional uppercase/lowercase/
 * number/symbol character-class requirements.
 *
 * Throws a `ValidationError` when the password violates the policy. When no settings
 * row exists (or the settings query is unavailable), policy validation is skipped
 * gracefully so callers in environments without configured settings are unaffected.
 */
export async function validatePasswordPolicy(password: string): Promise<void> {
  let settings: any;
  try {
    settings = await db
      .prepare(
        "SELECT password_min_length, password_require_uppercase, password_require_lowercase, password_require_numbers, password_require_symbols FROM user_management_settings WHERE id = 1"
      )
      .get();
  } catch (e) {
    // If the settings query fails, skip policy validation (preserve prior behavior).
    return;
  }

  if (!settings) return; // No settings, skip validation

  const minLength = settings.password_min_length || DEFAULT_PASSWORD_MIN_LENGTH;
  if (password.length < minLength) {
    throw new ValidationError(`Password must be at least ${minLength} characters`);
  }
  if (settings.password_require_uppercase && !/[A-Z]/.test(password)) {
    throw new ValidationError("Password must contain at least one uppercase letter");
  }
  if (settings.password_require_lowercase && !/[a-z]/.test(password)) {
    throw new ValidationError("Password must contain at least one lowercase letter");
  }
  if (settings.password_require_numbers && !/[0-9]/.test(password)) {
    throw new ValidationError("Password must contain at least one number");
  }
  if (settings.password_require_symbols && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    throw new ValidationError("Password must contain at least one special character");
  }
}

import logger from './logger';

/**
 * Result of production secrets validation.
 * Contains validation status, errors (blocking), and warnings (non-blocking).
 */
export interface SecretValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/** Known weak default values that must be rejected in production */
const WEAK_DEFAULTS: Record<string, string[]> = {
  JWT_SECRET: ['alsaqi-dev-secret-key-123'],
  VITE_STORAGE_SECRET: ['your-32-character-secret-key-here'],
  VITE_NETWORK_SECRET: ['your-network-hmac-secret-here'],
};

/**
 * Validates that all production-critical secrets meet minimum security requirements.
 *
 * Checks:
 * - JWT_SECRET: not a weak default, minimum 64 characters
 * - VITE_STORAGE_SECRET: set, not a weak default, minimum 32 characters
 * - VITE_NETWORK_SECRET: set, not a weak default
 * - DATABASE_URL: set
 *
 * Warnings (non-blocking):
 * - CORS_ORIGIN not set
 * - FILE_ENCRYPTION_KEY not set
 *
 * IMPORTANT: Never logs actual secret values.
 */
export function validateProductionSecrets(
  env: Record<string, string | undefined> = process.env
): SecretValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // JWT_SECRET validation
  if (!env.JWT_SECRET || WEAK_DEFAULTS.JWT_SECRET.includes(env.JWT_SECRET)) {
    errors.push('JWT_SECRET must be set to a strong random value (not a default)');
  } else if (env.JWT_SECRET.length < 64) {
    errors.push('JWT_SECRET must be at least 64 characters');
  }

  // VITE_STORAGE_SECRET validation
  if (!env.VITE_STORAGE_SECRET || WEAK_DEFAULTS.VITE_STORAGE_SECRET.includes(env.VITE_STORAGE_SECRET)) {
    errors.push('VITE_STORAGE_SECRET must be set to a strong random value (not a default)');
  } else if (env.VITE_STORAGE_SECRET.length < 32) {
    errors.push('VITE_STORAGE_SECRET must be at least 32 characters');
  }

  // VITE_NETWORK_SECRET validation
  if (!env.VITE_NETWORK_SECRET || WEAK_DEFAULTS.VITE_NETWORK_SECRET.includes(env.VITE_NETWORK_SECRET)) {
    errors.push('VITE_NETWORK_SECRET must be set to a strong random value (not a default)');
  }

  // DATABASE_URL validation
  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL must be set in production');
  }

  // Optional but recommended variables (warnings only)
  if (!env.CORS_ORIGIN) {
    warnings.push('CORS_ORIGIN not set - CORS will be disabled');
  }
  if (!env.FILE_ENCRYPTION_KEY) {
    warnings.push('FILE_ENCRYPTION_KEY not set - file encryption disabled');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Runs secrets validation and logs results appropriately.
 * In production: logs errors and returns the result (caller should exit on failure).
 * In development: logs warnings but never blocks startup.
 */
export function runSecretsValidation(
  env: Record<string, string | undefined> = process.env
): SecretValidationResult {
  const result = validateProductionSecrets(env);
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    if (!result.isValid) {
      logger.error('FATAL: Production secrets validation failed:');
      result.errors.forEach((e) => logger.error(`  ✗ ${e}`));
    }
    result.warnings.forEach((w) => logger.warn(`  ⚠ ${w}`));
  } else {
    // Development mode: log warnings for weak secrets but don't block
    if (result.errors.length > 0) {
      logger.warn('Development mode - weak secrets detected (would fail in production):');
      result.errors.forEach((e) => logger.warn(`  ⚠ ${e}`));
    }
    result.warnings.forEach((w) => logger.debug(`  ℹ ${w}`));
  }

  return result;
}

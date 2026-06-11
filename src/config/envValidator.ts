/**
 * Environment Variable Validator
 *
 * Validates all required and optional environment variables at application startup.
 * In production (NODE_ENV=production), missing or malformed required variables
 * cause immediate process termination with a FATAL error message listing all issues.
 *
 * Classification:
 * - Required: Server fails without these in production
 * - Optional: Server works with documented defaults
 *
 * Validates: Requirements 1.5, 11.2, 11.3, 11.4
 */

import logger from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EnvVarType = 'string' | 'numeric' | 'url' | 'boolean' | 'path' | 'pem-key' | 'log-level';

export interface EnvVarDefinition {
  /** Variable name */
  name: string;
  /** Whether this variable is required in production */
  required: boolean;
  /** Expected type/format */
  type: EnvVarType;
  /** Default value for optional variables */
  defaultValue?: string;
  /** Minimum string length (for secrets) */
  minLength?: number;
  /** Human-readable description */
  description: string;
  /** Category for documentation grouping */
  category: 'server' | 'database' | 'auth' | 'encryption' | 'backup' | 'integrations' | 'cache';
}

export interface ValidationError {
  variable: string;
  message: string;
  expectedType?: string;
  receivedValue?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

// ─── Variable Definitions ────────────────────────────────────────────────────

/**
 * All known environment variables with their classification and validation rules.
 * Required variables (in production) will cause startup failure if missing/invalid.
 * Optional variables have documented defaults.
 */
export const ENV_VAR_DEFINITIONS: EnvVarDefinition[] = [
  // ── Server ─────────────────────────────────────────────────────────────────
  {
    name: 'PORT',
    required: false,
    type: 'numeric',
    defaultValue: '3000',
    description: 'HTTP server listening port',
    category: 'server',
  },
  {
    name: 'NODE_ENV',
    required: false,
    type: 'string',
    defaultValue: 'development',
    description: 'Application environment (development, production, test)',
    category: 'server',
  },
  {
    name: 'CORS_ORIGIN',
    required: true,
    type: 'string',
    description: 'Comma-separated list of allowed CORS origins',
    category: 'server',
  },
  {
    name: 'UPLOAD_DIR',
    required: false,
    type: 'path',
    defaultValue: './uploads',
    description: 'Directory path for file uploads',
    category: 'server',
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    type: 'log-level',
    defaultValue: 'info',
    description: 'Logging level (error, warn, info, debug)',
    category: 'server',
  },

  // ── Database ───────────────────────────────────────────────────────────────
  {
    name: 'DATABASE_URL',
    required: true,
    type: 'url',
    description: 'PostgreSQL connection string (postgresql://user:pass@host:port/db)',
    category: 'database',
  },
  {
    name: 'DB_SSL_CA_PATH',
    required: false,
    type: 'path',
    description: 'Path to CA certificate for database SSL',
    category: 'database',
  },
  {
    name: 'DB_SSL_REJECT_UNAUTHORIZED',
    required: false,
    type: 'boolean',
    defaultValue: 'true',
    description: 'Whether to reject unauthorized SSL connections',
    category: 'database',
  },

  // ── Authentication ─────────────────────────────────────────────────────────
  {
    name: 'JWT_SECRET',
    required: true,
    type: 'string',
    minLength: 64,
    description: 'JWT signing secret (minimum 64 random characters)',
    category: 'auth',
  },
  {
    name: 'JWT_PRIVATE_KEY',
    required: false,
    type: 'pem-key',
    description: 'RSA private key in PEM format (auto-generated if not provided)',
    category: 'auth',
  },
  {
    name: 'JWT_PUBLIC_KEY',
    required: false,
    type: 'pem-key',
    description: 'RSA public key in PEM format (auto-generated if not provided)',
    category: 'auth',
  },

  // ── Encryption ─────────────────────────────────────────────────────────────
  {
    name: 'VITE_STORAGE_SECRET',
    required: true,
    type: 'string',
    minLength: 32,
    description: 'Storage encryption secret (minimum 32 characters)',
    category: 'encryption',
  },
  {
    name: 'VITE_NETWORK_SECRET',
    required: true,
    type: 'string',
    description: 'HMAC secret for network request signing',
    category: 'encryption',
  },
  {
    name: 'FILE_ENCRYPTION_KEY',
    required: false,
    type: 'string',
    description: 'AES key for file encryption (encryption disabled if not set)',
    category: 'encryption',
  },
  {
    name: 'TOTP_ENCRYPTION_KEY',
    required: false,
    type: 'string',
    description: 'Encryption key for 2FA TOTP secrets (falls back to FILE_ENCRYPTION_KEY)',
    category: 'encryption',
  },
  {
    name: 'FILE_ACCESS_SECRET',
    required: false,
    type: 'string',
    description: 'Secret for signing file access URLs (falls back to JWT_SECRET)',
    category: 'encryption',
  },

  // ── Cache / Redis ──────────────────────────────────────────────────────────
  {
    name: 'REDIS_URL',
    required: true,
    type: 'url',
    description: 'Redis connection URL for caching, rate limiting, and BullMQ',
    category: 'cache',
  },

  // ── Backup ─────────────────────────────────────────────────────────────────
  {
    name: 'DATA_DIR',
    required: false,
    type: 'path',
    defaultValue: './data',
    description: 'Persistent data directory for RSA keys and app data',
    category: 'backup',
  },
  {
    name: 'BACKUP_DIR',
    required: false,
    type: 'path',
    defaultValue: './backups',
    description: 'Directory for database backups',
    category: 'backup',
  },
  {
    name: 'MAX_BACKUPS',
    required: false,
    type: 'numeric',
    defaultValue: '7',
    description: 'Maximum number of backup files to retain',
    category: 'backup',
  },
  {
    name: 'BACKUP_RETENTION_DAYS',
    required: false,
    type: 'numeric',
    defaultValue: '30',
    description: 'Number of days to retain backup files',
    category: 'backup',
  },
  {
    name: 'ENCRYPT_BACKUPS',
    required: false,
    type: 'boolean',
    defaultValue: 'false',
    description: 'Whether to encrypt database backups',
    category: 'backup',
  },
  {
    name: 'AUDIT_TRAIL_RETENTION_MONTHS',
    required: false,
    type: 'numeric',
    defaultValue: '24',
    description: 'Number of months to retain audit trail partitions',
    category: 'backup',
  },

  // ── External Integrations ──────────────────────────────────────────────────
  {
    name: 'N8N_WEBHOOK_URL',
    required: false,
    type: 'url',
    description: 'n8n automation webhook URL (optional, graceful degradation)',
    category: 'integrations',
  },
  {
    name: 'N8N_WEBHOOK_API_KEY',
    required: false,
    type: 'string',
    description: 'API key for n8n webhook authentication',
    category: 'integrations',
  },
];

// ─── Validation Functions ────────────────────────────────────────────────────

/**
 * Validates that a value is numeric (parseable as integer or float).
 */
export function isValidNumeric(value: string): boolean {
  const num = Number(value);
  return !isNaN(num) && isFinite(num) && value.trim().length > 0;
}

/**
 * Validates that a value looks like a valid URL.
 * Accepts postgresql://, postgres://, redis://, rediss://, http://, https:// schemes.
 * For context-specific validation, use isValidDatabaseUrl or isValidRedisUrl.
 */
export function isValidUrl(value: string): boolean {
  const trimmed = value.trim();
  // Accept common connection string schemes
  const validSchemes = ['postgresql://', 'postgres://', 'redis://', 'rediss://', 'http://', 'https://'];
  return validSchemes.some(scheme => trimmed.startsWith(scheme));
}

/**
 * Validates that a value is a valid PostgreSQL URL.
 * Only accepts postgresql:// or postgres:// schemes.
 */
export function isValidDatabaseUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('postgresql://') || trimmed.startsWith('postgres://');
}

/**
 * Validates that a value is a valid Redis URL.
 * Only accepts redis:// or rediss:// schemes.
 */
export function isValidRedisUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('redis://') || trimmed.startsWith('rediss://');
}

/**
 * Validates that a value is a boolean string.
 */
export function isValidBoolean(value: string): boolean {
  return ['true', 'false', '1', '0', 'yes', 'no'].includes(value.toLowerCase().trim());
}

/**
 * Validates that a value looks like a PEM-formatted key.
 */
export function isValidPemKey(value: string): boolean {
  const normalized = value.replace(/\\n/g, '\n').trim();
  return normalized.includes('-----BEGIN') && normalized.includes('-----END');
}

/**
 * Validates that a value is a valid log level.
 */
export function isValidLogLevel(value: string): boolean {
  return ['error', 'warn', 'info', 'debug'].includes(value.toLowerCase().trim());
}

/**
 * Validates a single environment variable value against its expected type.
 * For URL types, optionally accepts a variable name to apply context-specific validation.
 */
export function validateType(value: string, type: EnvVarType, variableName?: string): boolean {
  switch (type) {
    case 'string':
      return value.length > 0;
    case 'numeric':
      return isValidNumeric(value);
    case 'url':
      // Context-specific URL validation based on variable name
      if (variableName === 'DATABASE_URL') {
        return isValidDatabaseUrl(value);
      }
      if (variableName === 'REDIS_URL') {
        return isValidRedisUrl(value);
      }
      return isValidUrl(value);
    case 'boolean':
      return isValidBoolean(value);
    case 'path':
      return value.trim().length > 0;
    case 'pem-key':
      return isValidPemKey(value);
    case 'log-level':
      return isValidLogLevel(value);
    default:
      return true;
  }
}

/**
 * Returns a human-readable type description for error messages.
 */
function typeDescription(type: EnvVarType): string {
  switch (type) {
    case 'string':
      return 'non-empty string';
    case 'numeric':
      return 'numeric value';
    case 'url':
      return 'valid URL (postgresql://, redis://, http://, or https://)';
    case 'boolean':
      return 'boolean (true/false)';
    case 'path':
      return 'file/directory path';
    case 'pem-key':
      return 'PEM-formatted key (-----BEGIN...-----END)';
    case 'log-level':
      return 'log level (error, warn, info, debug)';
    default:
      return type;
  }
}

// ─── Main Validation ─────────────────────────────────────────────────────────

/**
 * Validates all environment variables according to their definitions.
 * Collects ALL errors before returning (does not fail on first error).
 *
 * @param env - Environment variables to validate (defaults to process.env)
 * @param isProduction - Whether to enforce production requirements
 * @returns ValidationResult with all errors and warnings
 */
export function validateEnvironment(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  isProduction: boolean = (env.NODE_ENV === 'production')
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  for (const def of ENV_VAR_DEFINITIONS) {
    const value = env[def.name];
    const hasValue = value !== undefined && value !== '';

    // Check presence
    if (!hasValue) {
      if (def.required && isProduction) {
        errors.push({
          variable: def.name,
          message: `Required environment variable ${def.name} is missing`,
        });
      } else if (def.required && !isProduction) {
        // In non-production, missing required vars are just warnings
        warnings.push({
          variable: def.name,
          message: `${def.name} is not set (required in production, default: ${def.defaultValue || 'none'})`,
        });
      }
      continue;
    }

    // Check type correctness
    if (!validateType(value, def.type, def.name)) {
      const errorEntry: ValidationError = {
        variable: def.name,
        message: `${def.name} has invalid format: expected ${typeDescription(def.type)}, received "${sanitizeValue(value, def.name)}"`,
        expectedType: typeDescription(def.type),
        receivedValue: sanitizeValue(value, def.name),
      };

      if (def.required && isProduction) {
        errors.push(errorEntry);
      } else if (isProduction) {
        // Optional var with invalid type in production is a warning
        warnings.push(errorEntry);
      }
      continue;
    }

    // Check minimum length (for secrets)
    if (def.minLength && value.length < def.minLength) {
      const errorEntry: ValidationError = {
        variable: def.name,
        message: `${def.name} must be at least ${def.minLength} characters (received ${value.length})`,
        expectedType: `string with min length ${def.minLength}`,
        receivedValue: `[${value.length} characters]`,
      };

      if (def.required && isProduction) {
        errors.push(errorEntry);
      } else if (isProduction) {
        warnings.push(errorEntry);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Sanitizes sensitive values for error messages.
 * Never expose full secret values in logs.
 */
function sanitizeValue(value: string, varName: string): string {
  const sensitiveVars = [
    'JWT_SECRET', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY',
    'VITE_STORAGE_SECRET', 'VITE_NETWORK_SECRET',
    'FILE_ENCRYPTION_KEY', 'TOTP_ENCRYPTION_KEY',
    'FILE_ACCESS_SECRET', 'N8N_WEBHOOK_API_KEY',
    'DATABASE_URL', 'REDIS_URL',
  ];

  if (sensitiveVars.includes(varName)) {
    if (value.length <= 4) {
      return '****';
    }
    return value.substring(0, 4) + '****';
  }

  // For non-sensitive vars, show the full value (it helps debugging)
  return value;
}

// ─── Startup Validator ───────────────────────────────────────────────────────

/**
 * Runs environment validation at startup and terminates the process
 * if required variables are missing or invalid in production.
 *
 * Behavior:
 * - Production: Collects all errors, logs a single FATAL message, exits within 5 seconds
 * - Development/Test: Logs warnings but does not block startup
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns ValidationResult for testing purposes
 */
export function validateEnvironmentOnStartup(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): ValidationResult {
  const isProduction = env.NODE_ENV === 'production';
  const result = validateEnvironment(env, isProduction);

  if (isProduction && !result.isValid) {
    // Log a single FATAL message with all missing/invalid variables
    const errorMessages = result.errors.map(e => `  ✗ ${e.message}`).join('\n');
    const fatalMessage =
      `FATAL: Environment validation failed. The following required environment variables are missing or invalid:\n${errorMessages}`;

    logger.error(fatalMessage);

    // Exit within 5 seconds as required by spec
    const exitTimer = setTimeout(() => {
      process.exit(1);
    }, 100); // Exit quickly but after log flush
    exitTimer.unref();

    // Also attempt synchronous exit to guarantee the 5-second window
    setImmediate(() => {
      process.exit(1);
    });
  } else if (!isProduction) {
    // Development/Test: log warnings
    if (result.warnings.length > 0) {
      const warningMessages = result.warnings.map(w => `  ⚠ ${w.message}`).join('\n');
      logger.warn(`Environment validation warnings (non-blocking in ${env.NODE_ENV || 'development'} mode):\n${warningMessages}`);
    }
  }

  // Log production warnings as well (non-blocking)
  if (isProduction && result.warnings.length > 0) {
    const warningMessages = result.warnings.map(w => `  ⚠ ${w.message}`).join('\n');
    logger.warn(`Environment validation warnings:\n${warningMessages}`);
  }

  return result;
}

/**
 * Returns all required variable names for production.
 */
export function getRequiredVariables(): string[] {
  return ENV_VAR_DEFINITIONS
    .filter(d => d.required)
    .map(d => d.name);
}

/**
 * Returns all optional variables with their defaults.
 */
export function getOptionalVariables(): Array<{ name: string; defaultValue: string | undefined; description: string }> {
  return ENV_VAR_DEFINITIONS
    .filter(d => !d.required)
    .map(d => ({ name: d.name, defaultValue: d.defaultValue, description: d.description }));
}

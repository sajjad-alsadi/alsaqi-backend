// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 17: Environment Variable Validation
 *
 * For any subset of required environment variables where at least one is missing,
 * the server refuses to start and displays an error naming the missing variable.
 *
 * **Validates: Requirement 11.2**
 */

import {
  validateEnvironment,
  getRequiredVariables,
  ENV_VAR_DEFINITIONS,
} from '../envValidator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a complete valid environment with all required variables set to
 * valid values that pass type validation.
 */
function createCompleteValidEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/alsaqi?sslmode=require',
    JWT_SECRET: 'a'.repeat(64),
    VITE_STORAGE_SECRET: 'b'.repeat(32),
    VITE_NETWORK_SECRET: 'strong-network-hmac-secret-value-here',
    CORS_ORIGIN: 'https://app.example.com',
    REDIS_URL: 'redis://redis.example.com:6379',
    UPLOAD_DIR: '/app/uploads',
    DATA_DIR: '/app/data',
    LOG_LEVEL: 'info',
    BACKUP_DIR: '/app/backups',
    MAX_BACKUPS: '7',
    BACKUP_RETENTION_DAYS: '30',
    ENCRYPT_BACKUPS: 'false',
    AUDIT_TRAIL_RETENTION_MONTHS: '24',
    DB_SSL_REJECT_UNAUTHORIZED: 'true',
  };
}

/**
 * Generator that produces a non-empty subset of required variable names to remove.
 * Ensures at least one required variable is always missing.
 */
function arbitraryMissingSubset(requiredVars: string[]): fc.Arbitrary<string[]> {
  return fc
    .subarray(requiredVars, { minLength: 1, maxLength: requiredVars.length })
    .filter((arr) => arr.length > 0);
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 17: Environment Variable Validation', () => {
  const requiredVars = getRequiredVariables();

  describe('Missing required variables cause validation failure', () => {
    it('for ANY subset of required variables where at least one is missing, validation must fail (isValid = false)', () => {
      fc.assert(
        fc.property(
          arbitraryMissingSubset(requiredVars),
          (missingVars) => {
            // Start with a complete valid environment
            const env = createCompleteValidEnv();

            // Remove the selected subset of required variables
            for (const varName of missingVars) {
              delete env[varName];
            }

            // Validate in production mode
            const result = validateEnvironment(env, true);

            // Must be invalid when required variables are missing
            expect(result.isValid).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('every missing required variable must appear by name in the error messages', () => {
      fc.assert(
        fc.property(
          arbitraryMissingSubset(requiredVars),
          (missingVars) => {
            // Start with a complete valid environment
            const env = createCompleteValidEnv();

            // Remove the selected subset of required variables
            for (const varName of missingVars) {
              delete env[varName];
            }

            // Validate in production mode
            const result = validateEnvironment(env, true);

            // Every missing variable must be identified by name in an error
            for (const varName of missingVars) {
              const hasError = result.errors.some(
                (e) => e.variable === varName
              );
              expect(
                hasError,
                `Expected error for missing variable "${varName}" but none found. Errors: ${result.errors.map((e) => e.variable).join(', ')}`
              ).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Complete valid environment passes validation', () => {
    it('for ANY valid complete set of required variables, validation must pass (isValid = true)', () => {
      // Generate variations of valid environments with different valid values
      const validDatabaseUrls = fc.constantFrom(
        'postgresql://user:pass@db.example.com:5432/mydb',
        'postgresql://admin:secret@localhost:5432/production',
        'postgres://u:p@host:5432/db?sslmode=require'
      );

      const validRedisUrls = fc.constantFrom(
        'redis://localhost:6379',
        'redis://user:pass@redis.example.com:6379',
        'rediss://secure-redis.example.com:6380'
      );

      const validCorsOrigins = fc.constantFrom(
        'https://app.example.com',
        'https://myapp.com,https://admin.myapp.com',
        'http://localhost:3000'
      );

      // JWT_SECRET must be >= 64 chars
      const validJwtSecrets = fc.string({ minLength: 64, maxLength: 128 }).map(
        (s) => s.padEnd(64, 'x') // ensure minimum length
      );

      // VITE_STORAGE_SECRET must be >= 32 chars
      const validStorageSecrets = fc.string({ minLength: 32, maxLength: 64 }).map(
        (s) => s.padEnd(32, 'y') // ensure minimum length
      );

      const validNetworkSecrets = fc.string({ minLength: 10, maxLength: 64 });

      fc.assert(
        fc.property(
          validDatabaseUrls,
          validRedisUrls,
          validCorsOrigins,
          validJwtSecrets,
          validStorageSecrets,
          validNetworkSecrets,
          (dbUrl, redisUrl, corsOrigin, jwtSecret, storageSecret, networkSecret) => {
            const env: Record<string, string> = {
              NODE_ENV: 'production',
              DATABASE_URL: dbUrl,
              REDIS_URL: redisUrl,
              CORS_ORIGIN: corsOrigin,
              JWT_SECRET: jwtSecret,
              VITE_STORAGE_SECRET: storageSecret,
              VITE_NETWORK_SECRET: networkSecret,
            };

            const result = validateEnvironment(env, true);

            // All required variables present with valid values → must pass
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Error count matches number of missing variables', () => {
    it('the number of errors for missing variables equals the count of removed required variables', () => {
      fc.assert(
        fc.property(
          arbitraryMissingSubset(requiredVars),
          (missingVars) => {
            const env = createCompleteValidEnv();

            for (const varName of missingVars) {
              delete env[varName];
            }

            const result = validateEnvironment(env, true);

            // Each missing required variable should produce exactly one error
            const missingErrors = result.errors.filter((e) =>
              missingVars.includes(e.variable)
            );
            expect(missingErrors.length).toBe(missingVars.length);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});

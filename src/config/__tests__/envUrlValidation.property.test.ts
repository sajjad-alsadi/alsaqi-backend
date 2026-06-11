// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 16: Environment URL Format Validation
 *
 * For any string provided as DATABASE_URL, the environment validator SHALL accept it
 * only if it starts with postgresql:// or postgres://.
 * For any string provided as REDIS_URL, the validator SHALL accept it only if it starts
 * with redis:// or rediss://.
 *
 * **Validates: Requirements 11.2, 11.4**
 */

import { validateEnvironment } from '../envValidator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a complete valid environment with all required variables set to
 * valid values. The DATABASE_URL and REDIS_URL can be overridden per test.
 */
function createBaseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/alsaqi',
    JWT_SECRET: 'a'.repeat(64),
    VITE_STORAGE_SECRET: 'b'.repeat(32),
    VITE_NETWORK_SECRET: 'strong-network-hmac-secret-value-here',
    CORS_ORIGIN: 'https://app.example.com',
    REDIS_URL: 'redis://redis.example.com:6379',
    ...overrides,
  };
}

/**
 * Generator for valid URL suffixes (host:port/db patterns).
 */
function arbitraryUrlSuffix(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.string({ minLength: 1, maxLength: 20, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) }),
    fc.integer({ min: 1000, max: 65535 }),
    fc.string({ minLength: 1, maxLength: 16, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')) }),
  ).map(([host, port, db]) => `${host}:${port}/${db}`);
}

/**
 * Generator for invalid URL prefixes that should NOT be accepted for DATABASE_URL.
 */
function arbitraryInvalidDatabasePrefix(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant('http://'),
    fc.constant('https://'),
    fc.constant('ftp://'),
    fc.constant('mysql://'),
    fc.constant('mongodb://'),
    fc.constant('redis://'),
    fc.constant('rediss://'),
    fc.constant('sqlite://'),
    fc.constant(''),
    // Random strings that don't start with postgresql:// or postgres://
    fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')) })
      .filter(s => !s.startsWith('postgresql://') && !s.startsWith('postgres://')),
  );
}

/**
 * Generator for invalid URL prefixes that should NOT be accepted for REDIS_URL.
 */
function arbitraryInvalidRedisPrefix(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant('http://'),
    fc.constant('https://'),
    fc.constant('ftp://'),
    fc.constant('mysql://'),
    fc.constant('mongodb://'),
    fc.constant('postgresql://'),
    fc.constant('postgres://'),
    fc.constant('sqlite://'),
    fc.constant(''),
    // Random strings that don't start with redis:// or rediss://
    fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')) })
      .filter(s => !s.startsWith('redis://') && !s.startsWith('rediss://')),
  );
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 16: Environment URL Format Validation', () => {

  describe('DATABASE_URL accepts only postgresql:// or postgres:// prefixes', () => {
    it('valid DATABASE_URL with postgresql:// prefix passes validation', () => {
      fc.assert(
        fc.property(
          arbitraryUrlSuffix(),
          (suffix) => {
            const env = createBaseEnv({
              DATABASE_URL: `postgresql://${suffix}`,
            });

            const result = validateEnvironment(env, true);
            const dbErrors = result.errors.filter(e => e.variable === 'DATABASE_URL');

            expect(dbErrors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('valid DATABASE_URL with postgres:// prefix passes validation', () => {
      fc.assert(
        fc.property(
          arbitraryUrlSuffix(),
          (suffix) => {
            const env = createBaseEnv({
              DATABASE_URL: `postgres://${suffix}`,
            });

            const result = validateEnvironment(env, true);
            const dbErrors = result.errors.filter(e => e.variable === 'DATABASE_URL');

            expect(dbErrors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('invalid DATABASE_URL with non-postgresql prefixes is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryInvalidDatabasePrefix(),
          arbitraryUrlSuffix(),
          (prefix, suffix) => {
            const invalidUrl = `${prefix}${suffix}`;
            const env = createBaseEnv({
              DATABASE_URL: invalidUrl,
            });

            const result = validateEnvironment(env, true);
            const dbErrors = result.errors.filter(e => e.variable === 'DATABASE_URL');

            expect(
              dbErrors.length,
              `Expected DATABASE_URL "${invalidUrl}" to be rejected but no error was found`
            ).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('REDIS_URL accepts only redis:// or rediss:// prefixes', () => {
    it('valid REDIS_URL with redis:// prefix passes validation', () => {
      fc.assert(
        fc.property(
          arbitraryUrlSuffix(),
          (suffix) => {
            const env = createBaseEnv({
              REDIS_URL: `redis://${suffix}`,
            });

            const result = validateEnvironment(env, true);
            const redisErrors = result.errors.filter(e => e.variable === 'REDIS_URL');

            expect(redisErrors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('valid REDIS_URL with rediss:// prefix passes validation', () => {
      fc.assert(
        fc.property(
          arbitraryUrlSuffix(),
          (suffix) => {
            const env = createBaseEnv({
              REDIS_URL: `rediss://${suffix}`,
            });

            const result = validateEnvironment(env, true);
            const redisErrors = result.errors.filter(e => e.variable === 'REDIS_URL');

            expect(redisErrors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('invalid REDIS_URL with non-redis prefixes is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryInvalidRedisPrefix(),
          arbitraryUrlSuffix(),
          (prefix, suffix) => {
            const invalidUrl = `${prefix}${suffix}`;
            const env = createBaseEnv({
              REDIS_URL: invalidUrl,
            });

            const result = validateEnvironment(env, true);
            const redisErrors = result.errors.filter(e => e.variable === 'REDIS_URL');

            expect(
              redisErrors.length,
              `Expected REDIS_URL "${invalidUrl}" to be rejected but no error was found`
            ).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

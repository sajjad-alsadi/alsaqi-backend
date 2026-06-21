// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { validateProductionSecrets } from '../secretsValidator';

/**
 * Property 3: Secret Strength Validation
 *
 * **Validates: Requirements 1.4, 2.3, 2.4, 20.6**
 *
 * For any string value provided as JWT_SECRET with length < 64 characters,
 * or VITE_STORAGE_SECRET with length < 32 characters,
 * or VITE_NETWORK_SECRET matching a known weak default,
 * the Secrets_Validator SHALL classify the configuration as invalid.
 *
 * Strategy:
 * - Generate arbitrary strings shorter than 64 chars (but not matching weak defaults)
 *   and verify JWT_SECRET validation rejects them.
 * - Generate arbitrary strings shorter than 32 chars (but not matching weak defaults)
 *   and verify VITE_STORAGE_SECRET validation rejects them.
 * - Use the known weak default for VITE_NETWORK_SECRET and verify rejection regardless
 *   of other valid secrets.
 */

// Mock the logger module to prevent console output during tests
vi.mock('../logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

// ─── Known values from secretsValidator.ts ───────────────────────────────────

const WEAK_DEFAULTS = {
  JWT_SECRET: ['alsaqi-dev-secret-key-123'],
  VITE_STORAGE_SECRET: ['your-32-character-secret-key-here'],
  VITE_NETWORK_SECRET: ['your-network-hmac-secret-here'],
};

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generate a base valid env so we can test one secret at a time in isolation.
 * All secrets are strong and non-default.
 */
function createValidBaseEnv(): Record<string, string> {
  return {
    JWT_SECRET: 'x'.repeat(64),
    VITE_STORAGE_SECRET: 'y'.repeat(32),
    VITE_NETWORK_SECRET: 'a-strong-unique-network-secret-value',
  };
}

/**
 * Generate a non-empty string with length in [1, maxLen-1] that is NOT in the
 * weak defaults list for the given secret name.
 */
function shortSecretArb(maxLen: number, secretName: keyof typeof WEAK_DEFAULTS) {
  return fc
    .string({ minLength: 1, maxLength: maxLen - 1 })
    .filter((s) => s.length > 0 && !WEAK_DEFAULTS[secretName].includes(s));
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 3: Secret Strength Validation', () => {
  it('for ANY JWT_SECRET shorter than 64 characters (and not a weak default), the validator SHALL classify configuration as invalid', () => {
    fc.assert(
      fc.property(
        shortSecretArb(64, 'JWT_SECRET'),
        (shortJwtSecret) => {
          const env = createValidBaseEnv();
          env.JWT_SECRET = shortJwtSecret;

          const result = validateProductionSecrets(env);

          expect(result.isValid).toBe(false);
          expect(result.failures.some((f) => f.variable === 'JWT_SECRET')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for ANY VITE_STORAGE_SECRET shorter than 32 characters (and not a weak default), the validator SHALL classify configuration as invalid', () => {
    fc.assert(
      fc.property(
        shortSecretArb(32, 'VITE_STORAGE_SECRET'),
        (shortStorageSecret) => {
          const env = createValidBaseEnv();
          env.VITE_STORAGE_SECRET = shortStorageSecret;

          const result = validateProductionSecrets(env);

          expect(result.isValid).toBe(false);
          expect(result.failures.some((f) => f.variable === 'VITE_STORAGE_SECRET')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for ANY env where VITE_NETWORK_SECRET matches the known weak default, the validator SHALL classify configuration as invalid', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WEAK_DEFAULTS.VITE_NETWORK_SECRET),
        (weakNetworkSecret) => {
          const env = createValidBaseEnv();
          env.VITE_NETWORK_SECRET = weakNetworkSecret;

          const result = validateProductionSecrets(env);

          expect(result.isValid).toBe(false);
          expect(result.failures.some((f) => f.variable === 'VITE_NETWORK_SECRET')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for ANY JWT_SECRET matching a known weak default, the validator SHALL classify configuration as invalid regardless of length', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WEAK_DEFAULTS.JWT_SECRET),
        (weakJwtSecret) => {
          const env = createValidBaseEnv();
          env.JWT_SECRET = weakJwtSecret;

          const result = validateProductionSecrets(env);

          expect(result.isValid).toBe(false);
          expect(result.failures.some((f) => f.variable === 'JWT_SECRET')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for ANY VITE_STORAGE_SECRET matching a known weak default, the validator SHALL classify configuration as invalid regardless of length', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WEAK_DEFAULTS.VITE_STORAGE_SECRET),
        (weakStorageSecret) => {
          const env = createValidBaseEnv();
          env.VITE_STORAGE_SECRET = weakStorageSecret;

          const result = validateProductionSecrets(env);

          expect(result.isValid).toBe(false);
          expect(result.failures.some((f) => f.variable === 'VITE_STORAGE_SECRET')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

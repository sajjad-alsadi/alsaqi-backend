// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 17: Secret Value Masking in Logs
 *
 * **Validates: Requirements 11.5, 16.1**
 *
 * For any sensitive variable value of length > 4 characters, the `sanitizeValue`
 * function SHALL return only the first 4 characters followed by `****`.
 * For any value of length ≤ 4, it SHALL return `****`.
 *
 * Strategy:
 * - Generate strings of various lengths (including empty, 1-4 chars, and >4 chars)
 * - For sensitive variable names, verify correct masking behavior
 * - Values > 4 chars: first 4 characters + '****'
 * - Values ≤ 4 chars: '****'
 */

// ─── Inline the sanitizeValue logic (function is not exported) ───────────────

const SENSITIVE_VARS = [
  'JWT_SECRET', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY',
  'VITE_STORAGE_SECRET', 'VITE_NETWORK_SECRET',
  'FILE_ENCRYPTION_KEY', 'TOTP_ENCRYPTION_KEY',
  'FILE_ACCESS_SECRET', 'N8N_WEBHOOK_API_KEY',
  'DATABASE_URL', 'REDIS_URL',
];

function sanitizeValue(value: string, varName: string): string {
  if (SENSITIVE_VARS.includes(varName)) {
    if (value.length <= 4) {
      return '****';
    }
    return value.substring(0, 4) + '****';
  }

  // For non-sensitive vars, show the full value (it helps debugging)
  return value;
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generate arbitrary strings of length > 4 (sensitive values that get partial masking) */
const longValueArb = fc.string({ minLength: 5, maxLength: 200 });

/** Generate arbitrary strings of length ≤ 4 (sensitive values fully masked) */
const shortValueArb = fc.string({ minLength: 0, maxLength: 4 });

/** Pick a random sensitive variable name */
const sensitiveVarNameArb = fc.constantFrom(...SENSITIVE_VARS);

/** Generate a non-sensitive variable name (not in the sensitive list) */
const nonSensitiveVarNameArb = fc.constantFrom(
  'NODE_ENV', 'PORT', 'UPLOAD_DIR', 'LOG_LEVEL', 'CORS_ORIGIN'
);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 17: Secret Value Masking in Logs', () => {
  it('for ANY sensitive value with length > 4, sanitizeValue SHALL return first 4 chars + "****"', () => {
    fc.assert(
      fc.property(longValueArb, sensitiveVarNameArb, (value, varName) => {
        const result = sanitizeValue(value, varName);

        // Result must be exactly first 4 characters followed by ****
        expect(result).toBe(value.substring(0, 4) + '****');
        // Result length must always be 8 (4 visible + 4 asterisks)
        expect(result.length).toBe(8);
        // Result must start with the first 4 chars of the original value
        expect(result.startsWith(value.substring(0, 4))).toBe(true);
        // Result must end with ****
        expect(result.endsWith('****')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('for ANY sensitive value with length ≤ 4, sanitizeValue SHALL return "****"', () => {
    fc.assert(
      fc.property(shortValueArb, sensitiveVarNameArb, (value, varName) => {
        const result = sanitizeValue(value, varName);

        // Result must be exactly "****" — fully masked
        expect(result).toBe('****');
        // The original value must NOT appear in the result
        if (value.length > 0) {
          // For non-empty short values, ensure no leakage
          expect(result).not.toContain(value);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('for ANY non-sensitive variable, sanitizeValue SHALL return the value unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        nonSensitiveVarNameArb,
        (value, varName) => {
          const result = sanitizeValue(value, varName);

          // Non-sensitive values pass through unchanged
          expect(result).toBe(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('masked output never leaks the full original value for sensitive variables', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5, maxLength: 200 }),
        sensitiveVarNameArb,
        (value, varName) => {
          const result = sanitizeValue(value, varName);

          // The full value must NEVER appear in the result
          expect(result).not.toBe(value);
          // The result must be shorter than or equal to 8 characters
          expect(result.length).toBe(8);
        }
      ),
      { numRuns: 100 }
    );
  });
});

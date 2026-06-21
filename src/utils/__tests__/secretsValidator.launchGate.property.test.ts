// @vitest-environment node
// Feature: production-launch-readiness, Property 2
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { validateProductionSecrets } from '../secretsValidator';

/**
 * Property 2: بوابة الأسرار تفشل مغلقة (Secrets gate fails closed)
 *
 * **Validates: Requirements 1.2, 1.4, 1.5**
 *
 * For ANY combination of values for JWT_SECRET, VITE_STORAGE_SECRET and
 * VITE_NETWORK_SECRET, `validateProductionSecrets(env)` returns
 * `isValid === true` IF AND ONLY IF all three secrets pass the Audit_Spec
 * strength rules:
 *   - JWT_SECRET          : present, not a weak default, length >= 64
 *   - VITE_STORAGE_SECRET : present, not a weak default, length >= 32
 *   - VITE_NETWORK_SECRET : present, not a weak default (no minimum length)
 *
 * If any secret fails (weak default, too short, or missing/empty) the
 * configuration SHALL be classified invalid (`isValid === false`). The IFF is
 * verified in BOTH directions: valid combinations => isValid === true, and any
 * failing combination => isValid === false, with the failing variable reported.
 */

// Mock the logger to keep test output clean (validateProductionSecrets is pure,
// but the module imports the logger at load time).
vi.mock('../logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

// ─── Mirror of the rules enforced by secretsValidator.ts ─────────────────────

const WEAK_DEFAULTS: Record<string, readonly string[]> = {
  JWT_SECRET: ['alsaqi-dev-secret-key-123'],
  VITE_STORAGE_SECRET: ['your-32-character-secret-key-here'],
  VITE_NETWORK_SECRET: ['your-network-hmac-secret-here'],
};

const MIN_LENGTH: Record<string, number> = {
  JWT_SECRET: 64,
  VITE_STORAGE_SECRET: 32,
  VITE_NETWORK_SECRET: 0,
};

const SECRET_NAMES = ['JWT_SECRET', 'VITE_STORAGE_SECRET', 'VITE_NETWORK_SECRET'] as const;
type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Independent oracle: returns true iff the value passes the strength rules for
 * the given secret. This mirrors `evaluateSecret` precedence (missing →
 * weak-default → too-short) but only needs the pass/fail boolean here.
 */
function expectedPass(name: SecretName, value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  if (WEAK_DEFAULTS[name].includes(value)) return false;
  const min = MIN_LENGTH[name];
  if (min > 0 && value.length < min) return false;
  return true;
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** A strong, valid value for a secret: long enough and not a weak default. */
function strongArb(name: SecretName) {
  const min = MIN_LENGTH[name];
  return fc
    .string({ minLength: Math.max(min, 1), maxLength: min + 32 })
    .filter((s) => s.length >= min && s.length > 0 && !WEAK_DEFAULTS[name].includes(s));
}

/** A too-short value (only meaningful where a positive minimum length exists). */
function tooShortArb(name: SecretName) {
  const min = MIN_LENGTH[name];
  return fc
    .string({ minLength: 1, maxLength: Math.max(min - 1, 1) })
    .filter((s) => s.length > 0 && s.length < min && !WEAK_DEFAULTS[name].includes(s));
}

/** The known weak default(s) for a secret. */
function weakDefaultArb(name: SecretName) {
  return fc.constantFrom(...WEAK_DEFAULTS[name]);
}

/** Missing/empty: undefined or empty string. */
const missingArb = fc.constantFrom<string | undefined>(undefined, '');

/**
 * Full-spectrum value generator for one secret: mixes strong, too-short, weak
 * default and missing/empty values so any combination across the three secrets
 * can be produced. For VITE_NETWORK_SECRET there is no minimum length, so the
 * too-short category is omitted (it would otherwise be a valid short value).
 */
function valueArb(name: SecretName) {
  const options = [strongArb(name), weakDefaultArb(name), missingArb];
  if (MIN_LENGTH[name] > 0) {
    options.push(tooShortArb(name));
  }
  return fc.oneof(...options);
}

// ─── Property Test ───────────────────────────────────────────────────────────

describe('Property 2: secrets gate fails closed (validateProductionSecrets IFF)', () => {
  it('returns isValid === true IFF all three secrets pass the strength rules', () => {
    fc.assert(
      fc.property(
        valueArb('JWT_SECRET'),
        valueArb('VITE_STORAGE_SECRET'),
        valueArb('VITE_NETWORK_SECRET'),
        (jwt, storage, network) => {
          const env: Record<string, string | undefined> = {
            JWT_SECRET: jwt,
            VITE_STORAGE_SECRET: storage,
            VITE_NETWORK_SECRET: network,
          };

          const result = validateProductionSecrets(env);

          const jwtOk = expectedPass('JWT_SECRET', jwt);
          const storageOk = expectedPass('VITE_STORAGE_SECRET', storage);
          const networkOk = expectedPass('VITE_NETWORK_SECRET', network);
          const expectedValid = jwtOk && storageOk && networkOk;

          // IFF in both directions: result must agree with the oracle exactly.
          expect(result.isValid).toBe(expectedValid);

          // When invalid, every failing secret must be reported; when valid,
          // there must be no failures at all (fail-closed completeness).
          const failedVars = new Set(result.failures.map((f) => f.variable));
          if (expectedValid) {
            expect(result.failures).toHaveLength(0);
          } else {
            if (!jwtOk) expect(failedVars.has('JWT_SECRET')).toBe(true);
            if (!storageOk) expect(failedVars.has('VITE_STORAGE_SECRET')).toBe(true);
            if (!networkOk) expect(failedVars.has('VITE_NETWORK_SECRET')).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns isValid === true for ANY all-strong combination (positive direction)', () => {
    fc.assert(
      fc.property(
        strongArb('JWT_SECRET'),
        strongArb('VITE_STORAGE_SECRET'),
        strongArb('VITE_NETWORK_SECRET'),
        (jwt, storage, network) => {
          const result = validateProductionSecrets({
            JWT_SECRET: jwt,
            VITE_STORAGE_SECRET: storage,
            VITE_NETWORK_SECRET: network,
          });
          expect(result.isValid).toBe(true);
          expect(result.failures).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

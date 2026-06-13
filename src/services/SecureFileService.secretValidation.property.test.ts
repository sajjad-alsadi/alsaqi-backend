// @vitest-environment node
// Feature: backend-security-hardening, Property 17: File-access secret validation
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getFileAccessSecret, type EnvSource } from '../config/environmentConfig.js';

/**
 * Property 17: File-access secret validation
 *
 * **Validates: Requirements 9.1, 9.2**
 *
 * For any candidate `FILE_ACCESS_SECRET` value, the validator reports valid if and
 * only if the value is present, not whitespace-only, and at least 32 characters long
 * (after trimming surrounding whitespace); all other values are reported as fatal
 * configuration errors identifying `FILE_ACCESS_SECRET`.
 *
 * Target under test: the pure validation logic underlying
 * `SecureFileService.assertConfigured()` — the `getFileAccessSecret` accessor
 * (present / non-whitespace, Req 9.1) composed with the documented minimum-length
 * rule (>= 32 characters, Req 9.2). The accessor/predicate is exercised directly so
 * the property never triggers `process.exit`.
 *
 * Strategy: build generators that intentionally target each validity region of the
 * input space — unset, whitespace-only, padded short, padded boundary (exactly 32),
 * padded long, and fully-arbitrary fuzzing of the boundary.
 */

const NUM_RUNS = 100;

// Minimum acceptable trimmed length, mirroring SecureFileService.MIN_SECRET_LENGTH (Req 9.2).
const MIN_SECRET_LENGTH = 32;

/**
 * The validation rule under test, expressed via the public accessor. A candidate is
 * VALID iff `getFileAccessSecret` yields a defined (present, non-whitespace) value
 * whose length is at least the minimum. This is exactly the predicate
 * `assertConfigured` enforces before calling `process.exit`.
 */
function isFileAccessSecretValid(raw: string | undefined): boolean {
  const env: EnvSource = { FILE_ACCESS_SECRET: raw };
  const secret = getFileAccessSecret(env);
  return secret !== undefined && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * Independent oracle derived straight from the requirement text: present,
 * non-whitespace, and the trimmed value is at least 32 characters.
 */
function oracleValid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  return trimmed.length >= MIN_SECRET_LENGTH;
}

// ─── Generators targeting each region of the input space ────────────────────────

const whitespaceCharArb = fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v');

// Whitespace-only values (including the empty string) — must be rejected (Req 9.1).
const whitespaceOnlyArb = fc
  .array(whitespaceCharArb, { maxLength: 8 })
  .map((chars) => chars.join(''));

// Surrounding padding that must be ignored by trimming.
const padArb = fc.array(whitespaceCharArb, { maxLength: 4 }).map((chars) => chars.join(''));

// Non-whitespace "core" characters so the trimmed length is exactly the core length.
const coreCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}'.split(''),
);

// A non-whitespace core of a chosen length.
function coreOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc.array(coreCharArb, { minLength: min, maxLength: max }).map((chars) => chars.join(''));
}

// Padded value whose trimmed core is too short (1..31) — rejected (Req 9.2).
const paddedShortArb = fc
  .tuple(padArb, coreOfLength(1, MIN_SECRET_LENGTH - 1), padArb)
  .map(([lead, core, trail]) => `${lead}${core}${trail}`);

// Padded value whose trimmed core is exactly the boundary length (32) — accepted.
const paddedBoundaryArb = fc
  .tuple(padArb, coreOfLength(MIN_SECRET_LENGTH, MIN_SECRET_LENGTH), padArb)
  .map(([lead, core, trail]) => `${lead}${core}${trail}`);

// Padded value whose trimmed core is long (32..80) — accepted.
const paddedLongArb = fc
  .tuple(padArb, coreOfLength(MIN_SECRET_LENGTH, 80), padArb)
  .map(([lead, core, trail]) => `${lead}${core}${trail}`);

describe('Property 17: File-access secret validation', () => {
  it('rejects an unset FILE_ACCESS_SECRET', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (raw) => {
        expect(isFileAccessSecretValid(raw)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects whitespace-only values (including empty string) — Req 9.1', () => {
    fc.assert(
      fc.property(whitespaceOnlyArb, (raw) => {
        expect(isFileAccessSecretValid(raw)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects present values shorter than 32 trimmed characters — Req 9.2', () => {
    fc.assert(
      fc.property(paddedShortArb, (raw) => {
        expect(isFileAccessSecretValid(raw)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts values whose trimmed length is exactly 32 (boundary)', () => {
    fc.assert(
      fc.property(paddedBoundaryArb, (raw) => {
        expect(isFileAccessSecretValid(raw)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts values whose trimmed length is at least 32', () => {
    fc.assert(
      fc.property(paddedLongArb, (raw) => {
        expect(isFileAccessSecretValid(raw)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('reports valid iff present, non-whitespace, and >= 32 chars for any input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          whitespaceOnlyArb,
          paddedShortArb,
          paddedBoundaryArb,
          paddedLongArb,
          fc.string(),
          fc.string({ minLength: 0, maxLength: 64 }),
        ),
        (raw) => {
          expect(isFileAccessSecretValid(raw)).toBe(oracleValid(raw));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// @vitest-environment node
// Feature: production-launch-readiness, Property 1
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseStrictNodeEnv } from '../nodeEnv';

/**
 * Property Test: Strict NODE_ENV Validation (Property 1)
 *
 * Feature: production-launch-readiness
 * Property 1: التحقق الصارم من NODE_ENV (Strict NODE_ENV validation)
 *
 * **Validates: Requirements 1.3**
 *
 * For ANY string `s`, parseStrictNodeEnv(s) returns ok === true IF AND ONLY IF
 * `s` is exactly one of 'development' | 'production' | 'test'. Every other value —
 * including undefined, empty, whitespace-only, wrong-case (e.g. 'Production'), and
 * arbitrary strings — returns ok === false and is NOT silently defaulted.
 */

// ─── Domain definition ───────────────────────────────────────────────────────

/** The complete, closed set of accepted NODE_ENV values (oracle). */
const VALID_NODE_ENVS = ['development', 'production', 'test'] as const;
const VALID_SET = new Set<string>(VALID_NODE_ENVS);

/**
 * Reference oracle: a raw value is valid IF AND ONLY IF it is a string that is
 * exactly equal to one of the allowed modes.
 */
function isValidNodeEnv(raw: string | undefined): boolean {
  return raw !== undefined && VALID_SET.has(raw);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Exactly-valid values. */
const arbValid = fc.constantFrom(...VALID_NODE_ENVS);

/** Wrong-case variants of valid values (e.g. 'Production', 'TEST', 'Development'). */
const arbWrongCase = fc
  .constantFrom(...VALID_NODE_ENVS)
  .chain((base) =>
    fc.constantFrom(
      base.toUpperCase(),
      base.charAt(0).toUpperCase() + base.slice(1),
      // Mixed case toggle of the first two characters.
      base.charAt(0).toUpperCase() + base.charAt(1).toUpperCase() + base.slice(2),
    ),
  )
  // Guard: only keep variants that actually differ from the valid value.
  .filter((s) => !VALID_SET.has(s));

/** Generates a (possibly empty) run of whitespace characters as a string. */
const arbWhitespaceRun = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 4 })
  .map((chars) => chars.join(''));

/** Whitespace-padded variants of valid values (leading/trailing whitespace). */
const arbWhitespacePadded = fc
  .tuple(arbWhitespaceRun, fc.constantFrom(...VALID_NODE_ENVS), arbWhitespaceRun)
  .map(([pre, base, post]) => `${pre}${base}${post}`)
  // Guard: ensure at least some padding was added (so it differs from the valid value).
  .filter((s) => !VALID_SET.has(s));

/** Whitespace-only strings. */
const arbWhitespaceOnly = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''));

/** Arbitrary strings spanning the whole input space (may occasionally hit valid values). */
const arbAnyString = fc.string();

/** The full input space: any string, undefined, empty, whitespace, wrong-case, padded, valid. */
const arbRawInput: fc.Arbitrary<string | undefined> = fc.oneof(
  arbAnyString,
  arbValid,
  arbWrongCase,
  arbWhitespacePadded,
  arbWhitespaceOnly,
  fc.constant(''),
  fc.constant(undefined),
);

// ─── Properties ──────────────────────────────────────────────────────────────

describe('parseStrictNodeEnv — Property 1: strict NODE_ENV validation', () => {
  it('returns ok === true IFF the input is exactly an allowed mode (any input)', () => {
    fc.assert(
      fc.property(arbRawInput, (raw) => {
        const result = parseStrictNodeEnv(raw);
        const expectedOk = isValidNodeEnv(raw);

        // Core biconditional: ok mirrors membership in the allowed set exactly.
        expect(result.ok).toBe(expectedOk);

        if (result.ok) {
          // On success the value must equal the (necessarily defined) input
          // and must itself be a member of the allowed set — never defaulted.
          expect(result.value).toBe(raw);
          expect(VALID_SET.has(result.value)).toBe(true);
        } else {
          // On failure the offending input is echoed back (empty string when unset),
          // and is never silently coerced into a valid NodeEnv value.
          expect(result.received).toBe(raw === undefined ? '' : raw);
          expect(VALID_SET.has(result.received)).toBe(false);
        }
      }),
    );
  });

  it('accepts every exactly-valid value', () => {
    fc.assert(
      fc.property(arbValid, (raw) => {
        const result = parseStrictNodeEnv(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(raw);
        }
      }),
    );
  });

  it('rejects wrong-case variants without defaulting', () => {
    fc.assert(
      fc.property(arbWrongCase, (raw) => {
        const result = parseStrictNodeEnv(raw);
        expect(result.ok).toBe(false);
      }),
    );
  });

  it('rejects whitespace-padded valid values without trimming/defaulting', () => {
    fc.assert(
      fc.property(arbWhitespacePadded, (raw) => {
        const result = parseStrictNodeEnv(raw);
        expect(result.ok).toBe(false);
      }),
    );
  });

  it('rejects whitespace-only strings', () => {
    fc.assert(
      fc.property(arbWhitespaceOnly, (raw) => {
        const result = parseStrictNodeEnv(raw);
        expect(result.ok).toBe(false);
      }),
    );
  });

  it('rejects undefined (unset) and empty string with an empty `received`', () => {
    const unset = parseStrictNodeEnv(undefined);
    expect(unset.ok).toBe(false);
    if (!unset.ok) {
      expect(unset.received).toBe('');
    }

    const empty = parseStrictNodeEnv('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.received).toBe('');
    }
  });
});

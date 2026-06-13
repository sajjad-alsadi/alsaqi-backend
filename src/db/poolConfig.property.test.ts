// @vitest-environment node
// Feature: backend-security-hardening, Property 1: DATABASE_URL classification
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyDatabaseUrl } from './poolConfig.js';

/**
 * Property 1: DATABASE_URL classification
 *
 * **Validates: Requirements 1.1, 1.4**
 *
 * For any string value of `DATABASE_URL` (including unset, whitespace-only,
 * mixed-case `http://`/`https://` prefixes with surrounding whitespace, and
 * well-formed external URLs), `classifyDatabaseUrl` returns:
 *   - `missing`        for unset/whitespace-only input,
 *   - `http-url`       for any value that begins with `http://` or `https://`
 *                      after trimming surrounding whitespace and case-folding,
 *   - `valid-external` otherwise.
 *
 * Strategy: build generators that intentionally target each classification
 * region of the input space, plus an "anything" generator to fuzz the boundary.
 */

const NUM_RUNS = 100;

// Whitespace characters the classifier must treat as blank when they make up
// the entire (trimmed) value.
const whitespaceArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 8 })
  .map((chars) => chars.join(''));

// Surrounding whitespace that should be ignored by trimming.
const padArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 4 })
  .map((chars) => chars.join(''));

// Mixed-case "http"/"https" scheme, e.g. "HtTp", "HTTPS".
function mixedCaseScheme(base: string): fc.Arbitrary<string> {
  return fc
    .tuple(...[...base].map((ch) => fc.boolean().map((up) => (up ? ch.toUpperCase() : ch.toLowerCase()))))
    .map((parts) => parts.join(''));
}

// The "rest of the URL" after the scheme: any string without whitespace so the
// trimmed value still begins with the http(s) prefix.
const urlRestArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-/:@_'.split('')), {
    minLength: 1,
    maxLength: 40,
  })
  .map((chars) => chars.join(''));

const httpUrlArb = fc
  .tuple(
    padArb,
    fc.constantFrom('http', 'https').chain(mixedCaseScheme),
    urlRestArb,
    padArb,
  )
  .map(([lead, scheme, rest, trail]) => `${lead}${scheme}://${rest}${trail}`);

// External (non-http) connection strings: postgres/postgresql/anything without
// an http(s) prefix.
const hostArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-'.split('')), {
    minLength: 1,
    maxLength: 20,
  })
  .map((chars) => chars.join(''));

const externalArb = fc.oneof(
  fc
    .tuple(fc.constantFrom('postgres', 'postgresql'), hostArb, fc.integer({ min: 1, max: 65535 }))
    .map(([scheme, host, port]) => `${scheme}://user:pass@${host}:${port}/dbname`),
  // Arbitrary non-empty strings that do not begin with an http(s) prefix.
  fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => s.trim().length > 0 && !/^\s*https?:\/\//i.test(s)),
);

describe('classifyDatabaseUrl (Property 1)', () => {
  it('returns "missing" for undefined input', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (raw) => {
        const result = classifyDatabaseUrl(raw);
        expect(result.kind).toBe('missing');
        expect(result.normalized).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns "missing" for whitespace-only input', () => {
    fc.assert(
      fc.property(whitespaceArb, (raw) => {
        const result = classifyDatabaseUrl(raw);
        expect(result.kind).toBe('missing');
        expect(result.normalized).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns "http-url" for any http/https value (mixed case, padded)', () => {
    fc.assert(
      fc.property(httpUrlArb, (raw) => {
        const result = classifyDatabaseUrl(raw);
        expect(result.kind).toBe('http-url');
        // Normalized value is the trimmed input.
        expect(result.normalized).toBe(raw.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns "valid-external" for non-empty, non-http values', () => {
    fc.assert(
      fc.property(externalArb, (raw) => {
        const result = classifyDatabaseUrl(raw);
        expect(result.kind).toBe('valid-external');
        expect(result.normalized).toBe(raw.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('classifies any string consistently with the trim + case-fold rule', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), httpUrlArb, externalArb, whitespaceArb), (raw) => {
        const result = classifyDatabaseUrl(raw);
        const trimmed = raw.trim();
        const lower = trimmed.toLowerCase();

        if (trimmed === '') {
          expect(result.kind).toBe('missing');
          expect(result.normalized).toBeNull();
        } else if (lower.startsWith('http://') || lower.startsWith('https://')) {
          expect(result.kind).toBe('http-url');
          expect(result.normalized).toBe(trimmed);
        } else {
          expect(result.kind).toBe('valid-external');
          expect(result.normalized).toBe(trimmed);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

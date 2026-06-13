/**
 * Property-based tests for the path-gate helpers (`src/middleware/pathGate.ts`).
 *
 * Spec: .kiro/specs/backend-security-hardening (task 4.2)
 *
 * Feature: backend-security-hardening, Property 4: Path canonicalization
 *
 * Property 4 (Validates: Requirements 3.3):
 *   For any request path string, `canonicalizePath` produces a path that is
 *   percent-decoded, has all `.` and `..` segments resolved, and has at most a
 *   single trailing slash removed (the root `/` is preserved).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { canonicalizePath } from './pathGate';

const NUM_RUNS = 300;

/**
 * Split a canonical path into its non-root segments. The canonical form is
 * always rooted, so the leading '/' is dropped before splitting. The root path
 * '/' yields an empty segment list.
 */
function segmentsOf(canonical: string): string[] {
  const body = canonical.slice(1); // drop the single leading '/'
  return body === '' ? [] : body.split('/');
}

/**
 * A generator of "interesting" raw path inputs. It mixes ordinary segments with
 * the dot/dot-dot navigation markers, their percent-encoded equivalents, empty
 * segments (duplicate slashes), backslashes, and arbitrary text so the property
 * exercises the full input space the gate must canonicalize safely.
 */
const rawSegment = fc.oneof(
  fc.constantFrom(
    'auth',
    'logout',
    'login',
    'users',
    'change-password',
    '.',
    '..',
    '', // produces duplicate / leading / trailing slashes when joined
    '%2e', // encoded '.'
    '%2E',
    '%2e%2e', // encoded '..'
    '%2E%2E',
    'logout%2Devil', // encoded '-' so decoding cannot fabricate a boundary
    'a%2fb', // encoded '/'
  ),
  // Arbitrary text, including characters that exercise the decoder.
  fc.string(),
);

const rawPath = fc
  .array(rawSegment, { maxLength: 8 })
  .chain((segs) =>
    fc.tuple(
      fc.constant(segs),
      fc.boolean(), // leading slash?
      fc.constantFrom('', '/', '//', '///'), // optional trailing slashes
    ),
  )
  .map(([segs, lead, trail]) => (lead ? '/' : '') + segs.join('/') + trail);

describe('Feature: backend-security-hardening, Property 4: Path canonicalization', () => {
  it('always returns a rooted path beginning with a single leading slash', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const out = canonicalizePath(raw);
        expect(out.startsWith('/')).toBe(true);
        expect(out.startsWith('//')).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('resolves away all "." and ".." segments (none survive in the output)', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const out = canonicalizePath(raw);
        for (const seg of segmentsOf(out)) {
          expect(seg).not.toBe('.');
          expect(seg).not.toBe('..');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('removes empty segments so the output never contains duplicate slashes', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const out = canonicalizePath(raw);
        expect(out.includes('//')).toBe(false);
        for (const seg of segmentsOf(out)) {
          expect(seg).not.toBe('');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('strips trailing slashes while preserving the root path "/"', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const out = canonicalizePath(raw);
        if (out !== '/') {
          expect(out.endsWith('/')).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is idempotent: canonicalizing a canonical path returns it unchanged', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const once = canonicalizePath(raw);
        const twice = canonicalizePath(once);
        expect(twice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('percent-decodes the path so encoded dot segments are resolved, not kept literally', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('auth', 'users', 'x'), { minLength: 1, maxLength: 4 }),
        (segs) => {
          // Build a path whose encoded "." / ".." segments must be decoded and
          // then resolved; a single decode pass must not leave them literal.
          const encoded = '/' + segs.join('/') + '/%2e/%2e%2e';
          const out = canonicalizePath(encoded);
          // The encoded "." and ".." cancel the preceding "%2e" navigation, so
          // the trailing markers must not appear verbatim in the result.
          expect(out.includes('%2e')).toBe(false);
          expect(out.includes('%2E')).toBe(false);
          for (const seg of segmentsOf(out)) {
            expect(seg).not.toBe('.');
            expect(seg).not.toBe('..');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws on malformed percent-encoding or unusual input', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => canonicalizePath(raw)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

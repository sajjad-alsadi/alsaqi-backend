// @vitest-environment node
// Feature: backend-security-hardening, Property 5: Allowed-path matching is exact or segment-boundary prefix only
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isPathAllowed } from '../pathGate';

/**
 * Property 5: Allowed-path matching is exact or segment-boundary prefix only
 *
 * **Validates: Requirements 3.1, 3.2, 3.4**
 *
 * For any canonical path and allowed-paths list, `isPathAllowed` returns true
 * exactly when the path equals an entry or extends an entry at a path-separator
 * boundary, and returns false for substring-but-not-segment matches (for example
 * `/auth/logout-evil` against `/auth/logout`); it never consults query strings or
 * `originalUrl`.
 */

// ─── Reference oracle ────────────────────────────────────────────────────────

/**
 * Independent specification of the intended semantics: a path is allowed iff
 * some entry matches it exactly OR the path extends the entry at a '/' boundary.
 * This is deliberately written separately from the implementation so the test
 * exercises the spec rather than the code's own logic.
 */
function oracleAllowed(canonicalPath: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some(
    (entry) => canonicalPath === entry || canonicalPath.startsWith(entry + '/'),
  );
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A single non-empty path segment (no slashes), biased toward auth-relevant names. */
const segmentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('auth', 'logout', 'login', 'password', 'change', 'refresh', 'session', 'users', 'files'),
  fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((s) => !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..' && s.trim().length > 0),
);

/** A canonical-looking rooted path built from 1..4 segments, e.g. "/auth/logout". */
const canonicalPathArb: fc.Arbitrary<string> = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segs) => '/' + segs.join('/'));

/** A list of 1..5 allowed paths. */
const allowedPathsArb: fc.Arbitrary<string[]> = fc.array(canonicalPathArb, {
  minLength: 1,
  maxLength: 5,
});

/** A character that is NOT a path separator, used to forge non-segment suffixes. */
const nonSlashCharArb: fc.Arbitrary<string> = fc.constantFrom('-', '_', 'x', '.', '%', 'a', '1', '~');

describe('Property 5: Allowed-path matching is exact or segment-boundary prefix only', () => {
  it('matches the exact/segment-boundary oracle for arbitrary paths and lists', () => {
    fc.assert(
      fc.property(canonicalPathArb, allowedPathsArb, (path, allowed) => {
        expect(isPathAllowed(path, allowed)).toBe(oracleAllowed(path, allowed));
      }),
      { numRuns: 500 },
    );
  });

  it('always allows an exact match against any entry', () => {
    fc.assert(
      fc.property(allowedPathsArb, (allowed) => {
        for (const entry of allowed) {
          expect(isPathAllowed(entry, allowed)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('allows any path that extends an entry at a "/" boundary', () => {
    fc.assert(
      fc.property(canonicalPathArb, segmentArb, (base, extra) => {
        const extended = base + '/' + extra;
        expect(isPathAllowed(extended, [base])).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects substring-but-not-segment extensions (e.g. /auth/logout-evil vs /auth/logout)', () => {
    fc.assert(
      fc.property(canonicalPathArb, nonSlashCharArb, fc.string({ maxLength: 6 }), (base, sep, tail) => {
        const forged = base + sep + tail; // next char after entry is NOT '/'
        // Only meaningful when the forged path is genuinely longer than the entry
        // and not coincidentally equal to it.
        if (forged === base) return;
        expect(isPathAllowed(forged, [base])).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects strict prefixes of an allowed entry', () => {
    fc.assert(
      fc.property(canonicalPathArb, segmentArb, (base, extra) => {
        const allowed = base + '/' + extra; // longer entry
        // `base` is a strict prefix of `allowed` but not allowed itself.
        expect(isPathAllowed(base, [allowed])).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('never treats query-string-like content as part of the matched path', () => {
    fc.assert(
      fc.property(canonicalPathArb, canonicalPathArb, (deniedBase, allowedEntry) => {
        // A non-allowed route that embeds an allowed path inside a query string
        // must NOT match, because isPathAllowed only sees the canonical path.
        const withQuery = `${deniedBase}?x=${allowedEntry}`;
        fc.pre(withQuery !== allowedEntry && !withQuery.startsWith(allowedEntry + '/'));
        expect(isPathAllowed(withQuery, [allowedEntry])).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  // ── Concrete regression cases called out by the spec ──────────────────────
  it('denies the documented /auth/logout-evil bypass attempt', () => {
    expect(isPathAllowed('/auth/logout-evil', ['/auth/logout'])).toBe(false);
  });

  it('allows the exact logout route and segment-boundary children', () => {
    expect(isPathAllowed('/auth/logout', ['/auth/logout'])).toBe(true);
    expect(isPathAllowed('/auth/logout/all', ['/auth/logout'])).toBe(true);
  });

  it('returns false against an empty allowed-paths list', () => {
    fc.assert(
      fc.property(canonicalPathArb, (path) => {
        expect(isPathAllowed(path, [])).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

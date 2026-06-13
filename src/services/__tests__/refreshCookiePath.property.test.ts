// @vitest-environment node
// Feature: backend-security-hardening, Property 27: Refresh cookie path normalization
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildRefreshCookiePath,
  DEFAULT_API_PREFIX,
  DEFAULT_REFRESH_ROUTE,
} from '../refreshCookiePath';

/**
 * Property 27: Refresh cookie path normalization
 *
 * **Validates: Requirements 19.1, 19.3, 19.4**
 *
 * For any configured API prefix value (including absent, empty, or whitespace-only,
 * a missing leading slash, trailing slashes, or internal duplicate slashes), the
 * refresh cookie path equals the normalization of the prefix combined with the
 * refresh route, where:
 *   - an absent/empty/whitespace prefix falls back to the default prefix (Req 19.3);
 *   - the result begins with exactly one leading "/" (Req 19.4);
 *   - the result contains no trailing "/" except the root "/" (Req 19.4);
 *   - the result equals the prefix combined with the refresh route, scoped to where
 *     the refresh endpoint is served (Req 19.1).
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Path segments built from URL-path-safe characters. Kept free of slashes so the
 * test controls slash placement explicitly via separators below.
 */
const segmentArb = fc.stringMatching(/^[A-Za-z0-9._~-]+$/);

/**
 * Runs of slashes (1..4) used to inject leading, trailing, and internal duplicate
 * slashes into the generated prefix, exercising the normalization rules.
 */
const slashesArb = fc.integer({ min: 1, max: 4 }).map((n) => '/'.repeat(n));

/**
 * A "shaped" prefix: 1..4 segments joined by arbitrary slash runs, with optional
 * leading and trailing slash runs (or none, to cover the missing-leading-slash case).
 */
const shapedPrefixArb = fc
  .tuple(
    fc.option(slashesArb, { nil: '' }),
    fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
    fc.option(slashesArb, { nil: '' }),
  )
  .chain(([lead, segs, trail]) =>
    fc
      .array(slashesArb, { minLength: segs.length - 1, maxLength: segs.length - 1 })
      .map((seps) => {
        let body = segs[0];
        for (let i = 1; i < segs.length; i++) {
          body += seps[i - 1] + segs[i];
        }
        return lead + body + trail;
      }),
  );

/** Absent/empty/whitespace-only prefixes that must fall back to the default. */
const blankPrefixArb = fc.oneof(
  fc.constant(undefined as string | undefined),
  fc.constant(null as unknown as string | undefined),
  fc.constant(''),
  fc.stringMatching(/^[ \t\n\r]+$/),
);

/** Any prefix value: a well-formed-but-messy prefix, or a blank/absent one. */
const anyPrefixArb = fc.oneof(shapedPrefixArb, blankPrefixArb);

/** A refresh route, possibly with leading/trailing/duplicate slashes. */
const routeArb = fc
  .tuple(
    fc.option(slashesArb, { nil: '' }),
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
    fc.option(slashesArb, { nil: '' }),
  )
  .chain(([lead, segs, trail]) =>
    fc
      .array(slashesArb, { minLength: segs.length - 1, maxLength: segs.length - 1 })
      .map((seps) => {
        let body = segs[0];
        for (let i = 1; i < segs.length; i++) {
          body += seps[i - 1] + segs[i];
        }
        return lead + body + trail;
      }),
  );

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Reference normalization, independent of the implementation under test. */
function referenceNormalize(prefix: string | null | undefined, route: string): string {
  const usablePrefix =
    typeof prefix === 'string' && prefix.trim().length > 0 ? prefix.trim() : DEFAULT_API_PREFIX;
  let path = `${usablePrefix}/${route}`.trim().replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path.length === 0 ? '/' : path;
}

// ─── Property ────────────────────────────────────────────────────────────────

describe('Property 27: Refresh cookie path normalization', () => {
  it('normalizes any prefix/route to one leading slash, no trailing slash, no duplicate slashes (Req 19.1, 19.3, 19.4)', () => {
    fc.assert(
      fc.property(anyPrefixArb, routeArb, (prefix, route) => {
        const result = buildRefreshCookiePath(prefix, route);

        // Exactly one leading slash (Req 19.4).
        expect(result.startsWith('/')).toBe(true);
        expect(result.startsWith('//')).toBe(false);

        // No internal duplicate slashes (Req 19.4).
        expect(result).not.toMatch(/\/{2,}/);

        // No trailing slash except the root "/" (Req 19.4).
        if (result.length > 1) {
          expect(result.endsWith('/')).toBe(false);
        }

        // Result equals prefix-combined-with-route normalization (Req 19.1, 19.3).
        expect(result).toBe(referenceNormalize(prefix, route));

        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('falls back to the default prefix for absent/empty/whitespace-only prefixes (Req 19.3)', () => {
    fc.assert(
      fc.property(blankPrefixArb, (prefix) => {
        const result = buildRefreshCookiePath(prefix);
        const expected = buildRefreshCookiePath(DEFAULT_API_PREFIX, DEFAULT_REFRESH_ROUTE);
        expect(result).toBe(expected);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

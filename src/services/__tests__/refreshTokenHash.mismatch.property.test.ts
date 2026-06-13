// @vitest-environment node
// Feature: backend-security-hardening, Property 25: Refresh-token mismatch rejection
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  hashRefreshToken,
  hashPresentedRefreshToken,
  refreshTokenMatchesHash,
  MAX_REFRESH_TOKEN_LENGTH,
} from '../refreshTokenHash';

/**
 * Property 25: Refresh-token mismatch rejection
 *
 * **Validates: Requirements 17.3**
 *
 * For any presented refresh token whose SHA-256 hash does not match the stored
 * hash, the refresh request is rejected (the comparison helper returns `false`),
 * so callers never issue new tokens or mutate session state.
 *
 * Concretely, for any two distinct tokens A and B:
 *   refreshTokenMatchesHash(A, hashRefreshToken(B)) === false
 *
 * Additionally, absent/empty/over-MAX_REFRESH_TOKEN_LENGTH presented tokens are
 * rejected without a meaningful match: `hashPresentedRefreshToken` returns `null`
 * and `refreshTokenMatchesHash` returns `false` regardless of the stored hash.
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** Non-empty plaintext refresh tokens within the hashable length bound. */
const validTokenArb = fc
  .string({ minLength: 1, maxLength: 256 })
  .filter((s) => s.length > 0 && s.length <= MAX_REFRESH_TOKEN_LENGTH);

/** A pair of distinct valid tokens. */
const distinctTokenPairArb = fc
  .tuple(validTokenArb, validTokenArb)
  .filter(([a, b]) => a !== b);

/** Presented tokens that are NOT hashable (absent/empty/over-length/non-string). */
const nonHashableTokenArb = fc.oneof(
  fc.constant(''),
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
  // Over the maximum length bound.
  fc
    .integer({ min: MAX_REFRESH_TOKEN_LENGTH + 1, max: MAX_REFRESH_TOKEN_LENGTH + 64 })
    .map((len) => 'x'.repeat(len)),
);

describe('Property 25: Refresh-token mismatch rejection', () => {
  it('rejects a presented token that does not hash to the stored hash', () => {
    fc.assert(
      fc.property(distinctTokenPairArb, ([presented, other]) => {
        const storedHash = hashRefreshToken(other);
        expect(refreshTokenMatchesHash(presented, storedHash)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('accepts only the original token against its own stored hash (sanity counterpart)', () => {
    fc.assert(
      fc.property(validTokenArb, (token) => {
        const storedHash = hashRefreshToken(token);
        expect(refreshTokenMatchesHash(token, storedHash)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects absent/empty/over-length presented tokens without a meaningful match', () => {
    fc.assert(
      fc.property(nonHashableTokenArb, validTokenArb, (presented, otherToken) => {
        // hashPresentedRefreshToken returns null for non-hashable input (no real hash computed).
        expect(hashPresentedRefreshToken(presented as unknown)).toBeNull();
        // And the comparison rejects regardless of the stored hash value.
        const storedHash = hashRefreshToken(otherToken);
        expect(refreshTokenMatchesHash(presented as unknown, storedHash)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

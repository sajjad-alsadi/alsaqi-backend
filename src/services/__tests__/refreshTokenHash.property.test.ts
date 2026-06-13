// @vitest-environment node
// Feature: backend-security-hardening, Property 24: Refresh-token hashing round trip
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import crypto from 'crypto';
import {
  hashRefreshToken,
  refreshTokenMatchesHash,
  MAX_REFRESH_TOKEN_LENGTH,
} from '../refreshTokenHash';

/**
 * Property 24: Refresh-token hashing round trip
 *
 * **Validates: Requirements 17.1, 17.2**
 *
 * For any valid refresh token:
 *   1. `hashRefreshToken` is deterministic — the same input always produces the
 *      same SHA-256 hex digest (Req 17.1).
 *   2. The persisted value equals the SHA-256 hex digest of the token and is never
 *      the plaintext token itself (Req 17.1).
 *   3. Validating a presented token by hashing it and comparing full-length against
 *      the stored hash succeeds for the original token, i.e.
 *      `refreshTokenMatchesHash(token, hashRefreshToken(token)) === true` (Req 17.2).
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * A valid refresh token: any non-empty string within the accepted length bound.
 * fast-check's `fc.string` exercises unicode, control characters, and multi-byte
 * sequences, so the round trip is validated across the full hashable input space.
 */
const validTokenArb = fc.string({ minLength: 1, maxLength: MAX_REFRESH_TOKEN_LENGTH });

// ─── Property ────────────────────────────────────────────────────────────────

describe('Property 24: Refresh-token hashing round trip', () => {
  it('is deterministic and round-trips: matches(token, hash(token)) === true (Req 17.1, 17.2)', () => {
    fc.assert(
      fc.property(validTokenArb, (token) => {
        const hash = hashRefreshToken(token);

        // (1) Deterministic: same input -> same hash (Req 17.1)
        expect(hashRefreshToken(token)).toBe(hash);

        // (2) Persisted value is the SHA-256 hex digest, never the plaintext (Req 17.1)
        const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
        expect(hash).toBe(expected);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);

        // (3) Round trip: presented token validates against its stored hash (Req 17.2)
        expect(refreshTokenMatchesHash(token, hash)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

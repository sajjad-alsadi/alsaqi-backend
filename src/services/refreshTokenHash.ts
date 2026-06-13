import crypto from 'crypto';

/**
 * Refresh-token hashing at rest (Requirement 17).
 *
 * Refresh tokens are persisted only as SHA-256 hashes so that a database disclosure
 * does not expose usable session credentials. The plaintext token is returned to the
 * client (in an httpOnly cookie) but is never stored or logged in plaintext.
 *
 * Requirements:
 * - 17.1 Persist a SHA-256 hash of the token; never store/log/transmit plaintext at rest.
 * - 17.2 Validate by hashing the presented token and comparing full-length for an exact match.
 * - 17.3 A non-matching hash is rejected without issuing new tokens (handled by callers).
 * - 17.4 Absent/empty/>4096-char tokens are rejected WITHOUT computing or comparing a hash.
 * - 17.5 If hashing fails while persisting, abort persistence without storing plaintext.
 */

/** Maximum accepted refresh-token length. Tokens longer than this are rejected un-hashed (Req 17.4). */
export const MAX_REFRESH_TOKEN_LENGTH = 4096;

/**
 * Returns true when the presented refresh token is structurally acceptable for hashing.
 *
 * A token is acceptable only when it is a non-empty string no longer than
 * {@link MAX_REFRESH_TOKEN_LENGTH} characters. Absent (null/undefined/non-string), empty,
 * and over-length tokens are rejected WITHOUT any hashing (Req 17.4).
 *
 * @param token - The presented refresh token, which may be absent or malformed.
 * @returns `true` when the token may be hashed, otherwise `false`.
 */
export function isHashableRefreshToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= MAX_REFRESH_TOKEN_LENGTH
  );
}

/**
 * Computes the SHA-256 hex digest of a refresh token (Req 17.1, 17.2).
 *
 * The token is first validated as hashable (Req 17.4); absent, empty, or over-length tokens
 * are rejected by throwing rather than being hashed. Any failure of the underlying hashing
 * primitive is propagated so callers can abort persistence without storing plaintext (Req 17.5).
 *
 * @param token - The plaintext refresh token to hash.
 * @returns The lowercase SHA-256 hex digest (64 characters) of the token.
 * @throws {Error} When the token is absent, empty, exceeds {@link MAX_REFRESH_TOKEN_LENGTH},
 *                 or when the hashing primitive itself fails.
 */
export function hashRefreshToken(token: unknown): string {
  if (!isHashableRefreshToken(token)) {
    throw new Error('Refresh token is absent, empty, or exceeds the maximum length');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Computes the hash of a presented refresh token for validation, returning `null` when the
 * token is not hashable (absent/empty/over-length) so callers can reject it WITHOUT hashing
 * having been attempted on an invalid input (Req 17.4).
 *
 * @param token - The presented refresh token, which may be absent or malformed.
 * @returns The SHA-256 hex digest, or `null` when the token is not hashable.
 */
export function hashPresentedRefreshToken(token: unknown): string | null {
  if (!isHashableRefreshToken(token)) {
    return null;
  }
  return hashRefreshToken(token);
}

/**
 * Compares the hash of a presented refresh token against a stored hash for an exact,
 * full-length match (Req 17.2). Absent/empty/over-length presented tokens never match and
 * are rejected without a meaningful hash comparison (Req 17.4).
 *
 * The comparison is constant-time over equal-length inputs to avoid leaking information via
 * timing; lengths are compared first because the stored value is a fixed-width SHA-256 hex.
 *
 * @param presentedToken - The plaintext refresh token presented by the client.
 * @param storedHash - The SHA-256 hex hash retrieved from persistent storage.
 * @returns `true` when the presented token hashes to exactly the stored hash, otherwise `false`.
 */
export function refreshTokenMatchesHash(presentedToken: unknown, storedHash: unknown): boolean {
  const computed = hashPresentedRefreshToken(presentedToken);
  if (computed === null || typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }
  if (computed.length !== storedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(storedHash, 'utf8'));
}

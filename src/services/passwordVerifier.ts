import bcrypt from 'bcryptjs';

/**
 * Non-blocking password verification helpers.
 *
 * This module centralizes password comparison for the Auth_Service so that login
 * never stalls the event loop and so that unknown accounts are still subjected to a
 * comparison of equivalent cost (anti-enumeration / timing safety).
 *
 * Requirements:
 * - 14.1 Always use the asynchronous bcrypt comparison; never `compareSync`.
 * - 14.2 The comparison is awaited, yielding the event loop until it resolves.
 * - 15.1 Unknown accounts are compared against a fixed dummy hash that uses the same
 *        bcrypt cost factor configured for stored user password hashes.
 * - 15.5 Comparison failures surface as a rejected promise so the caller can return a
 *        uniform generic failure without revealing account existence.
 */

/**
 * The bcrypt cost factor used for stored user password hashes across the service
 * (see `UserService`, `PasswordService`, and the seed migration, all of which hash at 12).
 *
 * The dummy-hash comparison performed for unknown accounts MUST use this same cost factor
 * so that its timing matches a real comparison (Req 15.1).
 */
const BCRYPT_COST_FACTOR = 12;

/** Returns the bcrypt cost factor configured for stored password hashes. Req 15.1. */
export function bcryptCostFactor(): number {
  return BCRYPT_COST_FACTOR;
}

/**
 * A fixed, valid bcrypt hash generated at {@link BCRYPT_COST_FACTOR}.
 *
 * Used as the comparison target when a login references an account that does not exist,
 * so that the work performed (and therefore the response time) matches that of a real
 * password verification, defeating account enumeration via timing (Req 15.1).
 *
 * This is a hash of an internal placeholder value; it intentionally never matches any
 * user-supplied password.
 */
export const DUMMY_HASH = '$2b$12$tFOk2VHwkUPOwX2V5S/yAuRFtaGaRcRzviyDgTNRdKyMX7dpwSwtm';

/**
 * Verifies a plaintext password against a bcrypt hash using the asynchronous bcrypt
 * comparison, yielding control of the event loop until the comparison resolves.
 *
 * Always uses `bcrypt.compare` (asynchronous) and never `bcrypt.compareSync`, so that
 * concurrent verifications do not block the event loop (Req 14.1, 14.2).
 *
 * @param plain - The plaintext password supplied by the caller.
 * @param hash - The stored bcrypt hash (or {@link DUMMY_HASH} for unknown accounts).
 * @returns A promise resolving to `true` when the password matches the hash, otherwise `false`.
 * @throws Propagates any error thrown by the bcrypt comparison so the caller can map it to a
 *         uniform generic failure (Req 15.5) and roll back the enclosing transaction (Req 14.5).
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

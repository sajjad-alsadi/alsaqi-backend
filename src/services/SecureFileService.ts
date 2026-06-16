import crypto from 'crypto';
import logger from '../utils/logger';
import {
  getFileAccessSecret,
  getFileSignedUrlMaxTtlS,
  getFileEncryptionKey,
  getTotpEncryptionKey,
} from '../config/environmentConfig';

/**
 * Minimum TTL: 5 minutes (in seconds)
 */
const MIN_TTL = 5 * 60;

/**
 * Default TTL: 60 minutes (in seconds). Always clamped down to the configured
 * maximum so an issued URL can never exceed the maximum TTL (Req 11.4).
 */
const DEFAULT_TTL = 60 * 60;

/**
 * Minimum acceptable length of FILE_ACCESS_SECRET in characters (Req 9.2).
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Result of signed URL verification.
 */
export interface SignedUrlVerificationResult {
  valid: boolean;
  expired?: boolean;
  reason?: string;
}

/**
 * SecureFileService provides signed URL generation and verification
 * for time-limited file access without requiring authentication.
 *
 * Uses HMAC-SHA256 signatures bound to filePath + userId + expiry.
 * Verification uses crypto.timingSafeEqual to prevent timing attacks.
 *
 * The signing/verifying secret is the dedicated `FILE_ACCESS_SECRET` only —
 * there is no JWT-secret or hardcoded fallback (Req 9.3, 9.4). The secret is
 * asserted at startup via `assertConfigured()` (Req 9.1, 9.2), and every issued
 * URL is capped at the configured maximum TTL of 900 seconds (Req 11.4).
 *
 * Requirements: 9.3, 9.4, 9.5, 11.4
 */
export class SecureFileService {
  /**
   * Returns the dedicated file-access signing secret. Reads `FILE_ACCESS_SECRET`
   * only — there is no JWT-secret or hardcoded/default fallback (Req 9.3, 9.4).
   *
   * @throws Error when `FILE_ACCESS_SECRET` is unset, empty, or whitespace-only.
   *   Startup validation via {@link assertConfigured} guarantees this never
   *   throws once the process has begun serving requests.
   */
  private static requireSecret(): string {
    const secret = getFileAccessSecret();
    if (!secret) {
      throw new Error(
        'FILE_ACCESS_SECRET is not configured. The Secure File Service cannot sign or verify file-access URLs.'
      );
    }
    return secret;
  }

  /**
   * Fail-fast startup assertion for the dedicated file-access secret and the
   * at-rest encryption keys.
   *
   * Writes a fatal configuration error and terminates the process with a
   * non-zero exit code when `FILE_ACCESS_SECRET` is unset/whitespace-only
   * (Req 9.1) or shorter than the minimum length (Req 9.2).
   *
   * Additionally, when running in production, asserts that both
   * `FILE_ENCRYPTION_KEY` and `TOTP_ENCRYPTION_KEY` are present so files (and
   * persisted TOTP secrets) are never written plaintext due to a missing key
   * (Req 2.11). A missing key is fatal in production — failing fast exactly like
   * `FILE_ACCESS_SECRET` — rather than a silent warning. Outside production the
   * keys are not required, so dev/test boot is preserved.
   *
   * Intended to be called during the startup sequence before any port binding.
   */
  static assertConfigured(): void {
    const secret = getFileAccessSecret();

    if (!secret) {
      logger.error(
        'FATAL: FILE_ACCESS_SECRET is not configured. Set a dedicated file-access secret of at least ' +
          `${MIN_SECRET_LENGTH} characters before starting the service.`
      );
      process.exit(1);
    }

    if (secret.length < MIN_SECRET_LENGTH) {
      logger.error(
        `FATAL: FILE_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters; ` +
          `received a value of length ${secret.length}.`
      );
      process.exit(1);
    }

    // Encryption-at-rest keys (Req 2.11). Asserted in production only so a
    // missing key fails fast instead of silently disabling encryption (files
    // written plaintext). Dev/test environments do not require these keys.
    if (process.env.NODE_ENV === 'production') {
      if (!getFileEncryptionKey()) {
        logger.error(
          'FATAL: FILE_ENCRYPTION_KEY is not configured. Set a dedicated file-encryption key ' +
            'before starting the service so uploaded files are never written plaintext.'
        );
        process.exit(1);
      }

      if (!getTotpEncryptionKey()) {
        logger.error(
          'FATAL: TOTP_ENCRYPTION_KEY is not configured. Set a dedicated TOTP-encryption key ' +
            'before starting the service so persisted TOTP secrets are never written plaintext.'
        );
        process.exit(1);
      }
    }
  }

  /**
   * Clamps the TTL value to the allowed range [5 minutes, configured maximum].
   * The maximum is read from the typed environment config and never exceeds
   * 900 seconds (Req 11.4). Returns the default TTL (clamped to the maximum)
   * when no value is provided.
   */
  static clampTtl(ttl?: number): number {
    const maxTtl = getFileSignedUrlMaxTtlS();

    // The configured maximum is a hard upper bound that must ALWAYS bind
    // (Req 11.4). We clamp up to MIN_TTL first, then cap to maxTtl so that
    // when maxTtl < MIN_TTL the result is maxTtl and never exceeds it.
    const effectiveTtl = ttl === undefined || ttl === null ? DEFAULT_TTL : ttl;
    return Math.min(Math.max(effectiveTtl, MIN_TTL), maxTtl);
  }

  /**
   * Generates a signed URL for temporary file access.
   *
   * @param filePath - The file path relative to the uploads directory
   * @param userId - The ID of the user generating the signed URL
   * @param ttl - Time-to-live in seconds (default: 3600, min: 300, max: 900)
   * @returns The signed URL path with query parameters (expires, userId, sig)
   */
  static generateSignedUrl(filePath: string, userId: string, ttl?: number): string {
    const clampedTtl = this.clampTtl(ttl);
    const expires = Math.floor(Date.now() / 1000) + clampedTtl;
    const signature = this.computeSignature(filePath, userId, expires);

    const encodedPath = encodeURIComponent(filePath);
    return `/api/v1/files/${encodedPath}?expires=${expires}&userId=${encodeURIComponent(userId)}&sig=${signature}`;
  }

  /**
   * Verifies a signed URL is valid and not expired.
   *
   * Uses timing-safe comparison to prevent timing attacks on the signature.
   * Returns a structured result indicating validity and reason for rejection.
   *
   * @param filePath - The file path from the URL
   * @param userId - The user ID from the URL query parameter
   * @param expires - The expiry timestamp from the URL query parameter
   * @param signature - The signature from the URL query parameter
   * @returns Verification result with valid flag and optional reason
   */
  static verifySignedUrl(
    filePath: string,
    userId: string,
    expires: number,
    signature: string
  ): SignedUrlVerificationResult {
    // Check expiration first
    const now = Math.floor(Date.now() / 1000);
    if (now > expires) {
      return { valid: false, expired: true, reason: 'URL has expired' };
    }

    // Compute expected signature using the current FILE_ACCESS_SECRET (Req 9.5)
    const expectedSignature = this.computeSignature(filePath, userId, expires);

    // Use timing-safe comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    // If lengths differ, the signature is invalid (timingSafeEqual requires equal lengths)
    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, expired: false, reason: 'Invalid signature' };
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      return { valid: false, expired: false, reason: 'Invalid signature' };
    }

    return { valid: true };
  }

  /**
   * Computes the HMAC-SHA256 signature for the given parameters.
   * The signature is bound to filePath + userId + expiry and is keyed with the
   * dedicated `FILE_ACCESS_SECRET` (Req 9.4).
   */
  private static computeSignature(filePath: string, userId: string, expires: number): string {
    const payload = `${filePath}:${userId}:${expires}`;
    return crypto
      .createHmac('sha256', this.requireSecret())
      .update(payload)
      .digest('hex');
  }
}

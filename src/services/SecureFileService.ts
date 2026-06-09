import crypto from 'crypto';

/**
 * Minimum TTL: 5 minutes (in seconds)
 */
const MIN_TTL = 5 * 60;

/**
 * Maximum TTL: 7 days (in seconds)
 */
const MAX_TTL = 7 * 24 * 60 * 60;

/**
 * Default TTL: 60 minutes (in seconds)
 */
const DEFAULT_TTL = 60 * 60;

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
 * Requirements: 12.1, 12.5, 12.6, 12.7
 */
export class SecureFileService {
  private static getSecret(): string {
    return process.env.FILE_ACCESS_SECRET || process.env.JWT_SECRET || 'alsaqi-dev-secret-key-123';
  }

  /**
   * Clamps the TTL value to the allowed range [5 minutes, 7 days].
   * Returns the default TTL (60 minutes) if no value is provided.
   */
  static clampTtl(ttl?: number): number {
    if (ttl === undefined || ttl === null) {
      return DEFAULT_TTL;
    }
    if (ttl < MIN_TTL) return MIN_TTL;
    if (ttl > MAX_TTL) return MAX_TTL;
    return ttl;
  }

  /**
   * Generates a signed URL for temporary file access.
   *
   * @param filePath - The file path relative to the uploads directory
   * @param userId - The ID of the user generating the signed URL
   * @param ttl - Time-to-live in seconds (default: 3600, min: 300, max: 604800)
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

    // Compute expected signature
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
   * The signature is bound to filePath + userId + expiry.
   */
  private static computeSignature(filePath: string, userId: string, expires: number): string {
    const payload = `${filePath}:${userId}:${expires}`;
    return crypto
      .createHmac('sha256', this.getSecret())
      .update(payload)
      .digest('hex');
  }
}

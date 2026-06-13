import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SecureFileService } from '../SecureFileService';

describe('SecureFileService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, FILE_ACCESS_SECRET: 'test-secret-key-for-signing' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('clampTtl', () => {
    it('should return the default TTL clamped to the 900s maximum when no value provided', () => {
      // Default (3600) is clamped down to the configured maximum of 900s (Req 11.4)
      expect(SecureFileService.clampTtl()).toBe(900);
      expect(SecureFileService.clampTtl(undefined)).toBe(900);
    });

    it('should clamp to minimum TTL (300s = 5 minutes) for values below', () => {
      expect(SecureFileService.clampTtl(60)).toBe(300);
      expect(SecureFileService.clampTtl(0)).toBe(300);
      expect(SecureFileService.clampTtl(-100)).toBe(300);
    });

    it('should clamp to maximum TTL (900s = 15 minutes) for values above', () => {
      expect(SecureFileService.clampTtl(901)).toBe(900);
      expect(SecureFileService.clampTtl(3600)).toBe(900);
      expect(SecureFileService.clampTtl(700000)).toBe(900);
      expect(SecureFileService.clampTtl(1000000)).toBe(900);
    });

    it('should pass through valid TTL values within range', () => {
      expect(SecureFileService.clampTtl(300)).toBe(300);
      expect(SecureFileService.clampTtl(600)).toBe(600);
      expect(SecureFileService.clampTtl(900)).toBe(900);
      expect(SecureFileService.clampTtl(450)).toBe(450);
    });
  });

  describe('generateSignedUrl', () => {
    it('should generate a URL with expires, userId, and sig query params', () => {
      const url = SecureFileService.generateSignedUrl('/report.pdf', 'user-123');

      expect(url).toContain('/api/v1/files/');
      expect(url).toContain('expires=');
      expect(url).toContain('userId=user-123');
      expect(url).toContain('sig=');
    });

    it('should encode the file path in the URL', () => {
      const url = SecureFileService.generateSignedUrl('/path with spaces/file.pdf', 'user-1');

      expect(url).toContain(encodeURIComponent('/path with spaces/file.pdf'));
    });

    it('should set expiry based on provided TTL', () => {
      const before = Math.floor(Date.now() / 1000);
      const url = SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600);
      const after = Math.floor(Date.now() / 1000);

      const expiresMatch = url.match(/expires=(\d+)/);
      expect(expiresMatch).not.toBeNull();
      const expires = parseInt(expiresMatch![1], 10);

      expect(expires).toBeGreaterThanOrEqual(before + 600);
      expect(expires).toBeLessThanOrEqual(after + 600);
    });

    it('should use default TTL (900s) when not specified', () => {
      const before = Math.floor(Date.now() / 1000);
      const url = SecureFileService.generateSignedUrl('/file.pdf', 'user-1');
      const after = Math.floor(Date.now() / 1000);

      const expiresMatch = url.match(/expires=(\d+)/);
      const expires = parseInt(expiresMatch![1], 10);

      expect(expires).toBeGreaterThanOrEqual(before + 900);
      expect(expires).toBeLessThanOrEqual(after + 900);
    });

    it('should never issue a URL exceeding the 900s maximum TTL', () => {
      const before = Math.floor(Date.now() / 1000);
      const url = SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 100000);
      const after = Math.floor(Date.now() / 1000);

      const expiresMatch = url.match(/expires=(\d+)/);
      const expires = parseInt(expiresMatch![1], 10);

      // Clamped down to the 900s maximum (Req 11.4)
      expect(expires).toBeGreaterThanOrEqual(before + 900);
      expect(expires).toBeLessThanOrEqual(after + 900);
    });

    it('should clamp TTL below minimum to 5 minutes', () => {
      const before = Math.floor(Date.now() / 1000);
      const url = SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 60);
      const after = Math.floor(Date.now() / 1000);

      const expiresMatch = url.match(/expires=(\d+)/);
      const expires = parseInt(expiresMatch![1], 10);

      // Should be clamped to 300 seconds (5 minutes)
      expect(expires).toBeGreaterThanOrEqual(before + 300);
      expect(expires).toBeLessThanOrEqual(after + 300);
    });
  });

  describe('verifySignedUrl', () => {
    it('should verify a valid signed URL successfully', () => {
      const filePath = '/document.pdf';
      const userId = 'user-456';
      const url = SecureFileService.generateSignedUrl(filePath, userId, 3600);

      // Extract params from generated URL
      const expiresMatch = url.match(/expires=(\d+)/);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);

      const expires = parseInt(expiresMatch![1], 10);
      const sig = sigMatch![1];

      const result = SecureFileService.verifySignedUrl(filePath, userId, expires, sig);

      expect(result.valid).toBe(true);
      expect(result.expired).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });

    it('should reject expired URLs with expired flag', () => {
      const filePath = '/old-file.pdf';
      const userId = 'user-789';
      // Set expiry in the past
      const pastExpiry = Math.floor(Date.now() / 1000) - 100;

      // Generate a signature for the past expiry (simulating a URL that was valid before)
      const url = SecureFileService.generateSignedUrl(filePath, userId, 300);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);

      const result = SecureFileService.verifySignedUrl(filePath, userId, pastExpiry, sigMatch![1]);

      expect(result.valid).toBe(false);
      expect(result.expired).toBe(true);
      expect(result.reason).toBe('URL has expired');
    });

    it('should reject URLs with tampered file path', () => {
      const filePath = '/secret.pdf';
      const userId = 'user-1';
      const url = SecureFileService.generateSignedUrl(filePath, userId, 3600);

      const expiresMatch = url.match(/expires=(\d+)/);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);

      const expires = parseInt(expiresMatch![1], 10);
      const sig = sigMatch![1];

      // Tamper with file path
      const result = SecureFileService.verifySignedUrl('/other-file.pdf', userId, expires, sig);

      expect(result.valid).toBe(false);
      expect(result.expired).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject URLs with tampered userId', () => {
      const filePath = '/report.pdf';
      const userId = 'user-1';
      const url = SecureFileService.generateSignedUrl(filePath, userId, 3600);

      const expiresMatch = url.match(/expires=(\d+)/);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);

      const expires = parseInt(expiresMatch![1], 10);
      const sig = sigMatch![1];

      // Tamper with userId
      const result = SecureFileService.verifySignedUrl(filePath, 'attacker-id', expires, sig);

      expect(result.valid).toBe(false);
      expect(result.expired).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject URLs with tampered expiry', () => {
      const filePath = '/report.pdf';
      const userId = 'user-1';
      const url = SecureFileService.generateSignedUrl(filePath, userId, 300);

      const expiresMatch = url.match(/expires=(\d+)/);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);

      const expires = parseInt(expiresMatch![1], 10);
      const sig = sigMatch![1];

      // Tamper with expiry (extend it)
      const result = SecureFileService.verifySignedUrl(filePath, userId, expires + 99999, sig);

      expect(result.valid).toBe(false);
      expect(result.expired).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject URLs with invalid signature format', () => {
      const filePath = '/report.pdf';
      const userId = 'user-1';
      const expires = Math.floor(Date.now() / 1000) + 3600;

      // Invalid hex signature (wrong length)
      const result = SecureFileService.verifySignedUrl(filePath, userId, expires, 'invalid');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject URLs with completely wrong signature', () => {
      const filePath = '/report.pdf';
      const userId = 'user-1';
      const expires = Math.floor(Date.now() / 1000) + 3600;

      // Valid hex but wrong signature (64 hex chars = 32 bytes = SHA256 output length)
      const wrongSig = 'a'.repeat(64);
      const result = SecureFileService.verifySignedUrl(filePath, userId, expires, wrongSig);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should use timing-safe comparison (no early exit on mismatch)', () => {
      // This test verifies the implementation uses timingSafeEqual
      // by checking that both valid and invalid signatures take similar time
      // (We can't truly measure timing in a unit test, but we verify the code path works)
      const filePath = '/report.pdf';
      const userId = 'user-1';
      const expires = Math.floor(Date.now() / 1000) + 3600;

      // Generate valid signature
      const url = SecureFileService.generateSignedUrl(filePath, userId, 3600);
      const sigMatch = url.match(/sig=([a-f0-9]+)/);
      const validSig = sigMatch![1];

      // Modify one character of the valid signature
      const almostValidSig = validSig.slice(0, -1) + (validSig.slice(-1) === 'a' ? 'b' : 'a');

      const result = SecureFileService.verifySignedUrl(filePath, userId, expires, almostValidSig);
      expect(result.valid).toBe(false);
    });
  });

  describe('secret configuration', () => {
    it('should use FILE_ACCESS_SECRET when available', () => {
      process.env.FILE_ACCESS_SECRET = 'file-specific-secret';
      process.env.JWT_SECRET = 'jwt-secret';

      const url1 = SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 3600);

      // Change to different FILE_ACCESS_SECRET - should produce different signature
      process.env.FILE_ACCESS_SECRET = 'different-secret';
      const url2 = SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 3600);

      const sig1 = url1.match(/sig=([a-f0-9]+)/)![1];
      const sig2 = url2.match(/sig=([a-f0-9]+)/)![1];

      expect(sig1).not.toBe(sig2);
    });

    it('should NOT fall back to JWT_SECRET when FILE_ACCESS_SECRET is not set', () => {
      delete process.env.FILE_ACCESS_SECRET;
      process.env.JWT_SECRET = 'jwt-fallback-secret';

      // No JWT/hardcoded fallback: signing must fail rather than silently
      // sign with a different secret (Req 9.3, 9.4)
      expect(() => SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600)).toThrow(
        /FILE_ACCESS_SECRET/
      );
    });

    it('should NOT fall back when FILE_ACCESS_SECRET is whitespace-only', () => {
      process.env.FILE_ACCESS_SECRET = '   ';
      process.env.JWT_SECRET = 'jwt-fallback-secret';

      expect(() => SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600)).toThrow(
        /FILE_ACCESS_SECRET/
      );
    });

    it('should not contain a hardcoded fallback secret in the source', () => {
      // The previous implementation fell back to 'alsaqi-dev-secret-key-123'.
      // Verify both that signing fails without a configured secret and that the
      // hardcoded literal is no longer used as a signing key.
      delete process.env.FILE_ACCESS_SECRET;
      delete process.env.JWT_SECRET;

      expect(() => SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600)).toThrow();
    });
  });
});

/**
 * Smoke test: absence of a hardcoded fallback secret (Task 10.5).
 *
 * The previous implementation fell back to the literal 'alsaqi-dev-secret-key-123'
 * and to JWT_SECRET when FILE_ACCESS_SECRET was absent. This suite scans the
 * SecureFileService source to prove those fallbacks are gone, and asserts that
 * signing/verifying fails closed when FILE_ACCESS_SECRET is not configured.
 *
 * _Requirements: 9.3_
 */
describe('SecureFileService hardcoded-fallback-secret smoke test (Req 9.3)', () => {
  const sourcePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'SecureFileService.ts'
  );
  const source = readFileSync(sourcePath, 'utf8');

  it('does not contain the previous hardcoded dev secret literal', () => {
    expect(source).not.toContain('alsaqi-dev-secret-key-123');
  });

  it('does not reference JWT_SECRET as a signing fallback', () => {
    // The dedicated FILE_ACCESS_SECRET is the only signing key; there must be
    // no reference to the JWT signing secret anywhere in the service source.
    expect(source).not.toContain('JWT_SECRET');
    expect(source).not.toContain('getJwtSecret');
    expect(source).not.toContain('jwtSecret');
  });

  it('derives the HMAC signing key from requireSecret(), never a literal', () => {
    // The HMAC key argument must be the dynamic secret accessor, not a quoted
    // string literal that could act as a hardcoded/default/example secret.
    const hmacCalls = source.match(/createHmac\(\s*['"]sha256['"]\s*,\s*([^)]+)\)/g) ?? [];
    expect(hmacCalls.length).toBeGreaterThan(0);
    for (const call of hmacCalls) {
      // Key argument is everything after the algorithm argument.
      const keyArg = call.replace(/createHmac\(\s*['"]sha256['"]\s*,\s*/, '').replace(/\)$/, '');
      expect(keyArg).toContain('requireSecret');
      // The key must not be a quoted string literal.
      expect(keyArg).not.toMatch(/^['"`]/);
    }
  });

  it('reads the signing secret only from FILE_ACCESS_SECRET (via env config)', () => {
    // The only secret source is getFileAccessSecret(), which reads FILE_ACCESS_SECRET.
    expect(source).toContain('getFileAccessSecret');
    expect(source).toContain('FILE_ACCESS_SECRET');
  });

  describe('fails closed without a configured FILE_ACCESS_SECRET', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('throws when FILE_ACCESS_SECRET is unset (no silent fallback)', () => {
      delete process.env.FILE_ACCESS_SECRET;
      delete process.env.JWT_SECRET;

      expect(() => SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600)).toThrow(
        /FILE_ACCESS_SECRET/
      );
    });

    it('throws even when JWT_SECRET is present (no JWT fallback)', () => {
      delete process.env.FILE_ACCESS_SECRET;
      process.env.JWT_SECRET = 'some-jwt-signing-secret-value-123456';

      expect(() => SecureFileService.generateSignedUrl('/file.pdf', 'user-1', 600)).toThrow(
        /FILE_ACCESS_SECRET/
      );
    });
  });
});

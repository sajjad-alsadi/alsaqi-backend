// @vitest-environment node
// Feature: backend-security-hardening, Property 18: Signature verification is bound to the current file-access secret
//
// Spec: .kiro/specs/backend-security-hardening (task 10.3)
//
// **Validates: Requirements 9.4, 9.5**
//
// Property 18 (design.md): For any file path, user id, and expiry, a signed URL
// produced with the current FILE_ACCESS_SECRET verifies successfully, and a
// signature produced with any other key (including the JWT secret) fails
// verification.
//
// The secret is read live from process.env.FILE_ACCESS_SECRET on every
// sign/verify call (via the typed environment-config accessor), so this test
// manipulates process.env.FILE_ACCESS_SECRET to simulate a secret rotation
// between signing and verification.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { SecureFileService } from '../SecureFileService';

/**
 * Non-empty, non-whitespace signing-secret generator. `getFileAccessSecret`
 * trims and rejects whitespace-only values, so we constrain to secrets whose
 * trimmed form is non-empty and use that trimmed form as the canonical value.
 */
const secretArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** Two distinct (after trimming) signing secrets. */
const distinctSecretsArb = fc
  .tuple(secretArb, secretArb)
  .filter(([a, b]) => a !== b);

const filePathArb = fc.string({ minLength: 1, maxLength: 80 });
const userIdArb = fc.string({ minLength: 1, maxLength: 40 });

interface ParsedSignedUrl {
  expires: number;
  sig: string;
}

function parseSignedUrl(url: string): ParsedSignedUrl {
  const expiresMatch = url.match(/expires=(\d+)/);
  const sigMatch = url.match(/sig=([a-f0-9]+)/);
  expect(expiresMatch).not.toBeNull();
  expect(sigMatch).not.toBeNull();
  return { expires: parseInt(expiresMatch![1], 10), sig: sigMatch![1] };
}

describe('Feature: backend-security-hardening, Property 18: Signature verification is bound to the current file-access secret', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('verifies under the signing secret, fails after the secret rotates, and succeeds again once restored', () => {
    fc.assert(
      fc.property(
        filePathArb,
        userIdArb,
        distinctSecretsArb,
        (filePath, userId, [signingSecret, otherSecret]) => {
          // 1. Sign under the current secret.
          process.env.FILE_ACCESS_SECRET = signingSecret;
          const url = SecureFileService.generateSignedUrl(filePath, userId);
          const { expires, sig } = parseSignedUrl(url);

          // The clamped TTL keeps `expires` in the future, so failures below are
          // attributable to the secret binding (Req 9.5), not expiry (Req 11.4).
          expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));

          // 2. Verification with the current (signing) secret succeeds (Req 9.4).
          const validResult = SecureFileService.verifySignedUrl(filePath, userId, expires, sig);
          expect(validResult.valid).toBe(true);

          // 3. Rotate to any other key: the signature no longer verifies (Req 9.5).
          process.env.FILE_ACCESS_SECRET = otherSecret;
          const rotatedResult = SecureFileService.verifySignedUrl(filePath, userId, expires, sig);
          expect(rotatedResult.valid).toBe(false);
          expect(rotatedResult.expired).toBe(false);
          expect(rotatedResult.reason).toBe('Invalid signature');

          // 4. Restoring the original secret verifies again (binding is to the
          //    current secret, not a permanent rejection).
          process.env.FILE_ACCESS_SECRET = signingSecret;
          const restoredResult = SecureFileService.verifySignedUrl(filePath, userId, expires, sig);
          expect(restoredResult.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// @vitest-environment node
// Feature: backend-security-hardening, Property 19: Issued TTL never exceeds the configured maximum
//
// **Validates: Requirements 11.4**
//
// For any requested time-to-live, the expiry timestamp set by `generateSignedUrl`
// is no later than now plus the configured maximum, which never exceeds 900 seconds.
// `clampTtl` likewise never returns a value above the configured maximum.
//
// Spec: .kiro/specs/backend-security-hardening (task 10.4)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { SecureFileService } from '../SecureFileService';

/** Absolute upper bound on the configured maximum TTL (Req 11.4). */
const ABSOLUTE_MAX_TTL_S = 900;

describe('Feature: backend-security-hardening, Property 19: Issued TTL never exceeds the configured maximum', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // A valid file-access secret is required to sign URLs (Req 9.1/9.2).
    process.env = { ...originalEnv, FILE_ACCESS_SECRET: 'test-secret-key-for-signing-0123456789' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('clampTtl never returns a value exceeding the configured maximum (and the maximum never exceeds 900s)', () => {
    fc.assert(
      fc.property(
        // Requested TTL: any number including negatives, zero, fractional, and absurdly large.
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 10_000_000 }),
          fc.double({ min: -1e6, max: 1e7, noNaN: true }),
          fc.constant(undefined)
        ),
        // Configured maximum within the allowed range [1, 900].
        fc.integer({ min: 1, max: ABSOLUTE_MAX_TTL_S }),
        (requestedTtl, configuredMax) => {
          process.env.FILE_SIGNED_URL_MAX_TTL_S = String(configuredMax);

          const clamped = SecureFileService.clampTtl(requestedTtl as number | undefined);

          // The configured maximum can never exceed the absolute 900s bound.
          expect(configuredMax).toBeLessThanOrEqual(ABSOLUTE_MAX_TTL_S);
          // The clamped TTL never exceeds the configured maximum.
          expect(clamped).toBeLessThanOrEqual(configuredMax);
          // And therefore never exceeds the absolute bound.
          expect(clamped).toBeLessThanOrEqual(ABSOLUTE_MAX_TTL_S);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('generateSignedUrl issues an expiry no later than now plus the configured maximum', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 10_000_000 }),
          fc.constant(undefined)
        ),
        fc.integer({ min: 1, max: ABSOLUTE_MAX_TTL_S }),
        fc.string(),
        fc.string(),
        (requestedTtl, configuredMax, filePath, userId) => {
          process.env.FILE_SIGNED_URL_MAX_TTL_S = String(configuredMax);

          const before = Math.floor(Date.now() / 1000);
          const url = SecureFileService.generateSignedUrl(
            filePath,
            userId,
            requestedTtl as number | undefined
          );
          const after = Math.floor(Date.now() / 1000);

          const expiresMatch = url.match(/[?&]expires=(\d+)/);
          expect(expiresMatch).not.toBeNull();
          const expires = parseInt(expiresMatch![1], 10);

          // Expiry is no later than the latest possible "now" plus the configured maximum,
          // which itself never exceeds 900 seconds (Req 11.4).
          expect(expires).toBeLessThanOrEqual(after + configuredMax);
          expect(expires).toBeLessThanOrEqual(after + ABSOLUTE_MAX_TTL_S);
          // Sanity: expiry is in the future relative to when signing began.
          expect(expires).toBeGreaterThanOrEqual(before);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  hashRefreshToken,
  hashPresentedRefreshToken,
  isHashableRefreshToken,
  refreshTokenMatchesHash,
  MAX_REFRESH_TOKEN_LENGTH,
} from '../refreshTokenHash';

describe('refreshTokenHash', () => {
  describe('hashRefreshToken', () => {
    it('produces the SHA-256 hex digest of the token (Req 17.1)', () => {
      const token = 'some.refresh.token';
      const expected = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
      expect(hashRefreshToken(token)).toBe(expected);
    });

    it('returns a 64-character lowercase hex string', () => {
      const hash = hashRefreshToken('abc');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
      expect(hashRefreshToken('repeat')).toBe(hashRefreshToken('repeat'));
    });

    it('produces different hashes for different inputs', () => {
      expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
    });

    it('throws for absent/empty/over-length tokens WITHOUT hashing (Req 17.4)', () => {
      expect(() => hashRefreshToken('')).toThrow();
      expect(() => hashRefreshToken(undefined)).toThrow();
      expect(() => hashRefreshToken(null)).toThrow();
      expect(() => hashRefreshToken('x'.repeat(MAX_REFRESH_TOKEN_LENGTH + 1))).toThrow();
    });

    it('accepts a token exactly at the maximum length', () => {
      const token = 'x'.repeat(MAX_REFRESH_TOKEN_LENGTH);
      expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('isHashableRefreshToken', () => {
    it('rejects absent/empty/over-length tokens (Req 17.4)', () => {
      expect(isHashableRefreshToken('')).toBe(false);
      expect(isHashableRefreshToken(undefined)).toBe(false);
      expect(isHashableRefreshToken(null)).toBe(false);
      expect(isHashableRefreshToken(123)).toBe(false);
      expect(isHashableRefreshToken('x'.repeat(MAX_REFRESH_TOKEN_LENGTH + 1))).toBe(false);
    });

    it('accepts non-empty tokens within the length bound', () => {
      expect(isHashableRefreshToken('a')).toBe(true);
      expect(isHashableRefreshToken('x'.repeat(MAX_REFRESH_TOKEN_LENGTH))).toBe(true);
    });
  });

  describe('hashPresentedRefreshToken', () => {
    it('returns null for non-hashable tokens (Req 17.4)', () => {
      expect(hashPresentedRefreshToken('')).toBeNull();
      expect(hashPresentedRefreshToken(undefined)).toBeNull();
      expect(hashPresentedRefreshToken('x'.repeat(MAX_REFRESH_TOKEN_LENGTH + 1))).toBeNull();
    });

    it('returns the same hash as hashRefreshToken for valid tokens (Req 17.2)', () => {
      expect(hashPresentedRefreshToken('tok')).toBe(hashRefreshToken('tok'));
    });
  });

  describe('refreshTokenMatchesHash', () => {
    it('matches when the presented token hashes to the stored hash (Req 17.2)', () => {
      const token = 'valid.refresh.token';
      const stored = hashRefreshToken(token);
      expect(refreshTokenMatchesHash(token, stored)).toBe(true);
    });

    it('does not match for a different token (Req 17.3)', () => {
      const stored = hashRefreshToken('original');
      expect(refreshTokenMatchesHash('different', stored)).toBe(false);
    });

    it('does not match for absent/empty/over-length presented tokens (Req 17.4)', () => {
      const stored = hashRefreshToken('original');
      expect(refreshTokenMatchesHash('', stored)).toBe(false);
      expect(refreshTokenMatchesHash(undefined, stored)).toBe(false);
      expect(refreshTokenMatchesHash('x'.repeat(MAX_REFRESH_TOKEN_LENGTH + 1), stored)).toBe(false);
    });

    it('does not match against an absent/empty stored hash', () => {
      expect(refreshTokenMatchesHash('token', '')).toBe(false);
      expect(refreshTokenMatchesHash('token', undefined)).toBe(false);
    });
  });
});

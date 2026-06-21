import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  isPreviousKeyWithinTransitionWindow,
  resolveVerificationKeySet,
  verifyJwtWithKeySet,
  verifyJwtWithRotation,
  type JwtVerificationKeyConfig,
} from '../jwtVerificationKeys';

/**
 * Unit tests for the JWT verification-key-set rotation support (task 24.2).
 *
 * Covers:
 * - scheduled rotation: previous-key tokens accepted WITHIN the transition
 *   window and rejected AFTER it (AC 19.2);
 * - post-incident rotation: previous-key tokens rejected immediately, the
 *   previous key is never part of the verification set (AC 19.5).
 */

function genKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('jwtVerificationKeys — rotation support', () => {
  let current: ReturnType<typeof genKeyPair>;
  let previous: ReturnType<typeof genKeyPair>;
  let tokenSignedWithCurrent: string;
  let tokenSignedWithPrevious: string;

  beforeAll(() => {
    current = genKeyPair();
    previous = genKeyPair();
    const payload = { id: 'u1', session_version: 1 };
    tokenSignedWithCurrent = jwt.sign(payload, current.privateKey, {
      algorithm: 'RS256',
      expiresIn: '1h',
    });
    tokenSignedWithPrevious = jwt.sign(payload, previous.privateKey, {
      algorithm: 'RS256',
      expiresIn: '1h',
    });
  });

  const rotatedAt = 1_000_000;
  const windowMs = 60_000;

  const scheduledConfig = (): JwtVerificationKeyConfig => ({
    currentPublicKey: current.publicKey,
    previousPublicKey: previous.publicKey,
    mode: 'scheduled',
    rotatedAt,
    transitionWindowMs: windowMs,
  });

  const postIncidentConfig = (): JwtVerificationKeyConfig => ({
    currentPublicKey: current.publicKey,
    previousPublicKey: previous.publicKey,
    mode: 'post-incident',
    rotatedAt,
    transitionWindowMs: windowMs,
  });

  describe('isPreviousKeyWithinTransitionWindow', () => {
    it('returns true inside the scheduled window', () => {
      expect(isPreviousKeyWithinTransitionWindow(scheduledConfig(), rotatedAt)).toBe(true);
      expect(isPreviousKeyWithinTransitionWindow(scheduledConfig(), rotatedAt + windowMs)).toBe(true);
    });

    it('returns false after the scheduled window expires', () => {
      expect(isPreviousKeyWithinTransitionWindow(scheduledConfig(), rotatedAt + windowMs + 1)).toBe(false);
    });

    it('always returns false for post-incident mode', () => {
      expect(isPreviousKeyWithinTransitionWindow(postIncidentConfig(), rotatedAt)).toBe(false);
    });

    it('returns false when no previous key is configured', () => {
      const cfg: JwtVerificationKeyConfig = { ...scheduledConfig(), previousPublicKey: null };
      expect(isPreviousKeyWithinTransitionWindow(cfg, rotatedAt)).toBe(false);
    });

    it('returns false when the transition window is non-positive', () => {
      const cfg: JwtVerificationKeyConfig = { ...scheduledConfig(), transitionWindowMs: 0 };
      expect(isPreviousKeyWithinTransitionWindow(cfg, rotatedAt)).toBe(false);
    });
  });

  describe('resolveVerificationKeySet', () => {
    it('includes current + previous inside the scheduled window', () => {
      const keys = resolveVerificationKeySet(scheduledConfig(), rotatedAt + 1);
      expect(keys).toContain(current.publicKey);
      expect(keys).toContain(previous.publicKey);
      expect(keys[0]).toBe(current.publicKey); // current first
    });

    it('includes only current after the window expires', () => {
      const keys = resolveVerificationKeySet(scheduledConfig(), rotatedAt + windowMs + 1);
      expect(keys).toEqual([current.publicKey]);
    });

    it('includes only current for post-incident mode', () => {
      const keys = resolveVerificationKeySet(postIncidentConfig(), rotatedAt);
      expect(keys).toEqual([current.publicKey]);
    });
  });

  describe('verifyJwtWithKeySet', () => {
    it('verifies a token signed by any key in the set', () => {
      const decoded = verifyJwtWithKeySet<any>(tokenSignedWithPrevious, [
        current.publicKey,
        previous.publicKey,
      ]);
      expect(decoded.id).toBe('u1');
    });

    it('throws when no key in the set verifies the token', () => {
      expect(() => verifyJwtWithKeySet(tokenSignedWithPrevious, [current.publicKey])).toThrow();
    });

    it('throws when the key set is empty', () => {
      expect(() => verifyJwtWithKeySet(tokenSignedWithCurrent, [])).toThrow();
    });
  });

  describe('verifyJwtWithRotation — end-to-end', () => {
    it('SCHEDULED: accepts previous-key token within the window', () => {
      const decoded = verifyJwtWithRotation<any>(
        tokenSignedWithPrevious,
        scheduledConfig(),
        { algorithms: ['RS256'] },
        rotatedAt + 1,
      );
      expect(decoded.id).toBe('u1');
    });

    it('SCHEDULED: rejects previous-key token after the window', () => {
      expect(() =>
        verifyJwtWithRotation(
          tokenSignedWithPrevious,
          scheduledConfig(),
          { algorithms: ['RS256'] },
          rotatedAt + windowMs + 1,
        ),
      ).toThrow();
    });

    it('SCHEDULED: always accepts current-key token', () => {
      const decoded = verifyJwtWithRotation<any>(
        tokenSignedWithCurrent,
        scheduledConfig(),
        { algorithms: ['RS256'] },
        rotatedAt + windowMs + 10_000,
      );
      expect(decoded.id).toBe('u1');
    });

    it('POST-INCIDENT: rejects previous-key token immediately', () => {
      expect(() =>
        verifyJwtWithRotation(
          tokenSignedWithPrevious,
          postIncidentConfig(),
          { algorithms: ['RS256'] },
          rotatedAt,
        ),
      ).toThrow();
    });

    it('POST-INCIDENT: still accepts current-key token', () => {
      const decoded = verifyJwtWithRotation<any>(
        tokenSignedWithCurrent,
        postIncidentConfig(),
        { algorithms: ['RS256'] },
        rotatedAt,
      );
      expect(decoded.id).toBe('u1');
    });
  });
});

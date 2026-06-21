/**
 * Property-based test for the Shared_Package surface fingerprint.
 *
 * Feature: production-launch-readiness, Property 5
 *
 * Property 5 — حتمية بصمة Shared_Package وحساسيتها:
 *   For any two Shared_Package public surfaces, the fingerprint is the SAME if and only
 *   if the two surfaces are identical after canonicalization; and any difference in a
 *   single exported value / constant / contract between the two surfaces yields two
 *   different fingerprints.
 *
 * `computeSharedSurfaceFingerprint()` hashes the package's ACTUAL public surface and
 * takes no parameters, so to make determinism + sensitivity property-testable we
 * exercise the underlying canonicalize + SHA-256 core (`fingerprintSurface`,
 * `canonicalize`) over GENERATED surfaces. The canonical form of a value is
 * `JSON.stringify(canonicalize(value))`; the property under test ties this canonical
 * form to the fingerprint:
 *
 *   fingerprintSurface(a) === fingerprintSurface(b)
 *      IFF  canonical(a) === canonical(b)            (modulo SHA-256 collisions)
 *
 * Validates: Requirements 8.3, 8.6
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  canonicalize,
  fingerprintSurface,
  computeSharedSurfaceFingerprint,
} from '../fingerprint';

/** The canonical string form a fingerprint is derived from. */
function canonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * A generator for "surface-like" values: JSON-compatible trees of strings, numbers,
 * booleans, null, arrays and objects. This mirrors the runtime shape of the canonicalized
 * public surface (constants, enum objects, JSON-Schema projections of Zod contracts).
 */
const surfaceArb: fc.Arbitrary<unknown> = fc.jsonValue();

/**
 * Keys for the public surface. Excludes `__proto__`, which is never a member name on the
 * real Shared_Package surface (namespaces of constants/enums/Zod projections) and which
 * behaves specially as an object key, so it is outside the meaningful input space.
 */
const safeKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((k) => k !== '__proto__');

/** Recursively reverse object key order so a clone differs only in insertion order. */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === 'object') {
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      reversed[key] = reorderKeys((value as Record<string, unknown>)[key]);
    }
    return reversed;
  }
  return value;
}

describe('Property 5: Shared_Package fingerprint determinism and sensitivity', () => {
  it('fingerprint equality holds IFF canonical forms are equal (determinism + sensitivity)', () => {
    fc.assert(
      fc.property(surfaceArb, surfaceArb, (a, b) => {
        const sameFingerprint = fingerprintSurface(a) === fingerprintSurface(b);
        const sameCanonical = canonical(a) === canonical(b);
        // SHA-256 collisions are cryptographically negligible, so fingerprint equality
        // is a faithful proxy for canonical equality in both directions.
        expect(sameFingerprint).toBe(sameCanonical);
      }),
    );
  });

  it('is deterministic: repeated calls on the same surface yield the same fingerprint', () => {
    fc.assert(
      fc.property(surfaceArb, (a) => {
        const first = fingerprintSurface(a);
        expect(fingerprintSurface(a)).toBe(first);
        expect(fingerprintSurface(a)).toBe(first);
      }),
    );
  });

  it('is order-independent: reordering object keys does not change the fingerprint', () => {
    fc.assert(
      fc.property(surfaceArb, (a) => {
        // A clone that differs only by key insertion order is canonically identical,
        // therefore it must produce the identical fingerprint.
        expect(canonical(reorderKeys(a))).toBe(canonical(a));
        expect(fingerprintSurface(reorderKeys(a))).toBe(fingerprintSurface(a));
      }),
    );
  });

  it('is sensitive: adding a single exported member changes the fingerprint', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), surfaceArb),
        fc.string({ minLength: 1 }),
        surfaceArb,
        (surface, newKey, newValue) => {
          // Only consider a genuinely new member so the surface actually changes.
          fc.pre(!Object.prototype.hasOwnProperty.call(surface, newKey));
          const mutated = { ...surface, [newKey]: newValue };
          // The surface changed, so canonical form changes, so the fingerprint changes.
          expect(canonical(mutated)).not.toBe(canonical(surface));
          expect(fingerprintSurface(mutated)).not.toBe(fingerprintSurface(surface));
        },
      ),
    );
  });

  it('is sensitive: changing a single field value changes the fingerprint', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), surfaceArb, { minKeys: 1 }),
        (surface) => {
          const keys = Object.keys(surface);
          const key = keys[0];
          // Replace the chosen field with a sentinel guaranteed to differ from any
          // JSON-compatible generated value.
          const sentinel = { __property5_sentinel__: true };
          fc.pre(canonical(surface[key]) !== canonical(sentinel));
          const mutated = { ...surface, [key]: sentinel };
          expect(canonical(mutated)).not.toBe(canonical(surface));
          expect(fingerprintSurface(mutated)).not.toBe(fingerprintSurface(surface));
        },
      ),
    );
  });

  it('anchors on the real package surface: computeSharedSurfaceFingerprint is stable', () => {
    const fingerprint = computeSharedSurfaceFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSharedSurfaceFingerprint()).toBe(fingerprint);
  });
});

// @vitest-environment node
// Feature: production-launch-readiness, Property 8
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildPermissionParityReport,
  type PermissionRegistryEntry,
} from '../permissionParity.js';
import type { ParitySide } from '../../launch/types.js';

/**
 * Property 8: كشف فجوات تكافؤ سجل الصلاحيات
 * (Permission Registry Parity Gap Detection)
 *
 * **Validates: Requirements 17.1, 17.2, 17.3, 17.4**
 *
 * For any pair of permission registries (backend + frontend), the report produced by
 * `buildPermissionParityReport` MUST satisfy:
 *   1. Exactly one row per unique (module, permission) pair in the UNION of both registries.
 *   2. Each row is tagged 'both' / 'backend-only' / 'frontend-only', correctly indicating
 *      the gap direction.
 *   3. `gaps` === all rows where `side !== 'both'`, and `gaps` is EMPTY iff both registries
 *      contain exactly the same SET of (module, permission) pairs.
 *
 * Strategy:
 * - Generate two registries from a shared small alphabet of module/permission tokens so
 *   that overlapping AND disjoint sets occur frequently.
 * - Verify each property against an INDEPENDENT oracle built from plain set operations on
 *   the union (no reuse of the implementation's logic).
 */

// ─── Independent oracle helpers ──────────────────────────────────────────────

const keyOf = (e: PermissionRegistryEntry): string => `${e.module}\u0000${e.permission}`;

/** Oracle: classify a key purely from the two key-sets via set membership. */
function oracleSide(key: string, backendKeys: Set<string>, frontendKeys: Set<string>): ParitySide {
  const inB = backendKeys.has(key);
  const inF = frontendKeys.has(key);
  if (inB && inF) return 'both';
  return inB ? 'backend-only' : 'frontend-only';
}

// ─── Generators ──────────────────────────────────────────────────────────────

// Small alphabets so overlapping and disjoint pairs are both common.
const moduleArb = fc.constantFrom('fraud', 'audit', 'settings', 'reports', 'users');
const permissionArb = fc.constantFrom('create', 'read', 'update', 'delete', 'export');

const entryArb: fc.Arbitrary<PermissionRegistryEntry> = fc.record({
  module: moduleArb,
  permission: permissionArb,
});

const registryArb: fc.Arbitrary<PermissionRegistryEntry[]> = fc.array(entryArb, {
  minLength: 0,
  maxLength: 12,
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 8: Permission registry parity gap detection', () => {
  it('produces exactly one row per unique (module, permission) in the UNION of both registries', () => {
    fc.assert(
      fc.property(registryArb, registryArb, (backend, frontend) => {
        const report = buildPermissionParityReport(backend, frontend);

        // Oracle: union of unique keys.
        const unionKeys = new Set<string>([...backend.map(keyOf), ...frontend.map(keyOf)]);

        // One row per unique key, with no duplicates.
        const rowKeys = report.rows.map((r) => keyOf(r));
        expect(rowKeys.length).toBe(unionKeys.size);
        expect(new Set(rowKeys).size).toBe(report.rows.length);
        expect(new Set(rowKeys)).toEqual(unionKeys);
      }),
      { numRuns: 200 },
    );
  });

  it('tags each row with the correct gap direction per the set-membership oracle', () => {
    fc.assert(
      fc.property(registryArb, registryArb, (backend, frontend) => {
        const report = buildPermissionParityReport(backend, frontend);

        const backendKeys = new Set(backend.map(keyOf));
        const frontendKeys = new Set(frontend.map(keyOf));

        for (const row of report.rows) {
          const expected = oracleSide(keyOf(row), backendKeys, frontendKeys);
          expect(row.side).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('gaps === all rows with side !== both, and gaps is EMPTY iff both registries hold the same set', () => {
    fc.assert(
      fc.property(registryArb, registryArb, (backend, frontend) => {
        const report = buildPermissionParityReport(backend, frontend);

        // gaps == rows filtered by side !== 'both'
        const expectedGaps = report.rows.filter((r) => r.side !== 'both');
        expect(report.gaps).toEqual(expectedGaps);
        expect(report.gaps.every((r) => r.side !== 'both')).toBe(true);

        // Oracle: set equality of the two registries.
        const backendKeys = new Set(backend.map(keyOf));
        const frontendKeys = new Set(frontend.map(keyOf));
        const sameSet =
          backendKeys.size === frontendKeys.size &&
          [...backendKeys].every((k) => frontendKeys.has(k));

        expect(report.gaps.length === 0).toBe(sameSet);
      }),
      { numRuns: 200 },
    );
  });
});

// @vitest-environment node
// Feature: backend-security-hardening, Property 32: Error sanitization is allowlist-bound (default-deny)
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { sanitizeErrorForClient, CLIENT_ERROR_FIELD_ALLOWLIST } from '../error';

/**
 * Property Test: Error sanitization is allowlist-bound (default-deny) (Property 32)
 *
 * **Validates: Requirements 24.1, 24.2, 24.3, 24.4**
 *
 * For any error object built from a mix of allowlisted field names
 * (`code`, `message`, `traceId`, `field`, `errors`) and arbitrary non-allowlisted
 * field names (including database table/column-like identifiers), the
 * `sanitizeErrorForClient` function SHALL return an object whose keys are always a
 * subset of `CLIENT_ERROR_FIELD_ALLOWLIST`. Allowlisted field values present on the
 * input are preserved unchanged, and every non-allowlisted field is excluded
 * because it is absent from the static allowlist (default-deny), regardless of its
 * name or value.
 */

const ALLOWLIST = CLIENT_ERROR_FIELD_ALLOWLIST;
const ALLOWLIST_SET = new Set<string>(ALLOWLIST);

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A single allowlisted field name. */
const allowlistedKeyArb = fc.constantFrom(...ALLOWLIST);

/** Arbitrary JSON-ish values that can appear on an error object. */
const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string(), { maxLength: 4 }),
  fc.record({ detail: fc.string() })
);

/**
 * Non-allowlisted key names, including database table/column-like identifiers,
 * SQL/internal-looking fragments, and freely generated identifiers. Filtered to
 * guarantee they are never accidentally a member of the allowlist.
 */
const nonAllowlistedKeyArb = fc
  .oneof(
    // table/column-like names that an unsanitized DB error might carry
    fc.constantFrom(
      'table',
      'column',
      'constraint',
      'detail',
      'schema',
      'stack',
      'query',
      'sql',
      'audit_tasks',
      'users.email',
      'org_entities',
      'idempotency_keys',
      'foreign_key',
      'hostname',
      'internalPath'
    ),
    // freely generated identifiers (may collide with table/column-ish strings)
    fc
      .string({ minLength: 1, maxLength: 16 })
      .filter((s) => s.trim().length > 0)
  )
  .filter((k) => !ALLOWLIST_SET.has(k));

/**
 * Builds an error object mixing a subset of allowlisted fields with arbitrary
 * non-allowlisted fields. Returns both the assembled object and the values that
 * were assigned to allowlisted keys so value preservation can be asserted.
 */
const errorObjectArb = fc
  .record({
    allowed: fc.dictionary(allowlistedKeyArb, valueArb),
    foreign: fc.dictionary(nonAllowlistedKeyArb, valueArb),
  })
  .map(({ allowed, foreign }) => {
    // foreign keys are filtered to be non-allowlisted, so the two maps never overlap.
    const error: Record<string, unknown> = { ...foreign, ...allowed };
    return { error, allowed, foreign };
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 32: Error sanitization is allowlist-bound (default-deny)', () => {
  it('output keys are always a subset of the allowlist, allowlisted values are preserved, and non-allowlisted keys are excluded', () => {
    fc.assert(
      fc.property(errorObjectArb, ({ error, allowed, foreign }) => {
        const sanitized = sanitizeErrorForClient(error);
        const outputKeys = Object.keys(sanitized);

        // 1. Output keys are always a subset of the allowlist (default-deny).
        for (const key of outputKeys) {
          expect(ALLOWLIST_SET.has(key)).toBe(true);
        }

        // 2. Every allowlisted field on the input is preserved with its exact value.
        for (const key of Object.keys(allowed)) {
          expect(Object.prototype.hasOwnProperty.call(sanitized, key)).toBe(true);
          expect(sanitized[key]).toBe(error[key]);
        }

        // 3. Every non-allowlisted key (table/column-like or arbitrary) is excluded,
        //    unless that same key was also supplied as an allowlisted field. Own-property
        //    checks are used so inherited names (e.g. "toString") are not false positives.
        for (const key of Object.keys(foreign)) {
          if (!Object.prototype.hasOwnProperty.call(allowed, key)) {
            expect(Object.prototype.hasOwnProperty.call(sanitized, key)).toBe(false);
          }
        }

        // 4. The function is pure: the input object is never mutated.
        expect(Object.keys(error).length).toBe(
          Object.keys(allowed).length + Object.keys(foreign).length
        );
      }),
      { numRuns: 200 }
    );
  });

  it('returns an empty object when no allowlisted fields are present', () => {
    fc.assert(
      fc.property(
        fc.dictionary(nonAllowlistedKeyArb, valueArb),
        (foreignOnly) => {
          const sanitized = sanitizeErrorForClient(foreignOnly);
          expect(Object.keys(sanitized)).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

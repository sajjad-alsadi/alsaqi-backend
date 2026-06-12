/**
 * Property test for FIX-BE-5 risk-register validator schemas.
 *
 * Property 1: Valid response bodies satisfy their validator schema.
 * For each NEW validator introduced by the FIX-BE-5 wave, valid objects
 * (with optional fields present/absent and arbitrary array sizes) must pass
 * `schema.safeParse(obj).success === true`.
 *
 * NOTE: Of the FIX-BE-5 validators planned, only the risk-register validators
 * (`CreateRiskRegisterSchema`, `UpdateRiskRegisterSchema`) actually exist in
 * `../risk-register`. This test is therefore scoped to those schemas. The
 * generators are derived from the schema shapes (string length bounds, numeric
 * fields, optional + nullable fields) so generated objects are always valid.
 *
 * **Validates: Requirements 5.7**
 */
// Feature: backend-consistency-fixes, Property 1
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  CreateRiskRegisterSchema,
  UpdateRiskRegisterSchema,
} from '../index';

// ---------------------------------------------------------------------------
// Generators derived from the schema field constraints.
// ---------------------------------------------------------------------------

/**
 * A bounded non-empty string arbitrary respecting `min(1).max(max)`.
 * Generated values never violate the min/max length constraints.
 */
const boundedString = (max: number) =>
  fc.string({ minLength: 1, maxLength: Math.min(max, 200) });

/**
 * Wraps a value arbitrary so the field may be:
 *  - present with a value
 *  - present and explicitly null  (.nullable())
 *  - absent / undefined           (.optional())
 * This exercises the "optional fields present/absent" requirement.
 */
const optionalNullable = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null | undefined> =>
  fc.oneof(arb, fc.constant(null), fc.constant(undefined));

/**
 * Wraps a value arbitrary so the field may be present with a value or absent
 * (undefined), but never null. Matches fields that are `.optional()` only
 * (e.g. `risk_id`, and `description` on the Update schema).
 */
const optionalOnly = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.oneof(arb, fc.constant(undefined));

/**
 * Build a valid record matching the shared shape of the risk-register schemas.
 * `descriptionRequired` controls whether `description` is always present
 * (Create requires it; Update treats it as optional).
 */
const riskFields = (descriptionRequired: boolean) => {
  const description = descriptionRequired
    ? boundedString(5000)
    : optionalOnly(boundedString(5000));

  return fc.record(
    {
      risk_id: optionalOnly(boundedString(100)),
      description,
      owner: optionalNullable(boundedString(255)),
      source: optionalNullable(boundedString(255)),
      early_warning: optionalNullable(boundedString(5000)),
      type: optionalNullable(boundedString(100)),
      likelihood: optionalNullable(boundedString(50)),
      impact: optionalNullable(boundedString(50)),
      score: optionalNullable(fc.double({ noNaN: true, noDefaultInfinity: true })),
      rating: optionalNullable(boundedString(50)),
      controls: optionalNullable(boundedString(5000)),
      control_assessment: optionalNullable(boundedString(5000)),
      mitigation: optionalNullable(boundedString(5000)),
      treatment_option: optionalNullable(boundedString(255)),
      residual_likelihood: optionalNullable(boundedString(50)),
      residual_impact: optionalNullable(boundedString(50)),
      residual_score: optionalNullable(fc.double({ noNaN: true, noDefaultInfinity: true })),
      residual_rating: optionalNullable(boundedString(50)),
      status: optionalNullable(boundedString(50)),
      target_date: optionalNullable(boundedString(50)),
      review_date: optionalNullable(boundedString(50)),
      notes: optionalNullable(boundedString(5000)),
      entry_date: optionalNullable(boundedString(50)),
      entered_by: optionalNullable(boundedString(255)),
    },
    // requiredKeys: [] means every key may be omitted, so optional fields are
    // sometimes absent and sometimes present — covering present/absent.
    { requiredKeys: descriptionRequired ? ['description'] : [] }
  );
};

/**
 * Strip keys whose generated value is `undefined` so we model an actual
 * response body (absent fields are not serialized as `undefined`). Arrays of
 * fields with arbitrary sizes are emulated by the random presence/absence of
 * each optional key.
 */
const dropUndefined = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Property 1: Valid response bodies satisfy their validator schema
// ---------------------------------------------------------------------------

describe('Property 1: Valid response bodies satisfy their validator schema (FIX-BE-5)', () => {
  it('CreateRiskRegisterSchema accepts all valid generated objects', () => {
    fc.assert(
      fc.property(riskFields(true), (raw) => {
        const obj = dropUndefined(raw);
        const result = CreateRiskRegisterSchema.safeParse(obj);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('UpdateRiskRegisterSchema accepts all valid generated objects', () => {
    fc.assert(
      fc.property(riskFields(false), (raw) => {
        const obj = dropUndefined(raw);
        const result = UpdateRiskRegisterSchema.safeParse(obj);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('UpdateRiskRegisterSchema accepts the empty object (all fields optional)', () => {
    expect(UpdateRiskRegisterSchema.safeParse({}).success).toBe(true);
  });
});

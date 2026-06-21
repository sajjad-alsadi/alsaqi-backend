// @vitest-environment node
// Feature: production-launch-readiness, Property 10
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aggregateLaunchGate } from '../launchGate.js';
import type { GateStatus, LaunchGateCriterion } from '../types.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const priorityArb = fc.constantFrom<'P0' | 'P1' | 'P2'>('P0', 'P1', 'P2');
const statusArb = fc.constantFrom<GateStatus>('pass', 'fail', 'unverified');

/**
 * evidenceRef generator covering the full input space:
 * - null (no evidence)
 * - empty string
 * - whitespace-only strings (tabs, spaces, newlines)
 * - meaningful non-empty strings
 */
const evidenceRefArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.constantFrom('   ', '\t', '\n', ' \t\n '),
  fc.string({ minLength: 1, maxLength: 20 })
);

const criterionArb: fc.Arbitrary<LaunchGateCriterion> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  priority: priorityArb,
  status: statusArb,
  evidenceRef: evidenceRefArb,
});

const criteriaArb: fc.Arbitrary<LaunchGateCriterion[]> = fc.array(criterionArb, {
  maxLength: 25,
});

// ─── Independent Oracle ──────────────────────────────────────────────────────

/** Mirrors the "has non-empty evidence after trimming" check, independently. */
function oracleHasEvidence(evidenceRef: string | null): boolean {
  return typeof evidenceRef === 'string' && evidenceRef.trim().length > 0;
}

/**
 * Independent oracle for gatePassed:
 * The gate passes IFF every P0 criterion is genuinely 'pass' with non-empty
 * evidence. Non-P0 criteria are ignored entirely.
 */
function oracleGatePassed(criteria: LaunchGateCriterion[]): boolean {
  return criteria
    .filter((c) => c.priority === 'P0')
    .every((c) => c.status === 'pass' && oracleHasEvidence(c.evidenceRef));
}

// ─── Property Test ───────────────────────────────────────────────────────────

/**
 * Property 10: Launch gate aggregation fails closed
 *
 * **Validates: Requirements 8.5, 18.4, 20.4, 22.3, 22.4, 22.6**
 *
 * gatePassed === true IFF every P0 criterion has (normalized) status 'pass'
 * AND a non-empty evidenceRef. Any P0 criterion with status 'fail'/'unverified',
 * or 'pass' with empty/null/whitespace evidenceRef (which is normalized to
 * 'unverified'), forces gatePassed to be false. Non-P0 criteria never affect
 * gatePassed. The returned criteria reflect the pass-without-evidence →
 * unverified normalization.
 */
describe('Property 10: Launch gate aggregation fails closed', () => {
  it('gatePassed matches the independent fail-closed oracle for any criteria set', () => {
    fc.assert(
      fc.property(criteriaArb, (criteria) => {
        const result = aggregateLaunchGate(criteria);
        expect(result.gatePassed).toBe(oracleGatePassed(criteria));
      }),
      { numRuns: 200 }
    );
  });

  it('returned criteria normalize pass-without-evidence to unverified and preserve count/order', () => {
    fc.assert(
      fc.property(criteriaArb, (criteria) => {
        const result = aggregateLaunchGate(criteria);

        // Count and order are preserved.
        expect(result.criteria).toHaveLength(criteria.length);

        result.criteria.forEach((out, i) => {
          const input = criteria[i];
          expect(out.id).toBe(input.id);
          expect(out.priority).toBe(input.priority);
          expect(out.evidenceRef).toBe(input.evidenceRef);

          // Normalization rule: 'pass' without real evidence becomes 'unverified';
          // every other status is preserved verbatim.
          if (input.status === 'pass' && !oracleHasEvidence(input.evidenceRef)) {
            expect(out.status).toBe('unverified');
          } else {
            expect(out.status).toBe(input.status);
          }
        });
      }),
      { numRuns: 200 }
    );
  });

  it('non-P0 criteria never affect gatePassed', () => {
    fc.assert(
      fc.property(
        fc.array(criterionArb, { maxLength: 15 }),
        fc.array(
          criterionArb.map((c) => ({
            ...c,
            priority: fc.sample(fc.constantFrom<'P1' | 'P2'>('P1', 'P2'), 1)[0],
          })),
          { maxLength: 15 }
        ),
        (base, extraNonP0) => {
          const withoutExtra = aggregateLaunchGate(base);
          const withExtra = aggregateLaunchGate([...base, ...extraNonP0]);
          // Adding any number of non-P0 criteria must not change the gate verdict.
          expect(withExtra.gatePassed).toBe(withoutExtra.gatePassed);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('any single P0 failure forces gatePassed false (fail-closed)', () => {
    const failingP0Arb = fc.oneof(
      // P0 with non-pass status
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        priority: fc.constant<'P0'>('P0'),
        status: fc.constantFrom<GateStatus>('fail', 'unverified'),
        evidenceRef: evidenceRefArb,
      }),
      // P0 'pass' but without real evidence
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        priority: fc.constant<'P0'>('P0'),
        status: fc.constant<GateStatus>('pass'),
        evidenceRef: fc.oneof(fc.constant(null), fc.constant(''), fc.constantFrom('  ', '\t', '\n')),
      })
    );

    fc.assert(
      fc.property(criteriaArb, failingP0Arb, (criteria, failingP0) => {
        const result = aggregateLaunchGate([...criteria, failingP0]);
        expect(result.gatePassed).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

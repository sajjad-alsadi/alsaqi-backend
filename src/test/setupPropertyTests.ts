/**
 * Global test setup for property-based testing (fast-check).
 *
 * Feature: production-launch-readiness — Task 1.2
 *
 * Purpose:
 *  - Establish the project-wide floor for property-based test iterations at
 *    >= 100 runs per property, as required by the design (each of the ten
 *    correctness properties must run with at least 100 iterations).
 *  - This file is wired into vitest via `test.setupFiles` so that EVERY test
 *    file in the suite — unit tests AND property tests — runs in the same pass.
 *
 * Convention:
 *  - `fc.configureGlobal({ numRuns: 100 })` sets the DEFAULT number of runs for
 *    any `fc.assert` call that does not pass an explicit `numRuns`.
 *  - Individual property tests MAY raise the count above 100 by passing
 *    `{ numRuns: <n> }` (where n >= 100) to `fc.assert`, but MUST NOT lower it
 *    below the 100-iteration floor.
 */
import fc from 'fast-check';

// Minimum iterations per property. Do not lower below 100.
export const PROPERTY_TEST_MIN_RUNS = 100;

fc.configureGlobal({
  numRuns: PROPERTY_TEST_MIN_RUNS,
});

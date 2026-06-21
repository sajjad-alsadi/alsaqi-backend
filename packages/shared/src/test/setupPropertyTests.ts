/**
 * Global test setup for property-based testing (fast-check) in @alsaqi/shared.
 *
 * Feature: production-launch-readiness — Task 1.2
 *
 * Establishes the project-wide floor of >= 100 iterations per property for
 * property tests that live in the shared package (e.g. the Shared_Package
 * fingerprint property). Wired into vitest via `test.setupFiles` so that unit
 * tests and property tests run together in one pass.
 */
import fc from 'fast-check';

// Minimum iterations per property. Do not lower below 100.
export const PROPERTY_TEST_MIN_RUNS = 100;

fc.configureGlobal({
  numRuns: PROPERTY_TEST_MIN_RUNS,
});

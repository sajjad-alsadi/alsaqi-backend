import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    hookTimeout: 30000,
    // The default include pattern matches both unit tests (*.test.ts) and
    // property tests (*.property.test.ts), so both run together in one pass.
    // setupFiles establishes the >= 100 iterations floor for fast-check.
    setupFiles: ['./src/test/setupPropertyTests.ts'],
  },
});

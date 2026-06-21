import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    hookTimeout: 30000,
    // The default include pattern matches both unit tests (*.test.ts) and
    // property tests (*.property.test.ts), so both run together in one pass.
    // setupFiles establishes the >= 100 iterations floor for fast-check.
    setupFiles: ['./src/test/setupPropertyTests.ts'],
    // Coverage_Report (Requirement 16.1, 16.2): enable the v8 coverage provider
    // and emit machine-readable reporters. `include` enumerates the critical-path
    // module set defined in `src/launch/criticalPathModules.ts` (authentication,
    // authorization, and backup/restore logic) so the report contains one entry
    // per critical module. Keep this list in sync with CRITICAL_PATH_MODULES.
    coverage: {
      provider: 'v8',
      // 'json' + 'json-summary' are machine-readable (consumed by the coverage
      // threshold check, task 20.2); 'text' is a human-readable console summary.
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        // Authentication
        'src/middleware/auth.ts',
        // Authorization
        'src/services/PermissionService.ts',
        'src/permissions/registry.ts',
        'src/permissions/modules.ts',
        // Backup / Restore
        'src/utils/backup.ts',
        'scripts/restoreDrill.ts',
      ],
      // Report coverage for every included file even if no test touched it, so a
      // critical module with zero coverage still appears as an entry (16.1).
      all: true,
    },
  },
});

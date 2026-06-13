/**
 * Static-analysis guard: single-implementation modules.
 *
 * Requirement 27.2 mandates exactly one migration runner module and exactly
 * one migrations definition module. Requirement 27.3 mandates exactly one set
 * of authentication route definitions, with no parallel `routes/auth.ts` and
 * `routes/auth/*` implementations coexisting. Requirement 27.5 mandates that a
 * build / static analysis FAIL with an error indicating which module has
 * multiple implementations when more than one is detected.
 *
 * This test scans the `src` tree and fails the build if it detects:
 *   (a) more than one migration runner module,
 *   (b) more than one migrations definition module, or
 *   (c) a reintroduced `routes/auth.ts` alongside the `routes/auth/` tree
 *       (duplicate authentication route definitions).
 *
 * Heuristics (deliberately robust, not brittle):
 *   - Migration runner: a production source file that declares the
 *     `class MigrationRunner` versioning engine. Canonical:
 *     `src/db/migrationRunner.ts`.
 *   - Migrations definition: a production source file that exports the
 *     migrations registry/entry point, evidenced by an export of
 *     `runMigrations` or `versionedMigrations`. Canonical: `src/db/migrations.ts`.
 *   - Authentication route definitions: the canonical implementation lives in
 *     the `src/routes/auth/` directory tree. A reintroduced flat
 *     `src/routes/auth.ts` module alongside that tree is a duplicate.
 *
 * Requirement 27.6 (the existing automated suite continues to pass unchanged)
 * is validated by running the full suite; this guard adds checks without
 * altering any existing test expectations.
 *
 * **Validates: Requirements 27.2, 27.3, 27.5, 27.6**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { dirname, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file allowed to contain the migration runner engine. */
const CANONICAL_MIGRATION_RUNNER = resolve(SRC_DIR, 'db', 'migrationRunner.ts');

/** The one file allowed to contain the migrations definition module. */
const CANONICAL_MIGRATIONS_DEFINITION = resolve(SRC_DIR, 'db', 'migrations.ts');

/** Directory names that never contain production source and are skipped. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '__mocks__']);

/** Returns true for test/spec files, which are excluded from the scan. */
function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(filePath) || filePath.includes(`${sep}__tests__${sep}`);
}

/** Recursively collect all production TypeScript source files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (IGNORED_DIRS.has(entry)) continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (isTestFile(full)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Decides whether a file declares the migration runner engine. The engine is
 * the `MigrationRunner` class that tracks/applies versioned migrations.
 */
function isMigrationRunnerImplementation(contents: string): boolean {
  return /\bclass\s+MigrationRunner\b/.test(contents);
}

/**
 * Decides whether a file is a migrations definition module. The definition
 * module declares the migrations registry / forward entry point, evidenced by
 * an export of `runMigrations` or the `versionedMigrations` array.
 */
function isMigrationsDefinitionImplementation(contents: string): boolean {
  const exportsRunMigrations =
    /export\s+(?:const|async\s+function|function)\s+runMigrations\b/.test(contents);
  const exportsVersionedMigrations =
    /export\s+const\s+versionedMigrations\b/.test(contents);
  return exportsRunMigrations || exportsVersionedMigrations;
}

describe('single-implementation modules guard (Req 27.2, 27.3, 27.5, 27.6)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  const migrationRunners = sourceFiles.filter((file) =>
    isMigrationRunnerImplementation(readFileSync(file, 'utf-8'))
  );

  const migrationsDefinitions = sourceFiles.filter((file) =>
    isMigrationsDefinitionImplementation(readFileSync(file, 'utf-8'))
  );

  it('detects the canonical migration runner and migrations definition (sanity check)', () => {
    // If these fail, the heuristics have drifted and would no longer catch a
    // second implementation, giving a false sense of safety.
    expect(migrationRunners).toContain(CANONICAL_MIGRATION_RUNNER);
    expect(migrationsDefinitions).toContain(CANONICAL_MIGRATIONS_DEFINITION);
  });

  it('fails the build if more than one migration runner module exists (Req 27.2, 27.5)', () => {
    const offenders = migrationRunners
      .filter((file) => file !== CANONICAL_MIGRATION_RUNNER)
      .map((file) => relative(SRC_DIR, file));

    expect(
      offenders,
      `More than one migration runner module detected. The migration runner ` +
        `may only be defined in db/migrationRunner.ts (Requirement 27.2, 27.5). ` +
        `Offending file(s): ${offenders.join(', ')}`
    ).toEqual([]);

    expect(migrationRunners).toHaveLength(1);
  });

  it('fails the build if more than one migrations definition module exists (Req 27.2, 27.5)', () => {
    const offenders = migrationsDefinitions
      .filter((file) => file !== CANONICAL_MIGRATIONS_DEFINITION)
      .map((file) => relative(SRC_DIR, file));

    expect(
      offenders,
      `More than one migrations definition module detected. The migrations ` +
        `definition (runMigrations / versionedMigrations) may only live in ` +
        `db/migrations.ts (Requirement 27.2, 27.5). ` +
        `Offending file(s): ${offenders.join(', ')}`
    ).toEqual([]);

    expect(migrationsDefinitions).toHaveLength(1);
  });

  it('fails the build if a flat routes/auth.ts coexists with the routes/auth/ tree (Req 27.3, 27.5)', () => {
    const authTreeDir = resolve(SRC_DIR, 'routes', 'auth');
    const flatAuthModule = resolve(SRC_DIR, 'routes', 'auth.ts');

    const hasAuthTree = existsSync(authTreeDir) && statSync(authTreeDir).isDirectory();
    const hasFlatAuthModule = existsSync(flatAuthModule);

    // Sanity: the canonical auth route definitions live in the routes/auth/ tree.
    expect(
      hasAuthTree,
      `Expected canonical authentication routes in routes/auth/ tree to exist.`
    ).toBe(true);

    expect(
      hasFlatAuthModule,
      `Duplicate authentication route definitions detected: a flat ` +
        `routes/auth.ts must not coexist with the routes/auth/ tree ` +
        `(Requirement 27.3, 27.5). Remove routes/auth.ts in favor of routes/auth/.`
    ).toBe(false);
  });
});

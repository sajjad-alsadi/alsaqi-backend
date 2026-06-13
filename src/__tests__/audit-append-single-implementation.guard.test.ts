/**
 * Static-analysis guard: a single audit hash-chain append implementation.
 *
 * Requirement 27.1 mandates exactly one audit-log append implementation, and
 * Requirement 27.5 mandates that static analysis FAIL the build if more than
 * one implementation of audit-log append is detected.
 *
 * This test scans the `src` tree for the tamper-evident audit hash-chain
 * writer and fails if more than one implementation exists. The single
 * canonical writer is `src/services/AuditChainService.ts`
 * (`AuditChainService.append`); `BaseService.logAudit` and
 * `AuthService.logAudit` now delegate to it and no longer contain the writer.
 *
 * Heuristic (deliberately robust, not brittle): a file is counted as a
 * hash-chain audit-append implementation only when it BOTH
 *   1. computes a SHA-256 hash itself via `createHash('sha256')` (a real hash
 *      computation, not a mere textual reference to a `*_sha256` column), AND
 *   2. inserts a row into the canonical `audit_trail` table whose inserted
 *      columns include the chain linkage `previous_hash`.
 *
 * Schema/data-migration files (e.g. `db/migrations.ts`) are intentionally NOT
 * counted: they may add a `previous_hash` DDL column, define an unrelated
 * `checksum_sha256` column, and copy rows into `audit_trail_partitioned`, but
 * they never compute a chain hash, so neither condition above holds for the
 * actual chain writer. Plain `INSERT INTO audit_trail (...)` writers that do
 * NOT compute a hash chain are likewise not counted, and the thin delegating
 * `logAudit` methods are not counted because they contain no INSERT and
 * compute no hash.
 *
 * **Validates: Requirements 27.1, 27.5**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file allowed to contain the audit hash-chain writer. */
const CANONICAL_WRITER = resolve(SRC_DIR, 'services', 'AuditChainService.ts');

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
 * Decides whether a file's contents genuinely implement the audit hash-chain
 * writer.
 *
 * A real hash-chain append does two things that, taken together, are unique to
 * the canonical writer:
 *
 *   1. It COMPUTES a SHA-256 hash itself via `createHash('sha256')`. This is a
 *      real hash computation, not merely a textual reference to a column named
 *      `checksum_sha256` or the literal string "sha256" — a schema/data
 *      migration that defines a `checksum_sha256` column does not compute a
 *      chain hash and must not be counted.
 *
 *   2. It INSERTs a row into the canonical `audit_trail` table whose inserted
 *      columns include the chain linkage `previous_hash`. The `\b` after
 *      `audit_trail` deliberately excludes `audit_trail_partitioned` (the
 *      range-partition data migration in `db/migrations.ts`), and requiring
 *      `previous_hash` inside the same INSERT statement excludes plain,
 *      non-chained `audit_trail` inserts and bulk data-migration copies that
 *      move only the base columns.
 *
 * Both conditions must hold. This is what keeps the guard from flagging
 * `db/migrations.ts` (which adds a `previous_hash` DDL column, defines an
 * unrelated `checksum_sha256` column, and copies rows into
 * `audit_trail_partitioned`, but never computes a chain hash) while still
 * failing if a genuine second writer is introduced.
 */
function isHashChainAppendImplementation(contents: string): boolean {
  // (1) Real SHA-256 computation (not just a reference to a `*_sha256` column).
  const computesSha256 = /createHash\(\s*['"`]sha-?256['"`]\s*\)/i.test(contents);
  if (!computesSha256) return false;

  // (2) Inserts a hash-chain row into the canonical `audit_trail` table. The
  // `\b` boundary excludes `audit_trail_partitioned`, and `[^;]*previous_hash`
  // requires the chain-linkage column within the same INSERT statement.
  const insertsHashChainRow = /insert\s+into\s+audit_trail\b[^;]*previous_hash/i.test(contents);

  return insertsHashChainRow;
}

describe('audit hash-chain append: single implementation guard (Req 27.1, 27.5)', () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  const implementations = sourceFiles.filter((file) =>
    isHashChainAppendImplementation(readFileSync(file, 'utf-8'))
  );

  it('detects the canonical AuditChainService writer (sanity check)', () => {
    // If this fails the heuristic has drifted and would no longer catch a
    // second implementation, so the guard would give a false sense of safety.
    expect(implementations).toContain(CANONICAL_WRITER);
  });

  it('fails the build if more than one audit hash-chain append implementation exists', () => {
    const offenders = implementations
      .filter((file) => file !== CANONICAL_WRITER)
      .map((file) => relative(SRC_DIR, file));

    expect(
      offenders,
      `More than one audit hash-chain append implementation detected. The audit ` +
        `hash-chain may only be written by services/AuditChainService.ts ` +
        `(Requirement 27.1, 27.5). Offending file(s): ${offenders.join(', ')}`
    ).toEqual([]);

    // Exactly one implementation total (the canonical writer).
    expect(implementations).toHaveLength(1);
  });
});

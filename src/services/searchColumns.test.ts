/**
 * Property-based tests for the search-column helpers (`src/services/searchColumns.ts`).
 *
 * Spec: .kiro/specs/backend-security-hardening (task 5.5)
 *
 * Feature: backend-security-hardening, Property 8: Search clause uses only configured columns
 *
 * Property 8 (Validates: Requirements 5.1, 5.2, 5.4):
 *   For any table and search term, `buildSearchClause` returns `null` (no clause)
 *   when the term is null/empty/whitespace or the table has no configured search
 *   columns, and otherwise returns a clause that references only columns in that
 *   table's configured search set — never falling back to `title`, `name`, or
 *   `description`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildSearchClause,
  getSearchColumns,
  TABLE_SEARCH_COLUMNS,
} from './searchColumns';

const NUM_RUNS = 300;

/** Tables that have at least one configured search column. */
const CONFIGURED_TABLES = Object.keys(TABLE_SEARCH_COLUMNS);

/**
 * Extract the column identifiers referenced by a clause of the form
 * `(colA LIKE ? OR colB LIKE ?)`. Each predicate is `<col> LIKE ?`.
 */
function columnsReferencedBy(clause: string): string[] {
  const inner = clause.replace(/^\(/, '').replace(/\)$/, '');
  return inner.split(' OR ').map((pred) => pred.replace(/ LIKE \?$/, '').trim());
}

/** Generator of whitespace-only / empty strings (Req 5.4 blanks). */
const blankTerm = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 6 })
  .map((chars) => chars.join(''));

/** Generator of non-blank search terms (have at least one non-whitespace char). */
const nonBlankTerm = fc.string({ minLength: 1 }).filter((s) => s.trim() !== '');

/** Generator of table names that are NOT configured. */
const unconfiguredTable = fc
  .string()
  .filter((name) => !(name in TABLE_SEARCH_COLUMNS));

/** Generator of a configured table name. */
const configuredTable = fc.constantFrom(...CONFIGURED_TABLES);

describe('Feature: backend-security-hardening, Property 8: Search clause uses only configured columns', () => {
  it('returns null for any null/undefined term regardless of table (Req 5.4)', () => {
    fc.assert(
      fc.property(
        fc.oneof(configuredTable, unconfiguredTable),
        fc.constantFrom(null, undefined),
        (table, term) => {
          expect(buildSearchClause(table, term as null | undefined)).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns null for any empty or whitespace-only term, even on configured tables (Req 5.4)', () => {
    fc.assert(
      fc.property(configuredTable, blankTerm, (table, term) => {
        expect(buildSearchClause(table, term)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns null for tables with no configured columns, even with a valid term (Req 5.2)', () => {
    fc.assert(
      fc.property(unconfiguredTable, nonBlankTerm, (table, term) => {
        expect(getSearchColumns(table)).toEqual([]);
        expect(buildSearchClause(table, term)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces a clause referencing ONLY the table\'s configured columns (Req 5.1)', () => {
    fc.assert(
      fc.property(configuredTable, nonBlankTerm, (table, term) => {
        const result = buildSearchClause(table, term);
        expect(result).not.toBeNull();

        const configured = new Set(getSearchColumns(table));
        const referenced = columnsReferencedBy(result!.clause);

        // Every referenced column is in the configured set...
        for (const col of referenced) {
          expect(configured.has(col)).toBe(true);
        }
        // ...and the clause references exactly the configured columns.
        expect(new Set(referenced)).toEqual(configured);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never falls back to title/name/description when those are not configured (Req 5.1, 5.2)', () => {
    const FALLBACKS = ['title', 'name', 'description'];
    fc.assert(
      fc.property(configuredTable, nonBlankTerm, (table, term) => {
        const result = buildSearchClause(table, term);
        if (result === null) return;

        const referenced = columnsReferencedBy(result.clause);
        const configured = new Set(getSearchColumns(table));
        for (const fallback of FALLBACKS) {
          // A fallback column may only appear if it is genuinely configured.
          if (!configured.has(fallback)) {
            expect(referenced).not.toContain(fallback);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('binds exactly one %term% LIKE parameter per referenced column (Req 5.1)', () => {
    fc.assert(
      fc.property(configuredTable, nonBlankTerm, (table, term) => {
        const result = buildSearchClause(table, term);
        expect(result).not.toBeNull();

        const referenced = columnsReferencedBy(result!.clause);
        const expected = `%${term.trim()}%`;

        expect(result!.params).toHaveLength(referenced.length);
        for (const p of result!.params) {
          expect(p).toBe(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

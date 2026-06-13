/**
 * Configurable search columns for list queries (Base_Service search clause).
 *
 * This module is the single source of truth for which columns each table may be
 * searched on. It is pure (no side effects, no I/O) so it can be unit- and
 * property-tested in isolation, and consumed by `BaseService.findAll`.
 *
 * Behavioural contract:
 *  - A table with NO configured search columns produces NO search clause; the
 *    list query runs unfiltered (Req 5.2). There is NO `title`/`name`/`description`
 *    fallback.
 *  - A null/empty/whitespace-only search term produces NO search clause (Req 5.4).
 *  - When a clause is produced it references ONLY the explicitly configured
 *    columns for that table (Req 5.1).
 *
 * Requirements: 5.1, 5.2, 5.4
 */

/**
 * table name -> explicit, ordered set of searchable columns.
 *
 * Tables absent from this map have NO search columns: searching them produces a
 * successful, unfiltered result rather than a server error. To make a new table
 * searchable, add an entry here listing only columns that actually exist on it.
 */
export const TABLE_SEARCH_COLUMNS: Record<string, readonly string[]> = {
  audit_plans: ['title', 'plan_code', 'department', 'lead_auditor'],
  audit_tasks: ['title', 'task_number', 'audit_type'],
  audit_programs: ['program_title', 'program_code', 'audit_area'],
  audit_findings: ['title', 'description', 'finding_number'],
  recommendations: ['rec_number', 'department', 'action_plan'],
  risk_register: ['risk_id', 'description', 'owner'],
  compliance_items: ['ref_number', 'title', 'notes'],
};

/**
 * Returns the explicitly configured search columns for a table.
 *
 * Returns an empty array when the table has no configured search columns. The
 * returned array is never a fabricated `title`/`name`/`description` fallback
 * (Req 5.2).
 */
export function getSearchColumns(tableName: string): readonly string[] {
  return TABLE_SEARCH_COLUMNS[tableName] ?? [];
}

/** A SQL search clause fragment and its bound LIKE parameters. */
export interface SearchClause {
  /**
   * Parenthesised `OR` of `column LIKE ?` predicates, e.g.
   * `(title LIKE ? OR plan_code LIKE ?)`. Does NOT include a leading `WHERE`/`AND`;
   * the caller composes it into the surrounding where clause.
   */
  clause: string;
  /** One `%term%` pattern per referenced column, positionally bound to the `?`s. */
  params: string[];
}

/**
 * Builds a search clause for `tableName` and `term`, or returns `null` when no
 * clause should apply.
 *
 * Returns `null` when:
 *  - the table has no configured search columns (Req 5.2), or
 *  - the term is null, undefined, empty, or whitespace-only (Req 5.4).
 *
 * When non-null, the clause references ONLY the configured columns for the table
 * (Req 5.1) and binds one `%term%` LIKE parameter per column. There is no
 * `title`/`name`/`description` fallback.
 */
export function buildSearchClause(
  tableName: string,
  term: string | null | undefined
): SearchClause | null {
  if (term === null || term === undefined) {
    return null;
  }

  const trimmed = term.trim();
  if (trimmed === '') {
    return null;
  }

  const columns = getSearchColumns(tableName);
  if (columns.length === 0) {
    return null;
  }

  const pattern = `%${trimmed}%`;
  const clause = '(' + columns.map((col) => `${col} LIKE ?`).join(' OR ') + ')';
  const params = columns.map(() => pattern);

  return { clause, params };
}

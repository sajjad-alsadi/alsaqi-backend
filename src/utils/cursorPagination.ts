/**
 * Cursor-based Pagination Utility
 *
 * Provides reusable cursor-based pagination for queries on large tables (> 10,000 records).
 * Uses base64-encoded sort key as cursor for efficient keyset pagination.
 *
 * - Default page size: 20
 * - Max page size: 100
 * - Returns: { data, nextCursor, hasMore }
 *
 * Requirements: 14.2
 */

import type { IDBWrapper } from '../db/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default number of items per page */
export const DEFAULT_CURSOR_PAGE_SIZE = 20;

/** Maximum allowed items per page */
export const MAX_CURSOR_PAGE_SIZE = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Decoded cursor payload containing the sort key value and column used for ordering.
 */
export interface DecodedCursor {
  /** The value of the sort column at the cursor position */
  value: string;
  /** The column name used for sorting */
  column: string;
}

/**
 * Options for cursor-based pagination queries.
 */
export interface CursorPaginationOptions {
  /** The encoded cursor string from the previous response (undefined for first page) */
  cursor?: string | null;
  /** Number of items to return per page (default: 20, max: 100) */
  pageSize?: number;
  /** The column to sort/paginate by (default: 'created_at') */
  sortColumn?: string;
  /** Sort direction: 'ASC' or 'DESC' (default: 'DESC') */
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * Result of a cursor-based paginated query.
 */
export interface CursorPaginatedResult<T> {
  /** The page of data records */
  data: T[];
  /** Encoded cursor for fetching the next page (null if no more pages) */
  nextCursor: string | null;
  /** Whether there are more records after this page */
  hasMore: boolean;
}

/**
 * Internal parameters computed from cursor pagination options for building SQL queries.
 */
export interface CursorQueryParams {
  /** The WHERE clause condition for cursor filtering (empty string if no cursor) */
  whereClause: string;
  /** The parameter values for the cursor WHERE clause */
  whereParams: any[];
  /** The ORDER BY clause */
  orderByClause: string;
  /** The LIMIT value (pageSize + 1 to detect hasMore) */
  limit: number;
  /** The validated page size */
  pageSize: number;
  /** The sort column name */
  sortColumn: string;
  /** The sort direction */
  sortDirection: 'ASC' | 'DESC';
}

// ─── Cursor Encoding/Decoding ─────────────────────────────────────────────────

/**
 * Encodes a cursor from the sort key value and column name.
 * Uses base64 encoding of a JSON payload.
 *
 * @param value - The value of the sort column at the cursor position
 * @param column - The column name used for sorting
 * @returns Base64-encoded cursor string
 */
export function encodeCursor(value: string, column: string): string {
  const payload: DecodedCursor = { value, column };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * Decodes a cursor string back into its value and column components.
 *
 * @param cursor - Base64-encoded cursor string
 * @returns Decoded cursor payload, or null if the cursor is invalid
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.value === 'string' &&
      typeof parsed.column === 'string' &&
      parsed.column.length > 0
    ) {
      return { value: parsed.value, column: parsed.column };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Page Size Validation ─────────────────────────────────────────────────────

/**
 * Validates and clamps page size to allowed bounds.
 *
 * @param pageSize - Requested page size (may be undefined or out of range)
 * @returns Validated page size between 1 and MAX_CURSOR_PAGE_SIZE
 */
export function validatePageSize(pageSize?: number): number {
  if (pageSize === undefined || pageSize === null || isNaN(pageSize)) {
    return DEFAULT_CURSOR_PAGE_SIZE;
  }
  return Math.min(MAX_CURSOR_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

// ─── Query Parameter Builder ──────────────────────────────────────────────────

/**
 * Builds SQL query parameters for cursor-based pagination.
 * Validates identifiers, computes WHERE/ORDER BY/LIMIT clauses.
 *
 * @param options - Cursor pagination options
 * @returns Computed query parameters for building the SQL query
 */
export function buildCursorQueryParams(options: CursorPaginationOptions): CursorQueryParams {
  const pageSize = validatePageSize(options.pageSize);
  const sortColumn = validateColumnName(options.sortColumn || 'created_at');
  const sortDirection = options.sortDirection === 'ASC' ? 'ASC' : 'DESC';

  let whereClause = '';
  let whereParams: any[] = [];

  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      // Validate that the cursor column matches the expected sort column
      if (decoded.column === sortColumn) {
        const operator = sortDirection === 'DESC' ? '<' : '>';
        whereClause = `${sortColumn} ${operator} ?`;
        whereParams = [decoded.value];
      }
    }
  }

  const orderByClause = `${sortColumn} ${sortDirection}`;
  // Fetch one extra record to determine hasMore
  const limit = pageSize + 1;

  return {
    whereClause,
    whereParams,
    orderByClause,
    limit,
    pageSize,
    sortColumn,
    sortDirection,
  };
}

// ─── Column Name Validation ───────────────────────────────────────────────────

/**
 * Validates a column name to prevent SQL injection.
 * Only allows alphanumeric characters and underscores.
 *
 * @param column - Column name to validate
 * @returns Validated column name
 * @throws Error if column name contains invalid characters
 */
function validateColumnName(column: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`Invalid column name for cursor pagination: ${column}`);
  }
  return column;
}

// ─── Result Processing ────────────────────────────────────────────────────────

/**
 * Processes raw query results into a cursor-paginated response.
 * Determines hasMore by checking if more records than pageSize were returned.
 * Generates the nextCursor from the last item in the page.
 *
 * @param rows - Raw query result rows (should contain pageSize + 1 items if more exist)
 * @param pageSize - The validated page size
 * @param sortColumn - The column used for sorting/cursor generation
 * @returns Cursor-paginated result with data, nextCursor, and hasMore
 */
export function processCursorResults<T extends Record<string, any>>(
  rows: T[],
  pageSize: number,
  sortColumn: string
): CursorPaginatedResult<T> {
  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const lastItem = data[data.length - 1];
    const cursorValue = String(lastItem[sortColumn] ?? '');
    nextCursor = encodeCursor(cursorValue, sortColumn);
  }

  return { data, nextCursor, hasMore };
}

// ─── High-Level Pagination Function ──────────────────────────────────────────

/**
 * Executes a cursor-based paginated query against the database.
 *
 * This is the main entry point for route handlers. It handles:
 * 1. Parsing and validating cursor/pageSize options
 * 2. Building the paginated SQL query
 * 3. Executing the query via the database wrapper
 * 4. Processing results into { data, nextCursor, hasMore }
 *
 * @param db - Database wrapper instance (IDBWrapper)
 * @param tableName - The table to query (validated for SQL safety)
 * @param options - Cursor pagination options (cursor, pageSize, sortColumn, sortDirection)
 * @param additionalWhere - Optional additional WHERE clause (e.g., "deleted_at IS NULL")
 * @param additionalParams - Parameters for the additional WHERE clause
 * @param selectColumns - Columns to select (default: '*')
 * @returns Promise resolving to cursor-paginated result
 *
 * @example
 * ```ts
 * const result = await cursorPaginate(db, 'audit_findings', {
 *   cursor: req.query.cursor as string,
 *   pageSize: 20,
 *   sortColumn: 'created_at',
 *   sortDirection: 'DESC',
 * }, 'deleted_at IS NULL');
 * // result: { data: [...], nextCursor: 'abc123...', hasMore: true }
 * ```
 */
export async function cursorPaginate<T extends Record<string, any>>(
  db: IDBWrapper,
  tableName: string,
  options: CursorPaginationOptions = {},
  additionalWhere?: string,
  additionalParams?: any[],
  selectColumns: string = '*'
): Promise<CursorPaginatedResult<T>> {
  // Validate table name
  const validatedTable = db.validateIdentifier(tableName);

  // Build cursor query parameters
  const queryParams = buildCursorQueryParams(options);

  // Build WHERE clause combining cursor condition and additional filters
  const whereParts: string[] = [];
  const allParams: any[] = [];

  if (additionalWhere) {
    whereParts.push(additionalWhere);
    if (additionalParams) {
      allParams.push(...additionalParams);
    }
  }

  if (queryParams.whereClause) {
    whereParts.push(queryParams.whereClause);
    allParams.push(...queryParams.whereParams);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // Build the full query
  const sql = `SELECT ${selectColumns} FROM ${validatedTable} ${whereClause} ORDER BY ${queryParams.orderByClause} LIMIT ?`;
  allParams.push(queryParams.limit);

  // Execute query
  const rows = await db.prepare(sql).all(...allParams) as T[];

  // Process and return results
  return processCursorResults(rows, queryParams.pageSize, queryParams.sortColumn);
}

// ─── Request Query Parser ─────────────────────────────────────────────────────

/**
 * Parses cursor pagination parameters from an Express request query object.
 * Convenience function for use in route handlers.
 *
 * @param query - Express request query object (req.query)
 * @returns Parsed cursor pagination options
 *
 * @example
 * ```ts
 * router.get('/findings', async (req, res) => {
 *   const options = parseCursorParams(req.query);
 *   const result = await cursorPaginate(db, 'audit_findings', options, 'deleted_at IS NULL');
 *   res.json(createSuccessResponse({ data: result.data, ...result }));
 * });
 * ```
 */
export function parseCursorParams(query: Record<string, any>): CursorPaginationOptions {
  return {
    cursor: query.cursor || null,
    pageSize: query.pageSize ? parseInt(query.pageSize, 10) : undefined,
    sortColumn: query.sortBy || undefined,
    sortDirection: query.sortDirection === 'ASC' ? 'ASC' : query.sortDirection === 'DESC' ? 'DESC' : undefined,
  };
}

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
import { ValidationError } from './errors.js';

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

// ════════════════════════════════════════════════════════════════════════════
// Keyset Pagination (composite deterministic order keys) — Requirement 6
// ════════════════════════════════════════════════════════════════════════════
//
// Large-table list endpoints use keyset (cursor) pagination ordered by a
// composite key that uniquely and deterministically orders every row (e.g.
// `(created_at, id)`). The cursor is an opaque base64url-encoded JSON object of
// the composite order-key values, e.g. `{ "created_at": "...", "id": "..." }`.
// A malformed/undecodable cursor is rejected with an invalid-cursor error and
// returns no page rows (Req 6.6).

// ─── Keyset Constants ─────────────────────────────────────────────────────────

/** Minimum allowed keyset page size (Req 6.2). */
export const MIN_KEYSET_PAGE_SIZE = 1;

/** Maximum allowed keyset page size (Req 6.2). */
export const MAX_KEYSET_PAGE_SIZE = 100;

/** Default keyset page size when none is supplied (Req 6.2). */
export const DEFAULT_KEYSET_PAGE_SIZE = 25;

// ─── Keyset Table Registry ────────────────────────────────────────────────────

/**
 * Configuration for a keyset-enabled table.
 */
export interface KeysetTableConfig {
  /**
   * The ordered list of columns composing the deterministic order key. The
   * final column MUST be unique (e.g. the primary key) so that the composite
   * key uniquely and deterministically orders every row in the result set
   * (Req 6.1).
   */
  orderKey: readonly string[];
}

/**
 * Registry of tables that opt in to keyset (cursor) pagination for
 * large-table access (Req 6.1). Each order key ends with the unique `id`
 * column to guarantee a total, deterministic ordering of every row.
 */
export const KEYSET_TABLES: Readonly<Record<string, KeysetTableConfig>> = {
  audit_findings: { orderKey: ['created_at', 'id'] },
  audit_tasks: { orderKey: ['created_at', 'id'] },
  audit_trail: { orderKey: ['created_at', 'id'] },
  recommendations: { orderKey: ['created_at', 'id'] },
  risk_register: { orderKey: ['created_at', 'id'] },
  incoming_correspondence: { orderKey: ['created_at', 'id'] },
  outgoing_correspondence: { orderKey: ['created_at', 'id'] },
  correspondence_status_history: { orderKey: ['created_at', 'id'] },
  file_access_logs: { orderKey: ['created_at', 'id'] },
  request_logs: { orderKey: ['created_at', 'id'] },
};

/**
 * Returns true if the given table is configured for keyset pagination.
 *
 * @param tableName - The table to check
 */
export function isKeysetTable(tableName: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEYSET_TABLES, tableName);
}

/**
 * Returns the composite order key for a keyset-configured table, or null if
 * the table is not configured for keyset pagination.
 *
 * @param tableName - The table to look up
 */
export function getKeysetOrderKey(tableName: string): readonly string[] | null {
  return isKeysetTable(tableName) ? KEYSET_TABLES[tableName].orderKey : null;
}

// ─── Keyset Types ─────────────────────────────────────────────────────────────

/**
 * A decoded keyset cursor: the value of each order-key column at the cursor
 * position. Values are stringified for opaque, lossless transport.
 */
export type KeysetCursorValues = Record<string, string>;

/**
 * Request parameters for a keyset-paginated query.
 */
export interface KeysetPageRequest {
  /** The encoded cursor from a previous response (undefined/null for first page). */
  cursor?: string | null;
  /** Requested page size; clamped to 1..100, defaulting to 25 (Req 6.2). */
  pageSize?: number;
  /** Sort direction across the composite order key (default: 'DESC'). */
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * A page of keyset-paginated results.
 */
export interface KeysetPage<T> {
  /** The page of data records. */
  data: T[];
  /** Cursor for the next page, or null when no more rows remain (Req 6.3, 6.4). */
  nextCursor: string | null;
}

// ─── Keyset Page-Size Clamping ─────────────────────────────────────────────────

/**
 * Clamps a requested keyset page size to the inclusive range 1..100, defaulting
 * to 25 when the value is absent or not a usable number (Req 6.2).
 *
 * @param pageSize - Requested page size (may be undefined/null/NaN/out-of-range)
 * @returns A page size between {@link MIN_KEYSET_PAGE_SIZE} and {@link MAX_KEYSET_PAGE_SIZE}
 */
export function clampKeysetPageSize(pageSize?: number | null): number {
  if (pageSize === undefined || pageSize === null || !Number.isFinite(pageSize)) {
    return DEFAULT_KEYSET_PAGE_SIZE;
  }
  return Math.min(MAX_KEYSET_PAGE_SIZE, Math.max(MIN_KEYSET_PAGE_SIZE, Math.floor(pageSize)));
}

// ─── Keyset Cursor Encoding/Decoding ───────────────────────────────────────────

/**
 * Encodes an opaque keyset cursor from a row using the table's composite order
 * key. The cursor is a base64url-encoded JSON object mapping each order-key
 * column to its stringified value, preserving order-key order.
 *
 * @param orderKey - The composite order-key columns (in order)
 * @param row - The row at the cursor position
 * @returns An opaque base64url cursor string
 * @throws {ValidationError} If a required order-key value is missing/nullish
 */
export function encodeKeysetCursor(
  orderKey: readonly string[],
  row: Record<string, unknown>
): string {
  const payload: KeysetCursorValues = {};
  for (const column of orderKey) {
    const value = row[column];
    if (value === undefined || value === null) {
      // A null order-key value would break deterministic ordering (Req 6.1).
      throw new ValidationError(`Cannot encode cursor: missing order-key value for "${column}"`);
    }
    payload[column] = String(value);
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * Decodes an opaque keyset cursor into the ordered list of order-key values.
 * Rejects any malformed, undecodable, or shape-mismatched cursor with an
 * invalid-cursor {@link ValidationError} (Req 6.6).
 *
 * @param cursor - The opaque base64url cursor string
 * @param orderKey - The composite order-key columns the cursor must match
 * @returns The order-key values in the same order as `orderKey`
 * @throws {ValidationError} If the cursor cannot be decoded to a valid position
 */
export function decodeKeysetCursor(
  cursor: string,
  orderKey: readonly string[]
): string[] {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new ValidationError('Invalid pagination cursor');
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Invalid pagination cursor');
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);

  // The cursor must contain exactly the configured order-key columns — no more,
  // no fewer — so it maps to a valid ordered-key position (Req 6.6).
  if (keys.length !== orderKey.length) {
    throw new ValidationError('Invalid pagination cursor');
  }

  const values: string[] = [];
  for (const column of orderKey) {
    const value = record[column];
    if (typeof value !== 'string') {
      throw new ValidationError('Invalid pagination cursor');
    }
    values.push(value);
  }

  return values;
}

// ─── Keyset Query Building ──────────────────────────────────────────────────────

/**
 * The WHERE condition and ORDER BY clause for a composite keyset query.
 */
export interface KeysetClause {
  /** Row-value comparison WHERE condition, or empty string for the first page. */
  whereClause: string;
  /** Bound parameter values for the WHERE condition. */
  whereParams: string[];
  /** ORDER BY clause across the full composite order key. */
  orderByClause: string;
}

/**
 * Builds the keyset WHERE/ORDER BY clauses for a composite order key.
 *
 * Uses a row-value comparison `(c1, c2, …, cn) < (?, ?, …, ?)` (for DESC, or
 * `>` for ASC) so paging strictly follows the deterministic composite order
 * (Req 6.1). When no cursor is supplied the WHERE condition is empty (first
 * page). A supplied cursor is decoded and rejected if invalid (Req 6.6).
 *
 * @param orderKey - The composite order-key columns (in order)
 * @param cursor - The encoded cursor, or null/undefined for the first page
 * @param sortDirection - Sort direction across the order key (default 'DESC')
 * @throws {ValidationError} If a supplied cursor is invalid
 */
export function buildKeysetClause(
  orderKey: readonly string[],
  cursor?: string | null,
  sortDirection: 'ASC' | 'DESC' = 'DESC'
): KeysetClause {
  if (orderKey.length === 0) {
    throw new ValidationError('Keyset pagination requires a non-empty order key');
  }

  const columns = orderKey.map(validateColumnName);
  const direction = sortDirection === 'ASC' ? 'ASC' : 'DESC';
  const orderByClause = columns.map((col) => `${col} ${direction}`).join(', ');

  let whereClause = '';
  let whereParams: string[] = [];

  if (cursor !== undefined && cursor !== null && cursor !== '') {
    const values = decodeKeysetCursor(cursor, columns);
    const operator = direction === 'DESC' ? '<' : '>';
    const lhs = `(${columns.join(', ')})`;
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    whereClause = `${lhs} ${operator} ${placeholders}`;
    whereParams = values;
  }

  return { whereClause, whereParams, orderByClause };
}

// ─── Keyset Result Processing ───────────────────────────────────────────────────

/**
 * Processes raw keyset query rows into a {@link KeysetPage}. Determines whether
 * more rows remain by checking for the extra sentinel row (pageSize + 1) and
 * builds a non-null `nextCursor` from the last item of the page if and only if
 * more rows remain (Req 6.3, 6.4).
 *
 * @param rows - Raw rows (should contain pageSize + 1 items when more remain)
 * @param pageSize - The clamped page size
 * @param orderKey - The composite order-key columns used to build the cursor
 */
export function processKeysetResults<T extends Record<string, unknown>>(
  rows: T[],
  pageSize: number,
  orderKey: readonly string[]
): KeysetPage<T> {
  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    nextCursor = encodeKeysetCursor(orderKey, data[data.length - 1]);
  }

  return { data, nextCursor };
}

// ─── High-Level Keyset Pagination ───────────────────────────────────────────────

/**
 * Executes a keyset-paginated query against a keyset-configured table.
 *
 * Resolves the table's composite order key, clamps the page size to 1..100
 * (default 25), builds the row-value comparison WHERE/ORDER BY clauses, fetches
 * `pageSize + 1` rows to detect a following page, and returns `{ data,
 * nextCursor }`. A malformed cursor is rejected with an invalid-cursor error
 * before any rows are read (Req 6.6).
 *
 * @param db - Database wrapper instance (IDBWrapper)
 * @param tableName - A table registered in {@link KEYSET_TABLES}
 * @param request - Keyset page request (cursor, pageSize, sortDirection)
 * @param additionalWhere - Optional extra WHERE clause (e.g. "deleted_at IS NULL")
 * @param additionalParams - Parameters for the additional WHERE clause
 * @param selectColumns - Columns to select (default '*')
 * @throws {ValidationError} If the table is not keyset-configured or the cursor is invalid
 */
export async function keysetPaginate<T extends Record<string, unknown>>(
  db: IDBWrapper,
  tableName: string,
  request: KeysetPageRequest = {},
  additionalWhere?: string,
  additionalParams?: unknown[],
  selectColumns: string = '*'
): Promise<KeysetPage<T>> {
  const orderKey = getKeysetOrderKey(tableName);
  if (!orderKey) {
    throw new ValidationError(`Table is not configured for keyset pagination: ${tableName}`);
  }

  const validatedTable = db.validateIdentifier(tableName);
  const pageSize = clampKeysetPageSize(request.pageSize);
  const { whereClause, whereParams, orderByClause } = buildKeysetClause(
    orderKey,
    request.cursor,
    request.sortDirection
  );

  const whereParts: string[] = [];
  const allParams: unknown[] = [];

  if (additionalWhere) {
    whereParts.push(additionalWhere);
    if (additionalParams) {
      allParams.push(...additionalParams);
    }
  }

  if (whereClause) {
    whereParts.push(whereClause);
    allParams.push(...whereParams);
  }

  const fullWhere = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  // Fetch one extra row to determine whether a following page exists.
  const limit = pageSize + 1;

  const sql = `SELECT ${selectColumns} FROM ${validatedTable} ${fullWhere} ORDER BY ${orderByClause} LIMIT ?`;
  allParams.push(limit);

  const rows = (await db.prepare(sql).all(...allParams)) as T[];

  return processKeysetResults(rows, pageSize, orderKey);
}

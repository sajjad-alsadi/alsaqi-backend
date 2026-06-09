/**
 * Unified Pagination Service for the AL-SAQI API.
 *
 * Provides consistent pagination logic across all list endpoints:
 * - Validates and parses `page` and `pageSize` query parameters
 * - Computes pagination metadata (totalPages, hasNext, hasPrev)
 * - Generates SQL LIMIT/OFFSET clauses
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import { ValidationError } from './errors';
import type { PaginationMeta } from '@alsaqi/shared';

/** Default page number when not provided */
export const DEFAULT_PAGE = 1;

/** Default page size when not provided */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum allowed page size (values above this are capped silently) */
export const MAX_PAGE_SIZE = 100;

/**
 * Parsed and validated pagination parameters.
 */
export interface ParsedPaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

/**
 * Parses and validates pagination query parameters.
 *
 * - Defaults to page 1, pageSize 20 when not provided
 * - Caps pageSize at 100 without error
 * - Rejects invalid page/pageSize (< 1, non-integer, non-numeric) with 400 ValidationError
 *
 * @param query - The query parameters object (typically req.query)
 * @returns Validated pagination parameters with computed offset
 * @throws ValidationError if page or pageSize is invalid
 */
export function parsePaginationParams(
  query: Record<string, any>
): ParsedPaginationParams {
  let page = DEFAULT_PAGE;
  let pageSize = DEFAULT_PAGE_SIZE;

  // Parse page parameter
  if (query.page !== undefined && query.page !== null && query.page !== '') {
    page = validatePaginationParam(query.page, 'page');
  }

  // Parse pageSize parameter
  if (query.pageSize !== undefined && query.pageSize !== null && query.pageSize !== '') {
    pageSize = validatePaginationParam(query.pageSize, 'pageSize');
    // Cap pageSize at MAX_PAGE_SIZE without error (Requirement 5.4)
    if (pageSize > MAX_PAGE_SIZE) {
      pageSize = MAX_PAGE_SIZE;
    }
  }

  const offset = (page - 1) * pageSize;

  return { page, pageSize, offset };
}

/**
 * Validates a single pagination parameter value.
 *
 * @param value - The raw query parameter value
 * @param paramName - The parameter name for error messages
 * @returns The validated integer value
 * @throws ValidationError if the value is non-numeric, non-integer, or less than 1
 */
function validatePaginationParam(value: any, paramName: string): number {
  // Convert to string for consistent parsing
  const strValue = String(value).trim();

  // Check if it's a valid number
  if (strValue === '' || isNaN(Number(strValue))) {
    throw new ValidationError(
      `Invalid ${paramName}: must be a positive integer`,
      { field: paramName, value, rule: 'numeric' }
    );
  }

  const numValue = Number(strValue);

  // Check if it's an integer
  if (!Number.isInteger(numValue)) {
    throw new ValidationError(
      `Invalid ${paramName}: must be an integer`,
      { field: paramName, value, rule: 'integer' }
    );
  }

  // Check if it's at least 1
  if (numValue < 1) {
    throw new ValidationError(
      `Invalid ${paramName}: must be greater than or equal to 1`,
      { field: paramName, value, rule: 'min' }
    );
  }

  return numValue;
}

/**
 * Computes pagination metadata from page, pageSize, and total record count.
 *
 * - totalPages = ceil(total / pageSize)
 * - hasNext = page < totalPages
 * - hasPrev = page > 1
 * - When page > totalPages: hasNext is false (empty data scenario)
 *
 * @param page - Current page number (1-based)
 * @param pageSize - Number of items per page
 * @param total - Total number of records
 * @returns PaginationMeta object
 */
export function computePaginationMeta(
  page: number,
  pageSize: number,
  total: number
): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext,
    hasPrev,
  };
}

/**
 * Appends LIMIT and OFFSET clauses to a SQL query string for pagination.
 *
 * @param query - The base SQL query string
 * @param page - Current page number (1-based)
 * @param pageSize - Number of items per page
 * @returns The query string with LIMIT and OFFSET appended
 */
export function paginateQuery(
  query: string,
  page: number,
  pageSize: number
): string {
  const offset = (page - 1) * pageSize;
  return `${query} LIMIT ${pageSize} OFFSET ${offset}`;
}

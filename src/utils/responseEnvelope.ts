/**
 * Response envelope utilities for wrapping route handler responses
 * in the standard ApiResponse format.
 *
 * Every response includes: requestId, timestamp, version, and optional pagination.
 */

import { v4 as uuidv4 } from 'uuid';
import { API_VERSION } from '@alsaqi/shared';
import type { PaginationMeta, SuccessResponse, ErrorResponse } from '@alsaqi/shared';

// ─── Success Response Builder ─────────────────────────────────────────────────

export interface SuccessOptions<T> {
  data: T;
  requestId?: string;
  pagination?: PaginationMeta;
}

/**
 * Wraps data in the standard ApiResponse success envelope.
 * Generates a UUID requestId and ISO timestamp automatically.
 */
export function createSuccessResponse<T>(options: SuccessOptions<T>): SuccessResponse<T> {
  return {
    success: true,
    data: options.data,
    meta: {
      requestId: options.requestId || uuidv4(),
      timestamp: new Date().toISOString(),
      version: API_VERSION,
      ...(options.pagination && { pagination: options.pagination }),
    },
  };
}

// ─── Error Response Builder ───────────────────────────────────────────────────

export interface ErrorOptions {
  code: string;
  message: string;
  traceId?: string;
  requestId?: string;
  details?: Array<{ path: string; message: string; code: string }>;
}

/**
 * Creates a standard ApiResponse error envelope.
 * Generates a UUID requestId and traceId automatically if not provided.
 */
export function createErrorResponse(options: ErrorOptions): ErrorResponse {
  return {
    success: false,
    data: null,
    error: {
      code: options.code,
      message: options.message,
      traceId: options.traceId || uuidv4(),
      ...(options.details && { details: options.details }),
    },
    meta: {
      requestId: options.requestId || uuidv4(),
      timestamp: new Date().toISOString(),
      version: API_VERSION,
    },
  };
}

// ─── Pagination Helper ────────────────────────────────────────────────────────

export interface PaginationInput {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Computes full PaginationMeta from basic pagination input.
 * Defaults pageSize to 20 if not provided or invalid.
 */
export function computePagination(input: PaginationInput): PaginationMeta {
  const page = Math.max(1, input.page || 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize || 20));
  const total = Math.max(0, input.total);
  const totalPages = Math.ceil(total / pageSize);

  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

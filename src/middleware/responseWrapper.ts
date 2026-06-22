/**
 * Unified response wrapper middleware for the @alsaqi/api package.
 *
 * Intercepts res.json() and wraps all JSON responses in the standard
 * ApiResponse<T> envelope format with requestId, timestamp, version, and pagination.
 */

import { Request, Response, NextFunction } from 'express';
import { API_VERSION, ErrorCodes } from '@alsaqi/shared';
import type { ResponseWrapperOptions } from './types.js';

interface ResponseMeta {
  requestId: string;
  timestamp: string;
  version: string;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

interface ApiResponse {
  success: boolean;
  data: any;
  error?: any;
  meta: ResponseMeta;
}

/**
 * Creates a unified response wrapper middleware that intercepts `res.json()`
 * and wraps all JSON responses in the standard `ApiResponse<T>` envelope.
 *
 * The middleware:
 * 1. Records the start time when the request enters
 * 2. Overrides `res.json()` to intercept all JSON responses
 * 3. Checks if the response is already wrapped (has both `success` and `meta` fields)
 * 4. For success responses (200-399): wraps body in `{ success: true, data: body, meta }`
 * 5. For error responses (400+): wraps in `{ success: false, data: null, error: body, meta }`
 * 6. If body has a `pagination` property, moves it to `meta.pagination`
 * 7. Gets requestId from `req.correlationId` (set by correlation ID middleware)
 * 8. Sets `X-Request-Id` and `X-Response-Time` response headers
 */
export function createResponseWrapper(options: ResponseWrapperOptions = {}) {
  const { version = API_VERSION, excludePaths = [] } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Skip wrapping for excluded paths
    if (excludePaths.some((p) => req.path.startsWith(p))) {
      return next();
    }

    // Override res.json to wrap responses
    const originalJson = res.json.bind(res);

    res.json = ((body: any): Response => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;
      const requestId = (req as any).correlationId || 'unknown';

      // Set response headers. The correlation-ID middleware is the single
      // authoritative setter of X-Request-Id (finding 1.40 → 2.40); only set it
      // here as a fallback when that middleware did not run (e.g. responseWrapper
      // used standalone), so the header is written exactly once on the normal path.
      if (!res.hasHeader('X-Request-Id')) {
        res.setHeader('X-Request-Id', requestId);
      }
      res.setHeader('X-Response-Time', `${duration}ms`);

      // If already wrapped (has both `success` and `meta`), pass through
      if (isAlreadyWrapped(body)) {
        return originalJson(body);
      }

      // Build meta object
      const meta: ResponseMeta = {
        requestId,
        timestamp: new Date().toISOString(),
        version,
      };

      // Move pagination from body into meta if present
      if (body && typeof body === 'object' && 'pagination' in body) {
        meta.pagination = body.pagination;
        // Create a copy of body without pagination
        const { pagination, ...bodyWithoutPagination } = body;
        body = bodyWithoutPagination;
      }

      // Build the wrapped response.
      //
      // For error responses, avoid double-wrapping: if the body already carries a
      // nested error OBJECT (e.g. `{ success: false, error: { code, message } }`),
      // lift that inner object straight onto the canonical envelope instead of
      // nesting it under `error.error`. Bodies where `error` is a plain message
      // string (e.g. `{ success: false, error: 'Not found', code: 'NOT_FOUND' }`)
      // or that are themselves the bare error object (e.g. `{ code, message }`)
      // are used as-is, so their top-level fields remain reachable. This yields a
      // single canonical envelope with no `error.error` nesting (Req 2.17).
      const hasNestedErrorObject =
        body &&
        typeof body === 'object' &&
        'error' in body &&
        body.error !== null &&
        typeof body.error === 'object';

      const wrapped: ApiResponse = statusCode >= 400
        ? {
            success: false,
            data: body && typeof body === 'object' && 'data' in body ? body.data : null,
            error: normalizeErrorObject(hasNestedErrorObject ? body.error : body, statusCode),
            meta,
          }
        : {
            success: true,
            data: body ?? null,
            meta,
          };

      return originalJson(wrapped);
    }) as any;

    next();
  };
}

/**
 * Checks if a response body is already wrapped in the ApiResponse envelope.
 * A response is considered already wrapped if it has both `success` (boolean)
 * and `meta` (object) fields at the top level.
 */
function isAlreadyWrapped(body: any): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  return (
    'success' in body &&
    typeof body.success === 'boolean' &&
    'meta' in body &&
    body.meta !== null &&
    typeof body.meta === 'object'
  );
}

/**
 * Maps an HTTP status code to a default, non-empty error code for responses
 * whose body did not carry one. Mirrors the categories used by the global error
 * handler and the shared ErrorCodes constants.
 */
function defaultErrorCodeForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return ErrorCodes.VALIDATION_ERROR;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return (ErrorCodes as Record<string, string>).CONFLICT ?? 'CONFLICT';
    case 429:
      return ErrorCodes.RATE_LIMIT_EXCEEDED;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}

/**
 * Provides a default, non-empty error message for a status code when the body
 * carried no usable message.
 */
function defaultErrorMessageForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Resource not found';
    case 409:
      return 'Conflict';
    case 429:
      return 'Too many requests';
    default:
      return 'An unexpected error occurred';
  }
}

/**
 * Normalizes an error payload into a canonical error object that always carries
 * a non-empty `code` and `message`, so every error envelope satisfies the
 * Error_Envelope invariant (success === false, error.code/message non-empty)
 * regardless of how the producing middleware shaped its raw body.
 *
 * - A plain string payload becomes `{ code, message: <string> }`.
 * - An object payload is preserved, but a missing/empty `code` or `message`
 *   (e.g. the auth middleware's `{ error: 'Unauthorized' }`) is backfilled from
 *   the status code, deriving the message from a top-level `error`/`message`
 *   string when present.
 *
 * This is additive: existing well-formed error objects (with a non-empty code
 * and message) pass through unchanged.
 */
function normalizeErrorObject(payload: any, statusCode: number): any {
  if (typeof payload === 'string') {
    return {
      code: defaultErrorCodeForStatus(statusCode),
      message: payload.length > 0 ? payload : defaultErrorMessageForStatus(statusCode),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      code: defaultErrorCodeForStatus(statusCode),
      message: defaultErrorMessageForStatus(statusCode),
    };
  }

  const result: Record<string, unknown> = { ...payload };

  const hasCode = typeof result.code === 'string' && (result.code as string).length > 0;
  if (!hasCode) {
    result.code = defaultErrorCodeForStatus(statusCode);
  }

  const hasMessage = typeof result.message === 'string' && (result.message as string).length > 0;
  if (!hasMessage) {
    // Fall back to a top-level `error` string (e.g. `{ error: 'Unauthorized' }`)
    // before using the status-derived default.
    const fallback =
      typeof result.error === 'string' && (result.error as string).length > 0
        ? (result.error as string)
        : defaultErrorMessageForStatus(statusCode);
    result.message = fallback;
  }

  return result;
}

/**
 * Default response wrapper middleware instance with standard options.
 */
export const responseWrapperMiddleware = createResponseWrapper();

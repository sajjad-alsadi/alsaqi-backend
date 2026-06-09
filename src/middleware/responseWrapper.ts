/**
 * Unified response wrapper middleware for the @alsaqi/api package.
 *
 * Intercepts res.json() and wraps all JSON responses in the standard
 * ApiResponse<T> envelope format with requestId, timestamp, version, and pagination.
 */

import { Request, Response, NextFunction } from 'express';
import { API_VERSION } from '@alsaqi/shared';
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

      // Set response headers
      res.setHeader('X-Request-Id', requestId);
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

      // Build the wrapped response
      const wrapped: ApiResponse = statusCode >= 400
        ? {
            success: false,
            data: null,
            error: body,
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
 * Default response wrapper middleware instance with standard options.
 */
export const responseWrapperMiddleware = createResponseWrapper();

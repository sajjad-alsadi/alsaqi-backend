/**
 * CORS middleware for the @alsaqi/api package.
 *
 * Reads allowed origins from the ApiServerConfig.corsOrigins array
 * (which is populated from the CORS_ORIGIN environment variable).
 * Rejects requests from unlisted origins by omitting CORS headers.
 * Wildcard (*) is NOT allowed when NODE_ENV is 'production'.
 *
 * Requirements: 8.1
 */

import cors from 'cors';
import type { RequestHandler } from 'express';

export interface CorsMiddlewareOptions {
  /** List of allowed origins (from CORS_ORIGIN env variable, comma-separated) */
  allowedOrigins: string[];
  /** Current environment */
  nodeEnv: 'development' | 'production' | 'test';
}

/**
 * Creates a CORS middleware configured for the API package.
 *
 * - In production: only origins explicitly listed in allowedOrigins are accepted.
 *   Wildcard (*) is never used.
 * - In development/test: if no origins are configured, allows all origins for convenience.
 * - Requests from unlisted origins receive no CORS headers (browser will block them).
 */
export function createCorsMiddleware(options: CorsMiddlewareOptions): RequestHandler {
  const { allowedOrigins, nodeEnv } = options;
  const isProduction = nodeEnv === 'production';

  // In production, filter out any wildcard from the list
  const origins = isProduction
    ? allowedOrigins.filter((o) => o !== '*')
    : allowedOrigins;

  return cors({
    origin: (requestOrigin, callback) => {
      // Requests without origin (same-origin, server-to-server, curl, etc.)
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      // In development with no origins configured, allow all
      if (!isProduction && origins.length === 0) {
        callback(null, true);
        return;
      }

      // Check if the request origin is in the allowed list
      if (origins.includes(requestOrigin)) {
        callback(null, true);
        return;
      }

      // Reject: omit CORS headers by passing false
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-csrf-token',
      'x-correlation-id',
      'X-Idempotency-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-API-Version',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
  });
}

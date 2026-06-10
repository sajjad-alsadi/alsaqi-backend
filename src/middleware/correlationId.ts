/**
 * Correlation ID middleware for the @alsaqi/api package.
 *
 * Generates or propagates a UUID v4 correlation ID on every request.
 * Sets it as a response header, attaches to the request context,
 * and stores in AsyncLocalStorage so all downstream logs include
 * the correlation_id automatically.
 *
 * Requirements: 9.3
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requestContext } from '../utils/logger.js';
import type { CorrelationIdOptions } from './types.js';

/**
 * UUID v4 format regex: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * Validates 36-character string with hex digits and hyphens in correct positions.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string matches UUID format (36 chars, pattern xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
 */
export function isValidUuid(value: string): boolean {
  return typeof value === 'string' && value.length === 36 && UUID_REGEX.test(value);
}

/**
 * Creates a correlation ID middleware with configurable options.
 *
 * The middleware:
 * 1. Checks for an existing correlation ID in the request header (case-insensitive)
 * 2. Validates the header value matches UUID format
 * 3. If valid, uses the provided value as the request ID
 * 4. If missing or invalid, generates a new UUID v4
 * 5. Attaches the ID to the request context (req.correlationId) for downstream use
 * 6. Sets the response header with the correlation ID
 */
export function createCorrelationIdMiddleware(options: CorrelationIdOptions = {}) {
  const {
    headerName = 'x-correlation-id',
    responseHeader = 'X-Request-Id',
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const headerValue = req.headers[headerName.toLowerCase()] as string | undefined;

    // Use provided header value only if it's a valid UUID format
    const correlationId = headerValue && isValidUuid(headerValue)
      ? headerValue
      : uuidv4();

    // Attach to request context for downstream middleware/handlers
    (req as any).correlationId = correlationId;

    // Set response header
    res.setHeader(responseHeader, correlationId);

    // Run the rest of the request inside AsyncLocalStorage context
    // so all downstream logs automatically include correlation_id
    requestContext.run({ correlationId }, () => {
      next();
    });
  };
}

/**
 * Default correlation ID middleware instance with standard options.
 */
export const correlationIdMiddleware = createCorrelationIdMiddleware();

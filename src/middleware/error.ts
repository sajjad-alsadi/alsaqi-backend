/**
 * Error handling middleware for the @alsaqi/api package.
 *
 * Global error handler and 404 handler for unmatched routes.
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ErrorCodes } from '@alsaqi/shared';

/**
 * Determines if the application is running in production mode.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Known database table names that should be sanitized from error messages in production.
 */
const TABLE_NAME_PATTERNS = [
  'audit_tasks',
  'audit_programs',
  'audit_findings',
  'audit_plans',
  'recommendations',
  'users',
  'departments',
  'roles',
  'permissions',
  'notifications',
  'correspondence',
  'attachments',
  'comments',
  'policies',
  'compliance',
  'fraud',
  'integrity',
  'coi',
  'org_entities',
  'job_titles',
  'sessions',
  'settings',
  'app_settings',
  'request_logs',
  'file_access_logs',
  'idempotency_keys',
  'dead_letter_queue',
  'regulatory',
  'executive_reports',
  'pdf_templates',
  'risk_assessments',
];

/**
 * Regex patterns for detecting internal information that should be sanitized.
 */
const SANITIZATION_PATTERNS = {
  filePaths: /(?:[A-Za-z]:)?(?:\/|\\)[\w.\-/\\]+(?:\.(?:ts|js|json|sql|mjs|cjs))?/g,
  sqlFragments: /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|CREATE|ALTER|DROP|INDEX|CONSTRAINT|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|REFERENCES|ON\s+DELETE|ON\s+UPDATE|CASCADE|SET\s+NULL|RETURNING|VALUES|INTO)\b/gi,
  stackTrace: /\s+at\s+.+\(.+:\d+:\d+\)/g,
  constraintColumns: /(?:column|constraint|key)\s*[=:]?\s*["']?[\w]+["']?/gi,
  internalServices: /\b(?:BaseService|AuthService|NotificationService|CrudGenerator|DBWrapper|PGlite)\b/g,
};

/**
 * Sanitizes an error message by removing internal identifiers in production mode.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return 'An error occurred';

  let sanitized = message;

  for (const tableName of TABLE_NAME_PATTERNS) {
    const regex = new RegExp(`\\b${tableName}\\b`, 'gi');
    sanitized = sanitized.replace(regex, '[resource]');
  }

  sanitized = sanitized.replace(SANITIZATION_PATTERNS.filePaths, '[internal]');
  sanitized = sanitized.replace(SANITIZATION_PATTERNS.sqlFragments, '[query]');
  sanitized = sanitized.replace(SANITIZATION_PATTERNS.stackTrace, '');
  sanitized = sanitized.replace(SANITIZATION_PATTERNS.constraintColumns, '[detail]');
  sanitized = sanitized.replace(SANITIZATION_PATTERNS.internalServices, '[service]');
  sanitized = sanitized.replace(/\s{2,}/g, ' ').trim();

  return sanitized;
}

/**
 * Returns a generic message based on the HTTP status code for production responses.
 */
function getGenericMessage(statusCode: number): string {
  switch (statusCode) {
    case 400: return 'Bad request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Resource not found';
    case 409: return 'Conflict';
    case 413: return 'Payload too large';
    case 429: return 'Too many requests';
    case 503: return 'Service temporarily unavailable';
    default: return 'An unexpected error occurred';
  }
}

/**
 * Determines the appropriate production error message.
 */
function getProductionMessage(statusCode: number, errorCode: string, originalMessage: string): string {
  if (statusCode === 403) return 'Forbidden';
  if (statusCode === 404) return 'Resource not found';
  if (statusCode === 409) return 'Conflict';
  if (statusCode >= 500) return 'An unexpected error occurred. Please contact support.';

  return sanitizeErrorMessage(originalMessage);
}

/**
 * Global error handler middleware for Express.
 *
 * In production mode: sanitizes error messages, omits stack traces.
 * In development mode: includes full error details for debugging.
 */
export const globalErrorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  const traceId = (req as any).correlationId || uuidv4();

  let statusCode = err.statusCode || 500;
  let errorCode = err.errorCode || ErrorCodes.INTERNAL_ERROR;
  let message = err.message || 'Internal Server Error';
  const details = err.details || undefined;

  // Handle database constraint violations
  if (err.code === '23505' || err.constraint || (err.message && /unique.*constraint|duplicate.*key/i.test(err.message))) {
    statusCode = 409;
    errorCode = ErrorCodes.CONFLICT;
    if (!isProduction()) {
      message = err.message || 'Database constraint violation';
    }
  }

  // Log the error server-side
  if (statusCode >= 500) {
    console.error(`[${traceId}] ${message}`, {
      method: req.method,
      url: req.originalUrl,
      stack: err.stack,
    });
  }

  // Build the response based on environment
  if (isProduction()) {
    const productionMessage = getProductionMessage(statusCode, errorCode, message);
    res.status(statusCode).json({
      success: false,
      data: null,
      error: {
        code: errorCode,
        message: productionMessage,
        traceId,
      },
      meta: {
        requestId: traceId,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    });
  } else {
    res.status(statusCode).json({
      success: false,
      data: null,
      error: {
        code: errorCode,
        message,
        details,
        traceId,
        ...(statusCode >= 500 && err.stack ? { stack: err.stack } : {}),
      },
      meta: {
        requestId: traceId,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    });
  }
};

// notFoundHandler is exported from ./notFoundHandler.ts for API 404 handling

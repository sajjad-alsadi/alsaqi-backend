import { Request, Response, NextFunction } from 'express';
import { RequestLoggerOptions } from '../types/middleware';
import db from '../db/index';
import logger from '../utils/logger';

/**
 * Determines if a request path should be excluded from logging.
 * Supports exact matches and wildcard patterns (e.g., '/uploads/*').
 */
function isExcludedPath(requestPath: string, excludePaths: string[]): boolean {
  for (const pattern of excludePaths) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (requestPath === prefix || requestPath.startsWith(prefix + '/')) {
        return true;
      }
    } else if (requestPath === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Persists a request log entry to the request_logs table.
 * On failure, writes to stderr and continues without affecting the response.
 */
async function persistLogEntry(entry: {
  requestId: string;
  userId: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ipAddress: string;
  userAgent: string;
  errorMessage: string | null;
}): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO request_logs (request_id, user_id, method, path, status_code, duration_ms, ip_address, user_agent, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.requestId,
      entry.userId,
      entry.method,
      entry.path,
      entry.statusCode,
      entry.durationMs,
      entry.ipAddress,
      entry.userAgent,
      entry.errorMessage
    );
  } catch (err) {
    // On DB persist failure: write to stderr and continue without affecting response
    process.stderr.write(
      `[RequestLogger] Failed to persist log entry: ${err instanceof Error ? err.message : String(err)}\n` +
      `  Entry: ${JSON.stringify(entry)}\n`
    );
  }
}

/**
 * Creates a request logger middleware that records method, path, status code,
 * duration, user ID, IP, and user agent for every non-excluded request.
 *
 * Features:
 * - Emits warning-level log for requests exceeding slow threshold (default: 3000ms)
 * - Excludes configurable paths from logging (default: /api/health, /uploads/*)
 * - Persists log entries to the request_logs database table
 * - On DB persist failure: writes to stderr and continues without affecting response
 * - Includes correlation request ID in every log entry
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
export function createRequestLogger(options: RequestLoggerOptions = {}) {
  const {
    excludePaths = ['/api/health', '/uploads/*'],
    slowThreshold = 3000,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Check if path should be excluded from logging
    if (isExcludedPath(req.path, excludePaths)) {
      return next();
    }

    const startTime = Date.now();

    // Capture the response finish event to log after response is sent
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const correlationId = (req as any).correlationId || 'unknown';
      const userId = (req as any).user?.id || null;
      const method = req.method;
      const path = req.originalUrl || req.path;
      const statusCode = res.statusCode;
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const userAgent = req.get('user-agent') || '';

      // Determine if there's an error message (for 5xx responses)
      const errorMessage = statusCode >= 500 ? (res as any)._errorMessage || null : null;

      // Emit info-level log for every request
      logger.info('Request completed', {
        requestId: correlationId,
        method,
        path,
        statusCode,
        duration,
        userId,
        ip,
        userAgent,
      });

      // Emit warning-level log for slow requests
      if (duration > slowThreshold) {
        logger.warn(`Slow request detected: ${method} ${path} took ${duration}ms (threshold: ${slowThreshold}ms)`, {
          requestId: correlationId,
          method,
          path,
          duration,
          slowThreshold,
        });
      }

      // Persist to database asynchronously (fire-and-forget)
      persistLogEntry({
        requestId: correlationId,
        userId,
        method,
        path,
        statusCode,
        durationMs: duration,
        ipAddress: ip,
        userAgent,
        errorMessage,
      });
    });

    next();
  };
}

/**
 * Default request logger middleware instance with standard options.
 * Excludes /api/health and /uploads/* paths from logging.
 * Slow threshold: 3000ms.
 */
export const requestLoggerMiddleware = createRequestLogger();

/**
 * CSRF validation middleware for the @alsaqi/api package.
 *
 * Validates x-csrf-token header against csrf-token cookie on all
 * state-changing requests (POST, PUT, PATCH, DELETE).
 * Exempt endpoints: login, token refresh, register.
 *
 * Requirements: 8.2, 8.3
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ErrorCodes } from '@alsaqi/shared';

export interface CsrfOptions {
  /** Paths exempt from CSRF validation (e.g., ['/api/auth/login', '/api/v1/auth/login']) */
  exemptPaths: string[];
  /** Header name to read CSRF token from (default: 'x-csrf-token') */
  tokenHeader: string;
  /** Cookie name containing the expected CSRF token (default: 'csrf-token') */
  cookieName: string;
  /** Byte length for token generation (default: 32 = 64 hex chars) */
  tokenByteLength: number;
}

/**
 * Generates a cryptographically random CSRF token.
 * Uses crypto.randomBytes with the specified byte length (default 32 bytes = 64 hex chars).
 */
export function generateCsrfToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Attaches a CSRF token to the response via both a non-httpOnly cookie
 * and a response header, allowing the client to read and send it back.
 */
export function attachCsrfToken(res: Response, token: string): void {
  const isProduction = process.env.NODE_ENV === 'production';
  // Set as a non-httpOnly cookie so client-side JS can read and send it back.
  // secure: true in production so the cookie is only sent over HTTPS.
  res.cookie('csrf-token', token, {
    httpOnly: false,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });

  // Also set as a response header for convenience
  res.setHeader('x-csrf-token', token);
}

/**
 * Express middleware that validates CSRF tokens on state-changing requests.
 *
 * - Skips GET, HEAD, OPTIONS requests (read-only methods)
 * - Skips exempt paths (login, refresh, register)
 * - Reads token from the x-csrf-token request header
 * - Compares against the csrf-token cookie value using timing-safe comparison
 * - Returns 403 with CSRF_VALIDATION_FAILED error code if the token is missing or invalid
 */
export function csrfMiddleware(options: CsrfOptions): RequestHandler {
  const { exemptPaths, tokenHeader, cookieName } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip non-state-changing methods
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }

    // Skip exempt paths (login, refresh token, register)
    // Use req.originalUrl for matching because when middleware is mounted
    // on a path prefix (e.g. app.use('/api', ...)), req.path is relative
    // to the mount point (e.g. '/auth/login' instead of '/api/auth/login').
    const requestPath = req.originalUrl.split('?')[0]; // strip query params
    if (exemptPaths.some(path => requestPath === path)) {
      next();
      return;
    }

    // Read token from request header
    const headerToken = req.headers[tokenHeader.toLowerCase()] as string | undefined;

    // Read expected token from cookie
    const cookieToken = req.cookies?.[cookieName] as string | undefined;

    // Both must be present
    if (!headerToken || !cookieToken) {
      res.status(403).json({
        success: false,
        data: null,
        error: {
          code: ErrorCodes.CSRF_VALIDATION_FAILED,
          message: 'CSRF token missing',
          traceId: (req as any).correlationId || 'unknown',
        },
      });
      return;
    }

    // Compare using timing-safe comparison to prevent timing attacks
    if (!timingSafeCompare(headerToken, cookieToken)) {
      res.status(403).json({
        success: false,
        data: null,
        error: {
          code: ErrorCodes.CSRF_VALIDATION_FAILED,
          message: 'CSRF token invalid',
          traceId: (req as any).correlationId || 'unknown',
        },
      });
      return;
    }

    next();
  };
}

/**
 * Performs a timing-safe string comparison using crypto.timingSafeEqual.
 * Returns false if strings have different lengths (without leaking length info
 * beyond the boolean result).
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');

  return crypto.timingSafeEqual(bufA, bufB);
}

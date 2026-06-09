/**
 * API Version Rewriting Middleware
 *
 * Handles path rewriting for backward compatibility:
 * - Requests to /api/{resource} (without version prefix) are internally
 *   rewritten to /api/v1/{resource}
 * - Requests to /api/v1/{resource} pass through unchanged
 * - Requests to unsupported versions (/api/v2/, etc.) return 404
 *
 * Also sets the X-API-Version response header on all /api/ responses.
 */

import type { Request, Response, NextFunction } from 'express';
import { API_VERSION } from '@alsaqi/shared';

/**
 * Current supported API version (major component only for routing).
 */
export const CURRENT_API_VERSION = { major: 1, minor: 0 };
export const SUPPORTED_VERSIONS = [1];

/**
 * Middleware that adds the X-API-Version header to all /api/ responses.
 */
export function apiVersionHeader(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-API-Version', `${CURRENT_API_VERSION.major}.${CURRENT_API_VERSION.minor}`);
  next();
}

/**
 * Middleware that intercepts requests to unsupported API versions.
 * Returns 404 for /api/v{n}/ where n is not in SUPPORTED_VERSIONS.
 */
export function unsupportedVersionHandler(req: Request, res: Response, next: NextFunction): void {
  const versionMatch = req.path.match(/^\/v(\d+)/);
  if (!versionMatch) {
    return next();
  }

  const versionNum = parseInt(versionMatch[1], 10);

  if (isNaN(versionNum) || versionNum < 1) {
    res.status(404).json({
      success: false,
      error: {
        code: 'VERSION_NOT_FOUND',
        message: `API version 'v${versionMatch[1]}' is not available. Supported versions: ${SUPPORTED_VERSIONS.map((v) => `v${v}`).join(', ')}`,
      },
    });
    return;
  }

  if (!SUPPORTED_VERSIONS.includes(versionNum)) {
    res.status(404).json({
      success: false,
      error: {
        code: 'VERSION_NOT_FOUND',
        message: `API version 'v${versionNum}' is not available. Supported versions: ${SUPPORTED_VERSIONS.map((v) => `v${v}`).join(', ')}`,
      },
    });
    return;
  }

  // Supported version — continue to actual route handlers
  next();
}

/**
 * Middleware that rewrites unversioned /api/{resource} paths to /api/v1/{resource}.
 *
 * If the request path already starts with /v{n}/, it passes through unchanged.
 * Otherwise, prepends /v{CURRENT_API_VERSION.major} to the URL.
 *
 * This ensures backward compatibility: clients using /api/resource still work.
 */
export function versionFallbackRewrite(req: Request, res: Response, next: NextFunction): void {
  // If the path already starts with /v{n}/, let it pass through
  if (/^\/v\d+/.test(req.path)) {
    return next();
  }

  // Rewrite the URL to include the version prefix
  req.url = `/v${CURRENT_API_VERSION.major}${req.url === '/' ? '' : req.url}`;
  next();
}

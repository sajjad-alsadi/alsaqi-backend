/**
 * X-API-Version response header middleware for the @alsaqi/api package.
 *
 * Adds the X-API-Version header to all /api/ responses, using the
 * API_VERSION constant from @alsaqi/shared.
 *
 * Requirements: 6.7
 */

import type { Request, Response, NextFunction } from 'express';
import { API_VERSION } from '@alsaqi/shared';

/**
 * Middleware that attaches the X-API-Version header to all responses
 * on /api/ paths. This allows clients to detect version mismatches
 * and prompt the user to refresh the page.
 */
export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to /api/ paths
  if (req.path.startsWith('/api/') || req.path === '/api') {
    res.setHeader('X-API-Version', API_VERSION);
  }
  next();
}

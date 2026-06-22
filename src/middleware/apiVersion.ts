/**
 * X-API-Version response header middleware for the @alsaqi/api package.
 *
 * Adds the X-API-Version header to all /api/ responses, sourced from the
 * single VERSION_SOURCE constant (src/utils/apiVersionSource.ts) so the value
 * never conflicts with another writer.
 *
 * NOTE: The production server (src/index.ts) sets X-API-Version from
 * VERSION_SOURCE in an early middleware and no longer registers this
 * middleware. It is retained only as a self-contained helper for isolated
 * test harnesses that build a minimal app.
 *
 * Requirements: 3.1, 3.2, 3.6
 */

import type { Request, Response, NextFunction } from 'express';
import { VERSION_SOURCE } from '../utils/apiVersionSource.js';

/**
 * Middleware that attaches the X-API-Version header to all responses
 * on /api/ paths. This allows clients to detect version mismatches
 * and prompt the user to refresh the page.
 */
export function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to /api/ paths
  if (req.path.startsWith('/api/') || req.path === '/api') {
    res.setHeader('X-API-Version', VERSION_SOURCE);
  }
  next();
}

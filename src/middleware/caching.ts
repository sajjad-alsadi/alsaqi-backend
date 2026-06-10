/**
 * HTTP Caching middleware for the @alsaqi/api package.
 *
 * Provides ETag generation and Cache-Control headers for API responses.
 * Supports conditional requests via If-None-Match → 304 Not Modified.
 *
 * Requirement 14.1: Return ETag header with content hash and Cache-Control
 * with max-age between 60s-3600s based on resource type. Return 304 Not Modified
 * when If-None-Match matches.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';

/**
 * Resource type classification for Cache-Control max-age.
 * - static: rarely changing resources (e.g., lookup tables, enums) → 3600s
 * - listing: list/collection endpoints → 120s
 * - detail: individual resource detail endpoints → 60s
 */
export type CacheResourceType = 'static' | 'listing' | 'detail';

/**
 * Configuration for the caching middleware.
 */
export interface CachingOptions {
  /**
   * Resource type determines Cache-Control max-age:
   * - 'static': 3600s (1 hour) for rarely-changing data
   * - 'listing': 120s (2 minutes) for collection endpoints
   * - 'detail': 60s (1 minute) for individual resource endpoints
   * Default: 'detail'
   */
  resourceType?: CacheResourceType;
  /**
   * Paths to exclude from caching (e.g., auth endpoints, mutations).
   * Matched via startsWith.
   */
  excludePaths?: string[];
}

/**
 * Maps resource type to max-age value in seconds.
 * All values are within the required 60s-3600s range.
 */
const MAX_AGE_MAP: Record<CacheResourceType, number> = {
  static: 3600,
  listing: 120,
  detail: 60,
};

/**
 * Generates an ETag from response body content using MD5 hash.
 * The ETag is a weak validator (prefixed with W/) since the response
 * may be transformed by other middleware (compression, wrapping).
 */
export function generateETag(body: string): string {
  const hash = createHash('md5').update(body).digest('hex');
  return `W/"${hash}"`;
}

/**
 * Creates an HTTP caching middleware that:
 * 1. Generates ETag from response body content hash
 * 2. Sets Cache-Control with max-age based on resource type
 * 3. Returns 304 Not Modified when If-None-Match matches current ETag
 *
 * Only applies to GET requests with successful (2xx) responses.
 */
export function createCachingMiddleware(options: CachingOptions = {}) {
  const { resourceType = 'detail', excludePaths = [] } = options;
  const maxAge = MAX_AGE_MAP[resourceType];

  return (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip excluded paths
    if (excludePaths.some((p) => req.path.startsWith(p))) {
      return next();
    }

    // Intercept res.json to add caching headers
    const originalJson = res.json.bind(res);

    res.json = ((body: any): Response => {
      // Only add caching headers for successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const bodyString = JSON.stringify(body);
        const etag = generateETag(bodyString);

        // Check If-None-Match header for conditional request
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etag) {
          res.status(304);
          return res.end() as unknown as Response;
        }

        // Set caching headers
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      }

      return originalJson(body);
    }) as any;

    next();
  };
}

/**
 * Default caching middleware instance for detail resources (60s max-age).
 */
export const cachingMiddleware = createCachingMiddleware();

/**
 * Caching middleware for static/lookup resources (3600s max-age).
 */
export const staticCachingMiddleware = createCachingMiddleware({ resourceType: 'static' });

/**
 * Caching middleware for listing/collection resources (120s max-age).
 */
export const listingCachingMiddleware = createCachingMiddleware({ resourceType: 'listing' });

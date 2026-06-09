/**
 * Per-user rate limiting middleware using an in-memory sliding window approach.
 *
 * - Authenticated users: keyed by user ID (default 100 req / 60s)
 * - Unauthenticated users: keyed by IP address (default 50 req / 60s)
 * - Per-user isolation: one user's limit does not affect others on the same IP
 * - Returns 429 with Retry-After header when limit is exceeded
 * - Includes X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers
 *
 * Requirements: 8.5, 8.6
 */

import type { Request, Response, NextFunction } from 'express';
import { ErrorCodes } from '@alsaqi/shared';
import type { RateLimiterOptions } from './types.js';

interface SlidingWindowEntry {
  timestamps: number[];
}

/**
 * In-memory store for sliding window rate limiting.
 * Keys are either `user:<userId>` or `ip:<ipAddress>`.
 */
const store = new Map<string, SlidingWindowEntry>();

/**
 * Periodic cleanup interval to prevent unbounded memory growth.
 * Removes entries with no timestamps within the current window.
 */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

const DEFAULT_AUTHENTICATED_LIMIT = 100;
const DEFAULT_UNAUTHENTICATED_LIMIT = 50;
const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Starts the periodic cleanup of expired entries.
 * Called automatically when the middleware is first created.
 */
function startCleanup(windowMs: number): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      // Remove timestamps older than the window
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, windowMs);
  // Allow the process to exit even if the interval is still running
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Determines the rate limit key for a request.
 * Uses `user:<id>` for authenticated users, `ip:<address>` for unauthenticated.
 */
function getKey(req: Request): { key: string; isAuthenticated: boolean } {
  const user = (req as any).user;
  if (user && user.id) {
    return { key: `user:${user.id}`, isAuthenticated: true };
  }
  const ip = req.ip || req.socket?.remoteAddress || '0.0.0.0';
  return { key: `ip:${ip}`, isAuthenticated: false };
}

/**
 * Creates the per-user rate limiting middleware.
 *
 * Uses a sliding window algorithm:
 * - 100 requests per 60-second window for authenticated users
 * - 50 requests per 60-second window for unauthenticated users
 *
 * Response headers on every request:
 * - X-RateLimit-Limit: the maximum requests allowed in the window
 * - X-RateLimit-Remaining: remaining requests in the current window
 * - X-RateLimit-Reset: Unix epoch timestamp when the window resets
 *
 * On rate limit exceeded (429):
 * - Retry-After: seconds until the next available request slot
 *
 * @param options - Configuration options for rate limits and window duration
 * @returns Express middleware function
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const authenticatedLimit = options.authenticatedLimit ?? DEFAULT_AUTHENTICATED_LIMIT;
  const unauthenticatedLimit = options.unauthenticatedLimit ?? DEFAULT_UNAUTHENTICATED_LIMIT;
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;

  // Start background cleanup
  startCleanup(windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const { key, isAuthenticated } = getKey(req);
    const limit = isAuthenticated ? authenticatedLimit : unauthenticatedLimit;

    // Get or create the entry for this key
    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside the sliding window
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);

    // Calculate reset time: the earliest time a slot will free up
    const oldestInWindow = entry.timestamps.length > 0 ? entry.timestamps[0] : now;
    const resetTimeMs = oldestInWindow + windowMs;
    const resetEpochSeconds = Math.ceil(resetTimeMs / 1000);

    // Set rate limit headers on every response
    const remaining = Math.max(0, limit - entry.timestamps.length);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetEpochSeconds));

    // Check if limit is exceeded
    if (entry.timestamps.length >= limit) {
      const retryAfterSeconds = Math.ceil((resetTimeMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
      res.status(429).json({
        success: false,
        data: null,
        error: {
          code: ErrorCodes.RATE_LIMIT_EXCEEDED,
          message: 'Too many requests. Please try again later.',
          traceId: (req as any).correlationId || 'unknown',
        },
      });
      return;
    }

    // Record this request
    entry.timestamps.push(now);

    // Update remaining after recording
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - entry.timestamps.length)));

    next();
  };
}

/**
 * Resets the rate limiter store. Useful for testing.
 */
export function resetRateLimiterStore(): void {
  store.clear();
}

/**
 * Stops the cleanup interval. Useful for testing teardown.
 */
export function stopRateLimiterCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Gets the current count of requests in the window for a given key.
 * Useful for testing and monitoring.
 */
export function getRateLimitCount(key: string): number {
  const entry = store.get(key);
  if (!entry) return 0;
  return entry.timestamps.length;
}

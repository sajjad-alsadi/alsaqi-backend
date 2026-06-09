/**
 * Rate limiting middleware specific to permission admin endpoints.
 *
 * Enforces a sliding window rate limit of 100 requests per 15-minute window
 * per authenticated user on all permission management endpoints.
 *
 * - Keyed by authenticated user ID (req.user.id)
 * - Returns HTTP 429 with structured error and Retry-After header when exceeded
 * - Uses in-memory sliding window algorithm
 *
 * Requirements: 13.4, 13.5
 */

import type { Request, Response, NextFunction } from 'express';

interface SlidingWindowEntry {
  timestamps: number[];
}

/** In-memory store for per-user sliding window tracking */
const store = new Map<string, SlidingWindowEntry>();

/** Periodic cleanup interval reference */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Rate limit: 100 requests per 15-minute sliding window */
const RATE_LIMIT = 100;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

/**
 * Starts periodic cleanup of expired entries to prevent unbounded memory growth.
 */
function startCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, WINDOW_MS);
  // Allow the process to exit even if the interval is still running
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Permission admin rate limiter middleware.
 *
 * Applies a sliding window rate limit of 100 requests per 15-minute window
 * per authenticated user. Must be applied after the authenticate middleware
 * so that req.user.id is available.
 *
 * When the rate limit is exceeded, returns:
 * - HTTP 429 status
 * - JSON body: { error: "Rate limit exceeded", code: "RATE_LIMIT_EXCEEDED" }
 * - Retry-After header with seconds until the window resets
 */
export function permissionAdminRateLimiter(req: Request, res: Response, next: NextFunction): void {
  // Ensure cleanup is running
  startCleanup();

  const user = (req as any).user;
  if (!user || !user.id) {
    // If no authenticated user, let downstream middleware handle auth errors
    next();
    return;
  }

  const now = Date.now();
  const key = `perm_admin:${user.id}`;

  // Get or create the entry for this user
  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Remove timestamps outside the 15-minute sliding window
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);

  // Check if limit is exceeded
  if (entry.timestamps.length >= RATE_LIMIT) {
    // Calculate Retry-After: time until the oldest request in the window expires
    const oldestTimestamp = entry.timestamps[0];
    const resetTimeMs = oldestTimestamp + WINDOW_MS;
    const retryAfterSeconds = Math.ceil((resetTimeMs - now) / 1000);

    res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
    res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
    });
    return;
  }

  // Record this request timestamp
  entry.timestamps.push(now);

  next();
}

/**
 * Resets the permission admin rate limiter store. Useful for testing.
 */
export function resetPermissionAdminRateLimiterStore(): void {
  store.clear();
}

/**
 * Stops the cleanup interval. Useful for testing teardown.
 */
export function stopPermissionAdminRateLimiterCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Gets the current request count for a user in the sliding window.
 * Useful for testing and monitoring.
 */
export function getPermissionAdminRateLimitCount(userId: string): number {
  const entry = store.get(`perm_admin:${userId}`);
  if (!entry) return 0;
  const now = Date.now();
  return entry.timestamps.filter((ts) => now - ts < WINDOW_MS).length;
}

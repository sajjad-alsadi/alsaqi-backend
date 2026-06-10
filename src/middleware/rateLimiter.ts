/**
 * Redis-backed sliding window rate limiting middleware.
 *
 * - Authenticated users: keyed by user ID (default 100 req / 60s)
 * - Unauthenticated users: keyed by IP address (default 50 req / 60s)
 * - Shared Redis store for multi-instance consistency
 * - Per-endpoint custom limits (e.g., PDF generation: 10 req/60s)
 * - Real client IP extraction from X-Forwarded-For (trust proxy enabled)
 * - Returns 429 with Retry-After header when limit exceeded
 * - Graceful degradation: allows request through when Redis unavailable
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { Request, Response, NextFunction } from 'express';
import { ErrorCodes } from '@alsaqi/shared';
import redisManager from '../cache/redisManager.js';
import logger from '../utils/logger.js';
import type { RateLimiterOptions } from './types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_AUTHENTICATED_LIMIT = 100;
const DEFAULT_UNAUTHENTICATED_LIMIT = 50;
const DEFAULT_WINDOW_SECONDS = 60;
const REDIS_TIMEOUT_MS = 3000;

// ─── Per-endpoint custom rate limits ─────────────────────────────────────────

/**
 * Configuration for per-endpoint custom rate limits.
 * Requirement 8.3: Support per-endpoint custom limits.
 */
export interface EndpointRateLimitConfig {
  /** Route pattern to match (e.g., '/api/v1/pdf-templates/preview-pdf') */
  pattern: string;
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

/**
 * Default per-endpoint custom rate limit configurations.
 * PDF generation endpoints: 10 req/60s per client.
 */
const DEFAULT_ENDPOINT_LIMITS: EndpointRateLimitConfig[] = [
  { pattern: '/api/v1/pdf-templates/preview-pdf', maxRequests: 10, windowSeconds: 60 },
  { pattern: '/api/v1/pdf-templates/preview-html', maxRequests: 10, windowSeconds: 60 },
  { pattern: '/api/v1/reports/generate', maxRequests: 10, windowSeconds: 60 },
];

// ─── In-memory fallback store ────────────────────────────────────────────────

interface SlidingWindowEntry {
  timestamps: number[];
}

/**
 * In-memory fallback store used only when Redis is unavailable.
 * This provides per-instance rate limiting as a degraded fallback.
 */
const fallbackStore = new Map<string, SlidingWindowEntry>();

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startFallbackCleanup(windowMs: number): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of fallbackStore) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
      if (entry.timestamps.length === 0) {
        fallbackStore.delete(key);
      }
    }
  }, windowMs);
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

// ─── Lua script for atomic sliding window check ──────────────────────────────

/**
 * Lua script that atomically:
 * 1. Removes expired timestamps from sorted set
 * 2. Counts remaining requests in window
 * 3. If under limit, adds current timestamp
 * 4. Returns [count, oldestTimestamp]
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Remove expired entries
local cutoff = now - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Get current count
local count = redis.call('ZCARD', key)

-- Get oldest entry timestamp (for Retry-After calculation)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest_ts = 0
if #oldest > 0 then
  oldest_ts = tonumber(oldest[2])
end

-- If under limit, add current request
if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('PEXPIRE', key, window_ms)
  count = count + 1
end

return {count, oldest_ts}
`;

// ─── Helper functions ────────────────────────────────────────────────────────

/**
 * Extracts real client IP from X-Forwarded-For after trust proxy is enabled.
 * Requirement 8.1: Extract first trusted IP from X-Forwarded-For.
 *
 * Express with trust proxy handles this via req.ip, but we also parse
 * X-Forwarded-For manually for robustness.
 */
function getClientIp(req: Request): string {
  // When trust proxy is enabled, req.ip reflects the client's actual IP
  // from X-Forwarded-For parsing by Express
  if (req.ip) {
    return req.ip;
  }

  // Fallback: manually parse X-Forwarded-For
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const forwardedIps = Array.isArray(xForwardedFor)
      ? xForwardedFor[0]
      : xForwardedFor;
    // First IP in the chain is the client's real IP
    const clientIp = forwardedIps.split(',')[0]?.trim();
    if (clientIp) {
      return clientIp;
    }
  }

  return req.socket?.remoteAddress || '0.0.0.0';
}

/**
 * Determines the rate limit key for a request.
 * Uses `user:<id>` for authenticated users, `ip:<address>` for unauthenticated.
 */
function getRateLimitKey(req: Request): { key: string; isAuthenticated: boolean } {
  const user = (req as any).user;
  if (user && user.id) {
    return { key: `ratelimit:user:${user.id}`, isAuthenticated: true };
  }
  const ip = getClientIp(req);
  return { key: `ratelimit:ip:${ip}`, isAuthenticated: false };
}

/**
 * Finds a per-endpoint custom limit configuration for the given request path.
 * Requirement 8.3: Support per-endpoint custom limits.
 */
function findEndpointLimit(
  path: string,
  endpointLimits: EndpointRateLimitConfig[]
): EndpointRateLimitConfig | undefined {
  return endpointLimits.find((config) => path.startsWith(config.pattern));
}

/**
 * Wraps a Redis operation with a timeout to prevent blocking.
 * Requirement 8.5: If Redis times out within 3 seconds, allow request through.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ─── Redis-backed rate limit check ───────────────────────────────────────────

/**
 * Performs the sliding window rate limit check using Redis.
 * Returns null if Redis is unavailable (graceful degradation).
 */
async function checkRateLimitRedis(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ count: number; oldestTs: number; allowed: boolean } | null> {
  const client = redisManager.getClient();
  if (!client) {
    return null;
  }

  try {
    const now = Date.now();
    const result = await withTimeout(
      client.eval(SLIDING_WINDOW_LUA, 1, key, now, windowMs, limit) as Promise<[number, number]>,
      REDIS_TIMEOUT_MS
    );

    const [count, oldestTs] = result as [number, number];
    return {
      count,
      oldestTs,
      allowed: count <= limit,
    };
  } catch (err) {
    // Requirement 8.5: Redis unavailable or timeout → allow through
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`[RateLimiter] Redis operation failed: ${errorMessage}. Allowing request through.`);
    return null;
  }
}

// ─── Fallback in-memory rate limit check ─────────────────────────────────────

/**
 * Performs rate limiting using in-memory store when Redis is unavailable.
 * This provides per-instance limiting as a best-effort fallback.
 */
function checkRateLimitInMemory(
  key: string,
  limit: number,
  windowMs: number
): { count: number; oldestTs: number; allowed: boolean } {
  const now = Date.now();

  let entry = fallbackStore.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    fallbackStore.set(key, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);

  const count = entry.timestamps.length;
  const oldestTs = entry.timestamps.length > 0 ? entry.timestamps[0] : now;

  if (count >= limit) {
    return { count, oldestTs, allowed: false };
  }

  // Record request
  entry.timestamps.push(now);
  return { count: count + 1, oldestTs, allowed: true };
}

// ─── Main middleware factory ─────────────────────────────────────────────────

/**
 * Creates the Redis-backed per-user rate limiting middleware.
 *
 * Uses a sliding window algorithm backed by Redis sorted sets:
 * - 100 requests per 60-second window for authenticated users
 * - 50 requests per 60-second window for unauthenticated users
 * - Per-endpoint custom limits (e.g., PDF generation: 10 req/60s)
 *
 * When Redis is unavailable, falls back to in-memory per-instance limiting
 * and logs a warning (Requirement 8.5).
 *
 * Response headers on every request:
 * - X-RateLimit-Limit: the maximum requests allowed in the window
 * - X-RateLimit-Remaining: remaining requests in the current window
 * - X-RateLimit-Reset: Unix epoch timestamp when the window resets
 *
 * On rate limit exceeded (429):
 * - Retry-After: seconds until the oldest request in the window expires
 *
 * @param options - Configuration options for rate limits and window duration
 * @returns Express middleware function
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const authenticatedLimit = options.authenticatedLimit ?? DEFAULT_AUTHENTICATED_LIMIT;
  const unauthenticatedLimit = options.unauthenticatedLimit ?? DEFAULT_UNAUTHENTICATED_LIMIT;
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const windowMs = windowSeconds * 1000;
  const endpointLimits = options.endpointLimits ?? DEFAULT_ENDPOINT_LIMITS;

  // Start fallback cleanup for in-memory store
  startFallbackCleanup(windowMs);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { key, isAuthenticated } = getRateLimitKey(req);

    // Check for per-endpoint custom limit (Requirement 8.3)
    const endpointConfig = findEndpointLimit(req.originalUrl || req.path, endpointLimits);

    let limit: number;
    let effectiveWindowMs: number;

    if (endpointConfig) {
      limit = endpointConfig.maxRequests;
      effectiveWindowMs = endpointConfig.windowSeconds * 1000;
    } else {
      limit = isAuthenticated ? authenticatedLimit : unauthenticatedLimit;
      effectiveWindowMs = windowMs;
    }

    // Append endpoint suffix to key for per-endpoint limits
    const effectiveKey = endpointConfig
      ? `${key}:${endpointConfig.pattern}`
      : key;

    // Try Redis first, fall back to in-memory
    let result = await checkRateLimitRedis(effectiveKey, limit, effectiveWindowMs);

    if (result === null) {
      // Redis unavailable - use in-memory fallback (Requirement 8.5)
      result = checkRateLimitInMemory(effectiveKey, limit, effectiveWindowMs);
    }

    const now = Date.now();
    const resetTimeMs = result.oldestTs + effectiveWindowMs;
    const resetEpochSeconds = Math.ceil(resetTimeMs / 1000);
    const remaining = Math.max(0, limit - result.count);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetEpochSeconds));

    // Check if limit is exceeded (Requirement 8.4)
    if (!result.allowed) {
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

    next();
  };
}

// ─── Exported utilities for testing and monitoring ────────────────────────────

/**
 * Resets the in-memory fallback rate limiter store. Useful for testing.
 */
export function resetRateLimiterStore(): void {
  fallbackStore.clear();
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
 * Gets the current count of requests in the in-memory fallback store for a given key.
 * Useful for testing and monitoring.
 */
export function getRateLimitCount(key: string): number {
  const entry = fallbackStore.get(key);
  if (!entry) return 0;
  const now = Date.now();
  // Only count non-expired timestamps (60s default window)
  return entry.timestamps.filter((ts) => now - ts < DEFAULT_WINDOW_SECONDS * 1000).length;
}

/**
 * Extracts client IP from a request. Exported for testing Property 12.
 */
export function extractClientIp(req: Request): string {
  return getClientIp(req);
}

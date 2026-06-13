import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import type { IDBWrapper } from '../db/index.js';
import { UserRole } from '@alsaqi/shared';
import { PermissionService } from '../services/PermissionService';
import { ModuleRegistry } from '../permissions/registry';
import { PermissionAction } from '../permissions/types';
import { AuthenticatedRequest } from '../types';
import { canonicalizePath, isPathAllowed } from './pathGate.js';
import { redisManager } from '../cache/redisManager.js';
import { AuthCacheInvalidator } from '../services/AuthCacheInvalidator';
import logger from '../utils/logger.js';
import { getAuthRateLimitMax, getAuthRateLimitWindowS } from '../config/environmentConfig.js';

/**
 * Routes a user must still reach while `requires_password_change` is true so they
 * can resolve the required change (Req 3.6).
 *
 * NOTE: These are canonical `req.path` values, which are router-relative because
 * `authenticate` runs as route-level middleware nested under `/api/v1/auth`. For
 * example the change-password route surfaces as `/change-password` (not
 * `/auth/change-password`); matching the prefixed form here would lock the user
 * out of the very route that resolves the gate. The gate compares against
 * `req.path` only — never `req.originalUrl` or any query string (Req 3.2).
 */
const PASSWORD_CHANGE_ALLOWED_PATHS: readonly string[] = [
  '/change-password',
  '/update-password',
  '/logout',
  '/refresh',
  '/session',
];

/**
 * Path-safe password-change gate (Requirement 3).
 *
 * Gates strictly on the canonical `req.path` (Req 3.2, 3.3) using exact or
 * path-segment-boundary prefix matching (Req 3.1, 3.4) so that crafted query
 * strings (Req 3.5) and lookalike paths such as `/logout-evil` cannot bypass it.
 * A non-allowed route is denied with a `PASSWORD_CHANGE_REQUIRED` response.
 *
 * Typed with `AuthenticatedRequest`/`Response`/`NextFunction` to satisfy the
 * typed-handler requirement for the auth-middleware gate (Req 26.2).
 */
const passwordChangeGate = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user.requires_password_change) {
    next();
    return;
  }

  const canonicalPath = canonicalizePath(req.path);
  if (isPathAllowed(canonicalPath, PASSWORD_CHANGE_ALLOWED_PATHS)) {
    next();
    return;
  }

  res.status(403).json({
    error: 'Password change required',
    code: 'PASSWORD_CHANGE_REQUIRED',
  });
};

/**
 * Redis-backed auth cache for distributed multi-instance deployments.
 *
 * Cache key format: auth:<prefix>_<userId>_<session_version>
 * - Including session_version in the key ensures that any session_version change
 *   naturally invalidates cached entries across all instances (Requirement 2.5).
 * - TTL is set to 300 seconds (5 minutes) per entry (Requirement 2.2).
 * - Max 10,000 entries enforced via Redis memory policies (Requirement 2.2).
 * - Falls back to no-cache (direct DB) if Redis is unavailable (Requirement 2.4).
 *
 * Validates: Requirements 2.2, 2.5
 */

const AUTH_CACHE_PREFIX = 'auth:';
const AUTH_CACHE_TTL_SECONDS = 300; // ≤ 300 seconds (Requirement 2.2)

/**
 * Invalidate all cache entries for a specific user.
 * Call after role/permission/status changes.
 *
 * Delegates to the canonical {@link AuthCacheInvalidator.invalidate}, which
 * clears both the in-process permission cache and the distributed Redis auth
 * cache, retries on failure, and forces an authoritative re-read when all
 * attempts fail (Requirement 16). Retained as a named export for backward
 * compatibility with existing callers.
 */
export const invalidateUserCache = async (userId: string): Promise<void> => {
  await AuthCacheInvalidator.invalidate(userId);
};

/**
 * Clear all permission cache entries.
 * Call after role permission changes.
 */
export const clearPermissionCache = async (): Promise<void> => {
  if (!redisManager.isAvailable) {
    return;
  }

  try {
    const client = redisManager.getClient();
    if (!client) return;

    const pattern = `${AUTH_CACHE_PREFIX}perm_*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`[AuthCache] Failed to clear permission cache: ${errorMessage}`);
  }
};

export const createAuthMiddlewares = (db: IDBWrapper, JWT_SECRET: string, JWT_PUBLIC_KEY: string) => {
  /**
   * Get data from Redis cache or fall back to DB fetcher.
   * If Redis is unavailable, directly calls the fetcher (no-cache mode).
   * TTL is enforced at ≤ 300 seconds. Max 10,000 entries managed by Redis eviction.
   *
   * Validates: Requirements 2.2, 2.4
   */
  const getCachedOrDb = async <T>(key: string, fetcher: () => Promise<T>, forceFresh = false): Promise<T> => {
    const redisKey = `${AUTH_CACHE_PREFIX}${key}`;

    // Attempt to read from Redis cache. Skipped entirely when a forced
    // authoritative re-read has been requested for this user (Req 16.3, 16.4).
    if (!forceFresh && redisManager.isAvailable) {
      try {
        const cached = await redisManager.get(redisKey);
        if (cached !== null) {
          return JSON.parse(cached);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`[AuthCache] Failed to read cache key "${redisKey}": ${errorMessage}`);
        // Fall through to DB fetch
      }
    }

    // Fetch from database
    const data = await fetcher();

    // Store in Redis with TTL (no-op if Redis unavailable via graceful degradation)
    if (redisManager.isAvailable && data !== null && data !== undefined) {
      try {
        await redisManager.set(redisKey, JSON.stringify(data), AUTH_CACHE_TTL_SECONDS);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`[AuthCache] Failed to write cache key "${redisKey}": ${errorMessage}`);
      }
    }

    return data;
  };

  const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    let token = req.cookies.token;
    
    // Also check Authorization header
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
      const decodedToken = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] }) as any;

      // If a prior cache invalidation for this user failed, bypass the cache and
      // re-read the authoritative store on this request (Req 16.3, 16.4).
      const forceFresh = AuthCacheInvalidator.shouldForceRead(decodedToken.id);

      let user: any;
      try {
        user = await getCachedOrDb(`user_${decodedToken.id}_${decodedToken.session_version}`, async () => {
          return await db.prepare(`
            SELECT u.id, u.role, u.status, u.username, u.name, u.email, u.session_version, u.requires_password_change, o.id as department_id
            FROM users u
            LEFT JOIN org_entities o ON (u.department = o.name_ar OR u.department = o.name_en)
            WHERE u.id = ?
          `).get(decodedToken.id) as any;
        }, forceFresh);
      } catch (storeErr) {
        // Req 16.5: the authoritative store could not be reached while re-reading
        // the (possibly invalidated) auth state. Deny the request rather than
        // serving stale cached values.
        const message = storeErr instanceof Error ? storeErr.message : String(storeErr);
        logger.error(
          `[Auth] Authoritative store unreachable while verifying auth state for user ${decodedToken.id}: ${message}`,
        );
        return res.status(503).json({
          error: 'Authentication state could not be verified',
          code: 'AUTH_STATE_UNVERIFIABLE',
        });
      }

      // A successful authoritative read clears any forced-re-read flag (Req 16.4).
      if (forceFresh) {
        AuthCacheInvalidator.clearForceRead(decodedToken.id);
      }

      if (!user) {
        return res.status(401).json({ error: "User not found in database" });
      }

      if (user.status === 'Suspended' || user.status === 'Disabled' || user.status === 'Archived') {
        return res.status(403).json({ error: "Account suspended, disabled or archived" });
      }

      if (user.session_version !== decodedToken.session_version) {
        return res.status(401).json({ error: "Session invalidated" });
      }

      req.user = { 
        id: user.id, 
        role: user.role, 
        username: user.username, 
        name: user.name, 
        email: user.email,
        department_id: user.department_id || null,
        requires_password_change: !!user.requires_password_change 
      };

      // If password change is required, only allow access to a small set of
      // routes (canonical `req.path` match only) so the user can resolve it (Req 3).
      return passwordChangeGate(req as AuthenticatedRequest, res, next);
    } catch (err) {
      if (!(err instanceof jwt.TokenExpiredError) && !(err instanceof jwt.JsonWebTokenError)) {
        console.error("Auth error:", err);
      }
      res.status(401).json({ error: "Invalid token" });
    }
  };

  /**
   * Unified checkPermission middleware factory.
   * Replaces both the old checkPermission() and authorize() functions.
   *
   * Validates the module at startup (dev mode throws, production returns 500).
   * At runtime:
   * - Returns 401 if req.user is not populated
   * - Admin role bypasses without DB query
   * - Uses PermissionService.hasPermission() for the actual check
   * - Returns structured 403 on denial
   * - Returns 500 on PermissionService errors (no internal details exposed)
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 13.1, 13.6
   */
  const checkPermission = (module: string, action: PermissionAction) => {
    // Validate module registration at middleware creation time (startup)
    const moduleDef = ModuleRegistry.getModule(module);
    const isDev = process.env.NODE_ENV !== 'production';

    if (!moduleDef) {
      if (isDev) {
        throw new Error(
          `checkPermission: Module '${module}' is not registered in ModuleRegistry. ` +
          `Register it in src/permissions/modules.ts before using it in route middleware.`
        );
      }
      // In production, return a middleware that always responds with 500
      return (req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
        console.error(`checkPermission: Unregistered module '${module}' used in route middleware.`);
        return res.status(500).json({
          error: 'Internal authorization configuration error',
        });
      };
    }

    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      // Req 3.6, 3.8: Ensure authenticate() has populated req.user
      if (!req.user) {
        return res.status(401).json({
          error: 'Authentication required. Please authenticate before accessing this resource.',
        });
      }

      const user = req.user;

      // Req 3.2: Admin bypass - Admin always has full access without DB query
      if (user.role === UserRole.ADMIN) {
        return next();
      }

      try {
        // Req 3.1, 3.3: Query PermissionService for DB-based permission check
        const allowed = await PermissionService.hasPermission(user.id, module, action);

        if (allowed) {
          return next();
        }

        // Req 3.4, 13.1: Structured 403 response on denial
        return res.status(403).json({
          error: `Forbidden: Missing permission '${action}' on module '${module}'`,
          code: 'PERMISSION_DENIED',
          module,
          action,
        });
      } catch (err) {
        // Req 3.7: Handle PermissionService errors - return 500 without exposing internals
        console.error(`checkPermission error for user ${user.id}, module ${module}, action ${action}:`, err);
        return res.status(500).json({
          error: 'Internal authorization error. Please try again later.',
        });
      }
    };
  };

  /**
   * @deprecated Use checkPermission(module, action) instead.
   * This function is kept temporarily for backward compatibility during migration.
   * It will be removed once all routes are migrated to checkPermission().
   */
  const authorize = (allowedRoles: readonly string[]) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: "Forbidden: Insufficient permissions" });
      }
      next();
    };
  };

  // Source-IP rate limiting (Requirement 18).
  // Keyed on the source IP **only** so attempts are counted across usernames,
  // throttling password-spraying from a single source (Req 18.1). The limit and
  // window are configurable via AUTH_RATE_LIMIT_MAX (default 10) and
  // AUTH_RATE_LIMIT_WINDOW_S (default 900s). As route-level middleware, it runs
  // before the login handler so over-limit attempts are rejected without ever
  // evaluating the supplied credentials (Req 18.2, 18.3); the rejection response
  // includes the seconds remaining until the window resets (Req 18.4). Window
  // expiry resets the counter automatically.
  const authRateLimitWindowMs = getAuthRateLimitWindowS() * 1000;
  const authLimiter = rateLimit({
    windowMs: authRateLimitWindowMs,
    max: getAuthRateLimitMax(),
    message: { error: 'TOO_MANY_ATTEMPTS' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    // Key by source IP only so blocking is per-source and counted across usernames (Req 18.1).
    keyGenerator: (req: Request) => req.ip || 'no-ip',
    // Reject over-limit attempts without evaluating credentials and report the
    // seconds remaining until the source IP may resume attempts (Req 18.2-18.4).
    handler: (req: Request, res: Response) => {
      const resetTime: Date | undefined = req.rateLimit?.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(authRateLimitWindowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'TOO_MANY_ATTEMPTS',
        retryAfterSeconds,
      });
    },
  });

  return { authenticate, checkPermission, authorize, authLimiter };
};

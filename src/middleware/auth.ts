import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { UserRole } from '@alsaqi/shared';
import { PermissionService } from '../services/PermissionService';
import { ModuleRegistry } from '../permissions/registry';
import { PermissionAction } from '../permissions/types';

// Simple in-memory cache to reduce DB load
// In a distributed environment, use Redis. Since this often runs locally/embedded, memory is fine.
// TODO: For multi-instance deployments, replace with Redis:
//   import Redis from 'ioredis';
//   const redis = new Redis(process.env.REDIS_URL);
const cache = new Map<string, { data: any, expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // Prevent unbounded memory growth

// Invalidate all cache entries for a specific user (call after role/permission/status changes)
export const invalidateUserCache = (userId: string) => {
  for (const key of cache.keys()) {
    if (key.includes(userId)) {
      cache.delete(key);
    }
  }
};

// Clear all permission cache entries (call after role permission changes)
export const clearPermissionCache = () => {
  for (const key of cache.keys()) {
    if (key.startsWith('perm_')) {
      cache.delete(key);
    }
  }
};

export const createAuthMiddlewares = (db: any, JWT_SECRET: string, JWT_PUBLIC_KEY: string) => {
  const getCachedOrDb = async (key: string, fetcher: () => Promise<any>) => {
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    
    // Evict expired entries and enforce max size
    if (cache.size >= MAX_CACHE_SIZE) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (v.expires < now) cache.delete(k);
      }
      // If still too large, clear oldest 20%
      if (cache.size >= MAX_CACHE_SIZE) {
        const entries = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires);
        const toRemove = Math.ceil(entries.length * 0.2);
        for (let i = 0; i < toRemove; i++) {
          cache.delete(entries[i][0]);
        }
      }
    }
    
    const data = await fetcher();
    cache.set(key, { data, expires: Date.now() + CACHE_TTL });
    return data;
  };

  const authenticate = async (req: any, res: any, next: any) => {
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
      
      const user = await getCachedOrDb(`user_${decodedToken.id}_${decodedToken.session_version}`, async () => {
        return await db.prepare(`
          SELECT u.id, u.role, u.status, u.username, u.name, u.email, u.session_version, u.requires_password_change, o.id as department_id
          FROM users u
          LEFT JOIN org_entities o ON (u.department = o.name_ar OR u.department = o.name_en)
          WHERE u.id = ?
        `).get(decodedToken.id) as any;
      });
      
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

      // If password change is required, only allow access to password-related auth routes
      if (req.user.requires_password_change) {
        const url = req.originalUrl;
        const allowedPaths = ['/auth/change-password', '/auth/update-password', '/auth/logout', '/auth/refresh', '/auth/session'];
        const isAllowed = allowedPaths.some(path => url.includes(path));
        if (!isAllowed) {
          return res.status(403).json({ 
            error: "Password change required", 
            code: "PASSWORD_CHANGE_REQUIRED" 
          });
        }
      }

      next();
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
      return (req: any, res: any, _next: any) => {
        console.error(`checkPermission: Unregistered module '${module}' used in route middleware.`);
        return res.status(500).json({
          error: 'Internal authorization configuration error',
        });
      };
    }

    return async (req: any, res: any, next: any) => {
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
    return (req: any, res: any, next: any) => {
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: "Forbidden: Insufficient permissions" });
      }
      next();
    };
  };

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP+username combination to 10 login requests per windowMs
    message: { error: "TOO_MANY_ATTEMPTS" },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    // Key by IP + username so that blocking one user doesn't affect others
    keyGenerator: (req: any) => {
      const username = (req.body && req.body.usernameOrEmail) ? String(req.body.usernameOrEmail).toLowerCase() : 'unknown';
      return `${req.ip || 'no-ip'}_${username}`;
    },
  });

  return { authenticate, checkPermission, authorize, authLimiter, cache };
};

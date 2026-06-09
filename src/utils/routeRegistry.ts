/**
 * Route Registry Utility
 * 
 * Detects duplicate route registrations at startup and logs warnings.
 * Also provides a 405 Method Not Allowed handler for custom routes
 * that don't implement all HTTP methods.
 * 
 * Uses a manual registration approach rather than introspecting Express internals,
 * which ensures compatibility across Express versions (including Express 5).
 */
import type { Request, Response, NextFunction } from 'express';

export interface RouteRegistration {
  method: string;
  path: string;
  source: string;
}

export interface DuplicateWarning {
  method: string;
  path: string;
  sources: string[];
}

/**
 * Global route registry that tracks all registered routes.
 * Routes are registered via `registerRoute()` and checked via `detectDuplicates()`.
 */
const registry: RouteRegistration[] = [];

/**
 * Registers a route in the global registry for duplicate detection.
 * Call this when registering routes to track them.
 * 
 * @param method - HTTP method (GET, POST, PUT, DELETE, PATCH, etc.)
 * @param path - The full route path (e.g., '/api/audit-tasks')
 * @param source - Identifier for where this route is registered (e.g., 'crudGenerator' or 'auditTasks.ts')
 */
export function registerRoute(method: string, path: string, source: string): void {
  registry.push({
    method: method.toUpperCase(),
    path: normalizePath(path),
    source,
  });
}

/**
 * Registers multiple routes for a given path prefix and source.
 * Convenience method for CRUD-style route registration.
 * 
 * @param methods - Array of HTTP methods
 * @param pathPrefix - The route path prefix
 * @param source - Identifier for the source of registration
 */
export function registerRoutes(methods: string[], pathPrefix: string, source: string): void {
  for (const method of methods) {
    registerRoute(method, pathPrefix, source);
  }
}

/**
 * Returns all registered routes (for testing/inspection).
 */
export function getRegisteredRoutes(): RouteRegistration[] {
  return [...registry];
}

/**
 * Clears the route registry. Primarily used in tests.
 */
export function clearRegistry(): void {
  registry.length = 0;
}

/**
 * Detects duplicate route registrations and returns warnings.
 * A duplicate is defined as the same HTTP method + normalized path registered more than once.
 */
export function detectDuplicates(routes?: RouteRegistration[]): DuplicateWarning[] {
  const routesToCheck = routes || registry;
  const seen = new Map<string, string[]>();

  for (const route of routesToCheck) {
    const key = `${route.method} ${route.path}`;
    const sources = seen.get(key) || [];
    sources.push(route.source);
    seen.set(key, sources);
  }

  const duplicates: DuplicateWarning[] = [];
  for (const [key, sources] of seen.entries()) {
    if (sources.length > 1) {
      const [method, ...pathParts] = key.split(' ');
      duplicates.push({
        method,
        path: pathParts.join(' '),
        sources,
      });
    }
  }

  return duplicates;
}

/**
 * Logs duplicate route warnings at startup.
 * Call this after all routes have been registered.
 * 
 * @returns Array of detected duplicate warnings
 */
export function logDuplicateRoutes(): DuplicateWarning[] {
  const duplicates = detectDuplicates();

  for (const dup of duplicates) {
    console.warn(
      `[RouteRegistry] Duplicate route detected: ${dup.method} ${dup.path} ` +
      `(registered by: ${dup.sources.join(', ')})`
    );
  }

  return duplicates;
}

/**
 * Middleware that returns 405 Method Not Allowed for HTTP methods
 * not implemented on a custom route.
 * 
 * @param allowedMethods - Array of HTTP methods that are implemented (e.g., ['GET', 'PATCH'])
 * @returns Express middleware that responds with 405 for disallowed methods
 */
export function methodNotAllowed(allowedMethods: string[]) {
  const allowed = allowedMethods.map(m => m.toUpperCase());
  
  return (req: Request, res: Response, _next: NextFunction) => {
    res.setHeader('Allow', allowed.join(', '));
    res.status(405).json({
      success: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${req.method} is not allowed on this resource. Allowed methods: ${allowed.join(', ')}`,
      },
    });
  };
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

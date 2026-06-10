/**
 * Prometheus Metrics Server
 *
 * Exposes a /metrics endpoint in Prometheus text format and provides
 * Express middleware for recording HTTP request duration and error counts.
 *
 * Requirements: 4.1, 4.2, 4.5, 4.6
 */

import { type Request, type Response, type NextFunction } from 'express';
import client from 'prom-client';

// ─── Default Metrics Collection ──────────────────────────────────────────────
// Collects default Node.js metrics (GC, event loop, memory, etc.)
client.collectDefaultMetrics({ prefix: 'alsaqi_' });

// ─── Custom Metrics ──────────────────────────────────────────────────────────

/**
 * HTTP request duration histogram.
 * Labels: method, route, status_code
 * Requirement 4.2: Record response duration labeled by method, route template, status code
 */
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'alsaqi_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * HTTP error counter.
 * Labels: error_type, route
 * Requirement 4.5: On 5xx or unhandled exception, increment error counter
 */
export const httpErrorCounter = new client.Counter({
  name: 'alsaqi_http_errors_total',
  help: 'Total number of HTTP errors (5xx and unhandled exceptions)',
  labelNames: ['error_type', 'route'] as const,
});

// ─── Paths Excluded from Metrics ─────────────────────────────────────────────
// Requirement 4.6: Exclude /metrics and /health from operational metrics recording

const EXCLUDED_PATHS = ['/metrics', '/health', '/api/health', '/api/v1/health'];

function isExcludedPath(path: string): boolean {
  return EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(excluded + '?'));
}

// ─── Route Template Extraction ───────────────────────────────────────────────

/**
 * Extracts the route template from the Express request to avoid label cardinality explosion.
 * Uses req.route.path when available (e.g., /users/:id), otherwise falls back to
 * a normalized path that replaces UUID-like and numeric segments with placeholders.
 */
function getRouteTemplate(req: Request): string {
  // Express populates req.route after route matching
  if (req.route && req.route.path) {
    // Combine the baseUrl (from router mounting) with the route path
    const base = req.baseUrl || '';
    return `${base}${req.route.path}`;
  }

  // Fallback: normalize the path by replacing UUIDs and numeric IDs with :id
  const path = req.path || req.url?.split('?')[0] || 'unknown';
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

// ─── Metrics Recording Middleware ────────────────────────────────────────────

/**
 * Express middleware that records HTTP request duration and error counts.
 * Must be placed early in the middleware stack to capture the full request lifecycle.
 *
 * Requirement 4.2: Records duration histogram for every request (except excluded paths)
 * Requirement 4.5: Increments error counter on 5xx responses
 * Requirement 4.6: Excludes /metrics and /health from recording
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip excluded paths
  const requestPath = req.path || req.url?.split('?')[0] || '';
  if (isExcludedPath(requestPath)) {
    next();
    return;
  }

  const startTime = process.hrtime.bigint();

  // Hook into response finish to record metrics
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationSeconds = Number(endTime - startTime) / 1e9;

    const route = getRouteTemplate(req);
    const method = req.method;
    const statusCode = res.statusCode.toString();

    // Record request duration
    httpRequestDurationHistogram.observe(
      { method, route, status_code: statusCode },
      durationSeconds
    );

    // Record errors (5xx status codes)
    if (res.statusCode >= 500) {
      const errorType = `${Math.floor(res.statusCode / 100)}xx`;
      httpErrorCounter.inc({ error_type: errorType, route });
    }
  });

  next();
}

// ─── Metrics Endpoint Handler ────────────────────────────────────────────────

/**
 * Express route handler for GET /metrics.
 * Returns metrics in Prometheus text/plain format.
 *
 * Requirement 4.1: Respond within 3000ms with Prometheus text format
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  const timeoutMs = 3000;
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const metricsResult = await Promise.race([
      client.register.metrics(),
      timeoutPromise,
    ]);

    if (metricsResult === null) {
      res.status(503).set('Content-Type', 'text/plain').send('# Metrics collection timed out\n');
      return;
    }

    res
      .status(200)
      .set('Content-Type', client.register.contentType)
      .send(metricsResult);
  } catch (err) {
    res.status(500).set('Content-Type', 'text/plain').send('# Error collecting metrics\n');
  }
}

// ─── Unhandled Exception Error Counter ───────────────────────────────────────

/**
 * Middleware to record unhandled exceptions as errors in the metrics.
 * Should be placed after routes but acts as an error-handling middleware.
 *
 * Requirement 4.5: Increment error counter on unhandled exceptions
 */
export function metricsErrorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const route = getRouteTemplate(req);
  const errorType = err.constructor?.name || 'UnhandledError';
  httpErrorCounter.inc({ error_type: errorType, route });
  next(err);
}

// ─── Registry Export (for testing / advanced use) ────────────────────────────

export const metricsRegistry = client.register;

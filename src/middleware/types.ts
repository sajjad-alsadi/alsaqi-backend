/**
 * Middleware option interfaces for the @alsaqi/api middleware layer.
 * These types configure the behavior of various Express middleware components.
 */

/**
 * Options for the unified response wrapper middleware.
 */
export interface ResponseWrapperOptions {
  /** API version string included in response meta (default: '1.0') */
  version?: string;
  /** Paths to exclude from response wrapping (e.g., health checks returning raw data) */
  excludePaths?: string[];
}

/**
 * Options for the request logger middleware.
 */
export interface RequestLoggerOptions {
  /** Paths to exclude from logging (default: ['/api/health', '/uploads']) */
  excludePaths?: string[];
  /** Duration threshold in ms to emit slow-request warnings (default: 3000) */
  slowThreshold?: number;
  /** Whether to log request body content (default: false) */
  logBody?: boolean;
}

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
 * Options for the per-user rate limiter middleware.
 */
export interface RateLimiterOptions {
  /** Max requests per window for authenticated users (default: 100) */
  authenticatedLimit?: number;
  /** Max requests per window for unauthenticated users (default: 50) */
  unauthenticatedLimit?: number;
  /** Sliding window duration in seconds (default: 60) */
  windowSeconds?: number;
  /** Per-endpoint custom rate limits (overrides default limits for specific routes) */
  endpointLimits?: EndpointRateLimitConfig[];
}

/**
 * Options for the idempotency middleware.
 */
export interface IdempotencyOptions {
  /** Header name to read the idempotency key from (default: 'X-Idempotency-Key') */
  headerName?: string;
  /** Time-to-live for stored responses in seconds (default: 86400 = 24 hours) */
  ttl?: number;
  /** HTTP methods to apply idempotency to (default: ['POST', 'PUT']) */
  methods?: string[];
}

/**
 * Options for the secure file access middleware.
 */
export interface SecureFileOptions {
  /** Whether authentication is required (default: true) */
  requireAuth?: boolean;
  /** Whether to check file ownership/module permission (default: true) */
  checkPermission?: boolean;
  /** Roles allowed to access files regardless of ownership */
  allowedRoles?: string[];
  /** Whether to log file access attempts to the audit table (default: true) */
  auditAccess?: boolean;
}

/**
 * Options for the correlation ID middleware.
 */
export interface CorrelationIdOptions {
  /** Request header to read correlation ID from (default: 'x-correlation-id') */
  headerName?: string;
  /** Response header to set correlation ID on (default: 'X-Request-Id') */
  responseHeader?: string;
}

/**
 * Options for the validation middleware.
 */
export interface ValidationOptions {
  /** Whether to strip unknown fields from request body (default: true) */
  stripUnknown?: boolean;
  /** Maximum request body size in bytes (default: 1048576 = 1 MB) */
  maxBodySize?: number;
  /** Paths exempt from body size limit (e.g., file upload endpoints) */
  exemptPaths?: string[];
}

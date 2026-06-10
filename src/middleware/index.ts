/**
 * @alsaqi/api middleware stack
 *
 * Re-exports all middleware modules for use in the API server setup.
 */

export * from './types.js';
export { createCorsMiddleware } from './cors.js';
export type { CorsMiddlewareOptions } from './cors.js';
export { csrfMiddleware, generateCsrfToken, attachCsrfToken } from './csrf.js';
export type { CsrfOptions } from './csrf.js';
export { createRateLimiter, resetRateLimiterStore, stopRateLimiterCleanup, getRateLimitCount, extractClientIp } from './rateLimiter.js';
export { apiVersionMiddleware } from './apiVersion.js';
export { createCorrelationIdMiddleware, correlationIdMiddleware, isValidUuid } from './correlationId.js';
export { createResponseWrapper, responseWrapperMiddleware } from './responseWrapper.js';
export { createCompressionMiddleware } from './compression.js';
export { createHelmetMiddleware } from './helmet.js';
export { globalErrorHandler, sanitizeErrorMessage } from './error.js';
export { notFoundHandler } from './notFoundHandler.js';
export {
  apiVersionHeader,
  unsupportedVersionHandler,
  versionFallbackRewrite,
  CURRENT_API_VERSION,
  SUPPORTED_VERSIONS,
} from './versionRewrite.js';
export {
  validate,
  validateBody,
  validateQuery,
  validateParams,
  validateSchema,
  validateIdParam,
  bodySizeLimit,
  MAX_BODY_SIZE,
} from './validate.js';
export type { FieldError, ValidateOptions } from './validate.js';
export {
  createCachingMiddleware,
  cachingMiddleware,
  staticCachingMiddleware,
  listingCachingMiddleware,
  generateETag,
} from './caching.js';
export type { CachingOptions, CacheResourceType } from './caching.js';

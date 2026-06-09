/**
 * Helmet security headers middleware for the @alsaqi/api package.
 *
 * Configures Content-Security-Policy, HSTS, X-Frame-Options, and other
 * security headers appropriate for an API server.
 */

import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Creates a configured Helmet middleware for security headers.
 *
 * @param env - The current NODE_ENV value ('production', 'development', etc.)
 * @returns Configured Helmet middleware
 */
export function createHelmetMiddleware(env: string): RequestHandler {
  const isProduction = env === 'production';

  return helmet({
    // Content-Security-Policy configured for API-only server
    contentSecurityPolicy: isProduction ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    } : false,

    // Strict-Transport-Security: production only
    strictTransportSecurity: isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,

    // X-Frame-Options: DENY
    frameguard: { action: 'deny' },

    // X-Content-Type-Options: nosniff
    xContentTypeOptions: true,

    // Referrer-Policy: strict-origin-when-cross-origin
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Cross-Origin-Opener-Policy: same-origin
    crossOriginOpenerPolicy: { policy: 'same-origin' },

    // Cross-Origin-Resource-Policy: same-origin
    crossOriginResourcePolicy: { policy: 'same-origin' },

    // Disable X-XSS-Protection (deprecated, can cause issues)
    xXssProtection: false,

    // Cross-Origin-Embedder-Policy: disabled for API compatibility
    crossOriginEmbedderPolicy: false,
  }) as RequestHandler;
}

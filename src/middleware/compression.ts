/**
 * Compression middleware for the @alsaqi/api package.
 *
 * Compresses text-based responses (JSON, HTML, CSS, JavaScript) using gzip.
 */

import compression from 'compression';
import type { Request, Response } from 'express';

/**
 * Creates a configured compression middleware for HTTP responses.
 *
 * Configuration:
 * - threshold: 1024 bytes (1KB) — don't compress small responses
 * - filter: only compress text-based content types
 * - Skips already-compressed binary content (images, PDFs, etc.)
 *
 * @returns Configured compression middleware
 */
export function createCompressionMiddleware() {
  return compression({
    // Don't compress responses smaller than 1KB
    threshold: 1024,

    // Only compress text-based content types
    filter: (req: Request, res: Response): boolean => {
      const contentType = res.getHeader('Content-Type');

      // If no content-type is set yet, fall back to the default compression filter
      if (!contentType) {
        return compression.filter(req, res);
      }

      const type = typeof contentType === 'string' ? contentType : String(contentType);

      // Compress text-based content types
      if (
        /json/i.test(type) ||
        /text\//i.test(type) ||
        /javascript/i.test(type) ||
        /css/i.test(type) ||
        /html/i.test(type) ||
        /xml/i.test(type) ||
        /svg/i.test(type)
      ) {
        return true;
      }

      // Don't compress binary/already-compressed content
      return false;
    },
  });
}

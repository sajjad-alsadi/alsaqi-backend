/**
 * Not Found Handler for unmatched /api/ paths.
 *
 * Returns a JSON 404 response conforming to the standard error envelope
 * with success: false, data: null, error object with traceId, and meta.
 */

import type { Request, Response } from 'express';
import { createErrorResponse } from '../utils/responseEnvelope.js';
import { ErrorCodes } from '@alsaqi/shared';

/**
 * Handles any /api/ request that did not match a registered route.
 * Returns the standard error envelope format with a NOT_FOUND code.
 *
 * MUST be registered AFTER all API route handlers.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response = createErrorResponse({
    code: ErrorCodes.NOT_FOUND,
    message: `API endpoint ${req.originalUrl} not found`,
  });

  res.status(404).json(response);
}

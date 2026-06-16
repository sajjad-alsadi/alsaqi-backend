/**
 * Validation middleware for the @alsaqi/api package.
 *
 * Validates request body, query parameters, and path parameters against
 * Zod schemas from @alsaqi/shared. Returns field-level errors in the
 * single canonical error envelope (see utils/responseEnvelope), using the
 * canonical field-error shape `{ path, message, code }` exposed under
 * `error.details` — so there is exactly one field-error shape across the API.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError, ZodIssue } from 'zod';
import { ErrorCodes } from '@alsaqi/shared';
import { createErrorResponse } from '../utils/responseEnvelope.js';

/**
 * Maximum request body size in bytes (1 MB).
 */
export const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

/**
 * Paths exempt from the 1 MB body size limit (file upload endpoints).
 */
const FILE_UPLOAD_PATHS = [
  '/api/correspondence/attachments',
  '/api/v1/correspondence/attachments',
  '/api/compliance',
  '/api/v1/compliance',
];

/**
 * Represents a single field-level validation error.
 *
 * This is the single canonical field-error shape used across the API
 * (matches the `error.details` entry shape produced by the response envelope).
 */
export interface FieldError {
  path: string;
  message: string;
  code: string;
}

/**
 * Options for the combined validate middleware factory.
 */
export interface ValidateOptions {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Converts a Zod issue into a canonical field-level error object
 * (`{ path, message, code }`).
 */
function zodIssueToFieldError(issue: ZodIssue): FieldError {
  const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
  const message = issue.message;
  const code = issue.code;
  return { path, message, code };
}

/**
 * Converts a ZodError into an array of canonical field-level errors.
 */
function formatZodErrors(error: ZodError): FieldError[] {
  return error.issues.map(zodIssueToFieldError);
}

/**
 * Sends a 400 validation error using the single canonical error envelope.
 */
function sendValidationError(res: Response, message: string, details: FieldError[]): Response {
  return res.status(400).json(
    createErrorResponse({
      code: ErrorCodes.VALIDATION_ERROR,
      message,
      details,
    })
  );
}

/**
 * Validates the request body against a Zod schema.
 */
export const validateBody = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return sendValidationError(res, 'Validation failed', formatZodErrors(error));
      }
      next(error);
    }
  };
};

/**
 * Validates query parameters against a Zod schema.
 */
export const validateQuery = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.query);
      // Express 5 exposes `req.query` as a getter-only property, so a plain
      // assignment (`req.query = parsed`) throws "Cannot set property query ...
      // which has only a getter". Replace the accessor with a writable data
      // property carrying the validated/coerced value instead. This does NOT
      // loosen validation — it only persists the already-parsed result.
      Object.defineProperty(req, 'query', {
        value: parsed,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return sendValidationError(res, 'Query parameter validation failed', formatZodErrors(error));
      }
      next(error);
    }
  };
};

/**
 * Validates path parameters against a Zod schema.
 */
export const validateParams = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.params);
      (req as any).params = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return sendValidationError(res, 'Path parameter validation failed', formatZodErrors(error));
      }
      next(error);
    }
  };
};

/**
 * Combined validation middleware factory.
 * Validates body, query, and/or path params in a single middleware call.
 */
export const validate = (options: ValidateOptions) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const allErrors: FieldError[] = [];

    if (options.params) {
      try {
        const parsed = options.params.parse(req.params);
        (req as any).params = parsed;
      } catch (error) {
        if (error instanceof ZodError) {
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, path: `params.${e.path}` })));
        } else {
          return next(error);
        }
      }
    }

    if (options.query) {
      try {
        const parsed = options.query.parse(req.query);
        // Express 5 `req.query` is getter-only; replace the accessor with the
        // validated value via defineProperty rather than a throwing assignment.
        Object.defineProperty(req, 'query', {
          value: parsed,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (error) {
        if (error instanceof ZodError) {
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, path: `query.${e.path}` })));
        } else {
          return next(error);
        }
      }
    }

    if (options.body) {
      try {
        const parsed = options.body.parse(req.body);
        req.body = parsed;
      } catch (error) {
        if (error instanceof ZodError) {
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, path: `body.${e.path}` })));
        } else {
          return next(error);
        }
      }
    }

    if (allErrors.length > 0) {
      return sendValidationError(res, 'Validation failed', allErrors);
    }

    next();
  };
};

/**
 * Middleware that rejects request bodies exceeding 1 MB with 413 status.
 * File upload endpoints are exempt.
 */
export const bodySizeLimit = (req: Request, res: Response, next: NextFunction) => {
  const requestPath = req.path || req.originalUrl;
  const isFileUpload = FILE_UPLOAD_PATHS.some(
    (uploadPath) => requestPath.startsWith(uploadPath) || requestPath === uploadPath
  );

  if (isFileUpload) {
    return next();
  }

  const tooLarge = () =>
    res.status(413).json(
      createErrorResponse({
        code: ErrorCodes.PAYLOAD_TOO_LARGE,
        message: 'Request body exceeds the maximum allowed size of 1 MB',
      })
    );

  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return tooLarge();
  }

  if (req.body && typeof req.body === 'object') {
    const bodyStr = JSON.stringify(req.body);
    if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_SIZE) {
      return tooLarge();
    }
  }

  next();
};

/**
 * Alias for validateBody.
 * Validates request body against a Zod schema.
 * Kept for backward compatibility with routes migrated from the monolith.
 */
export const validateSchema = validateBody;

/**
 * Validates that a path parameter is either a valid integer or UUID.
 */
export const validateIdParam = (paramName = 'id') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const rawValue = req.params[paramName];
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

    if (!value) {
      return sendValidationError(res, `Path parameter '${paramName}' is required`, [
        { path: paramName, message: `${paramName} is required`, code: 'required' },
      ]);
    }

    const isInteger = /^\d+$/.test(value);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    if (!isInteger && !isUUID) {
      return sendValidationError(
        res,
        `Path parameter '${paramName}' must be a valid integer or UUID`,
        [{ path: paramName, message: `${paramName} must be a valid integer or UUID`, code: 'format' }]
      );
    }

    next();
  };
};

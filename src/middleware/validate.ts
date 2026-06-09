/**
 * Validation middleware for the @alsaqi/api package.
 *
 * Validates request body, query parameters, and path parameters against
 * Zod schemas from @alsaqi/shared. Returns field-level errors in the
 * standard error response format.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError, ZodIssue } from 'zod';
import { ErrorCodes } from '@alsaqi/shared';

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
 */
export interface FieldError {
  field: string;
  rule: string;
  message: string;
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
 * Converts a Zod issue into a field-level error object.
 */
function zodIssueToFieldError(issue: ZodIssue): FieldError {
  const field = issue.path.length > 0 ? issue.path.join('.') : '_root';
  const rule = issue.code;
  const message = issue.message;
  return { field, rule, message };
}

/**
 * Converts a ZodError into an array of field-level errors.
 */
function formatZodErrors(error: ZodError): FieldError[] {
  return error.issues.map(zodIssueToFieldError);
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
        const errors = formatZodErrors(error);
        return res.status(400).json({
          success: false,
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Validation failed',
            errors,
          },
        });
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
      (req as any).query = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        return res.status(400).json({
          success: false,
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Query parameter validation failed',
            errors,
          },
        });
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
        const errors = formatZodErrors(error);
        return res.status(400).json({
          success: false,
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Path parameter validation failed',
            errors,
          },
        });
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
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, field: `params.${e.field}` })));
        } else {
          return next(error);
        }
      }
    }

    if (options.query) {
      try {
        const parsed = options.query.parse(req.query);
        (req as any).query = parsed;
      } catch (error) {
        if (error instanceof ZodError) {
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, field: `query.${e.field}` })));
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
          allErrors.push(...formatZodErrors(error).map((e) => ({ ...e, field: `body.${e.field}` })));
        } else {
          return next(error);
        }
      }
    }

    if (allErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Validation failed',
          errors: allErrors,
        },
      });
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

  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return res.status(413).json({
      success: false,
      error: {
        code: ErrorCodes.PAYLOAD_TOO_LARGE,
        message: 'Request body exceeds the maximum allowed size of 1 MB',
      },
    });
  }

  if (req.body && typeof req.body === 'object') {
    const bodyStr = JSON.stringify(req.body);
    if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_SIZE) {
      return res.status(413).json({
        success: false,
        error: {
          code: ErrorCodes.PAYLOAD_TOO_LARGE,
          message: 'Request body exceeds the maximum allowed size of 1 MB',
        },
      });
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
      return res.status(400).json({
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Path parameter '${paramName}' is required`,
          errors: [{ field: paramName, rule: 'required', message: `${paramName} is required` }],
        },
      });
    }

    const isInteger = /^\d+$/.test(value);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    if (!isInteger && !isUUID) {
      return res.status(400).json({
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: `Path parameter '${paramName}' must be a valid integer or UUID`,
          errors: [
            {
              field: paramName,
              rule: 'format',
              message: `${paramName} must be a valid integer or UUID`,
            },
          ],
        },
      });
    }

    next();
  };
};

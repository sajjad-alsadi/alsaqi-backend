/**
 * Unified API response contract types and Zod schemas.
 * Defines the standard envelope for all API responses.
 */
import { z } from 'zod';

// ─── Pagination Meta ──────────────────────────────────────────────────────────

export const PaginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});

export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

// ─── Response Meta ────────────────────────────────────────────────────────────

export const ResponseMetaSchema = z.object({
  requestId: z.string().uuid(),
  timestamp: z.string().datetime(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  pagination: PaginationMetaSchema.optional(),
});

export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

// ─── Error Detail ─────────────────────────────────────────────────────────────

export const ErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

// ─── Success Response Schema ──────────────────────────────────────────────────

export const SuccessResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: ResponseMetaSchema,
  });

export type SuccessResponse<T> = {
  success: true;
  data: T;
  meta: ResponseMeta;
};

// ─── Error Response Schema ────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    traceId: z.string(),
    details: z.array(ErrorDetailSchema).optional(),
  }),
  meta: z.object({
    requestId: z.string().uuid(),
    timestamp: z.string().datetime(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── Combined API Response Type ───────────────────────────────────────────────

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// ─── API Error Type (for client-side error handling) ──────────────────────────

export interface ApiError {
  code: string;
  message: string;
  traceId: string;
  details?: ErrorDetail[];
  status: number;
}

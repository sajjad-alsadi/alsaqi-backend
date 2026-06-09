import { z } from 'zod';

/**
 * Schema for CRUD generator GET endpoint filter/query parameters.
 * Validates pagination and common filter patterns used across all CRUD-generated endpoints.
 *
 * Requirements: 6.1, 6.3
 */
export const crudPaginationSchema = z.object({
  page: z.coerce
    .number()
    .int({ message: 'page must be an integer' })
    .min(1, { message: 'page must be at least 1' })
    .default(1),
  pageSize: z.coerce
    .number()
    .int({ message: 'pageSize must be an integer' })
    .min(1, { message: 'pageSize must be at least 1' })
    .max(200, { message: 'pageSize must not exceed 200' })
    .default(50),
});

/**
 * Schema for common filter parameters used in CRUD generator GET endpoints.
 * Filters are passed as query params and matched against allowed table fields.
 * All filter values are strings from query params; they are validated for safe content.
 *
 * Requirements: 6.1, 6.3
 */
export const crudFilterValueSchema = z
  .string()
  .max(500, { message: 'Filter value must not exceed 500 characters' })
  .refine((val) => !val.includes(';') && !val.includes('--'), {
    message: 'Filter value contains disallowed characters',
  });

/**
 * Schema for the full CRUD GET query parameters (pagination + dynamic filters).
 * Dynamic filters are validated individually against crudFilterValueSchema.
 *
 * Requirements: 6.1, 6.3
 */
export const crudQuerySchema = crudPaginationSchema.catchall(crudFilterValueSchema);

/**
 * Schema for status filter values commonly used across entities.
 */
export const statusFilterSchema = z
  .string()
  .max(50, { message: 'status must not exceed 50 characters' })
  .optional();

/**
 * Schema for date range filter parameters.
 */
export const dateRangeFilterSchema = z.object({
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'from_date must be in YYYY-MM-DD format' })
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'to_date must be in YYYY-MM-DD format' })
    .optional(),
});

/**
 * Schema for ID path parameter validation (integer or UUID).
 *
 * Requirements: 6.6
 */
export const idParamSchema = z.object({
  id: z
    .string()
    .refine(
      (val) =>
        /^\d+$/.test(val) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val),
      { message: 'id must be a valid integer or UUID' }
    ),
});

export type CrudPagination = z.infer<typeof crudPaginationSchema>;
export type CrudQuery = z.infer<typeof crudQuerySchema>;
export type IdParam = z.infer<typeof idParamSchema>;

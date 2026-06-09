import { z } from 'zod';

/**
 * Base schema for analytics query parameters shared across all analytics endpoints.
 * Supports optional date range filtering and department scoping.
 *
 * Requirements: 6.3
 */
export const analyticsBaseQuerySchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be in YYYY-MM-DD format' })
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate must be in YYYY-MM-DD format' })
    .optional(),
  department: z.string().max(255).optional(),
});

/**
 * Schema for GET /api/analytics/findings-by-risk query parameters.
 *
 * Requirements: 6.3
 */
export const findingsByRiskQuerySchema = analyticsBaseQuerySchema;

/**
 * Schema for GET /api/analytics/findings-by-status query parameters.
 *
 * Requirements: 6.3
 */
export const findingsByStatusQuerySchema = analyticsBaseQuerySchema;

/**
 * Schema for GET /api/analytics/recommendations-by-status query parameters.
 *
 * Requirements: 6.3
 */
export const recommendationsByStatusQuerySchema = analyticsBaseQuerySchema;

export type AnalyticsBaseQuery = z.infer<typeof analyticsBaseQuerySchema>;

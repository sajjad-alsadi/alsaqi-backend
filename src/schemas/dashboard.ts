import { z } from 'zod';

/**
 * Schema for GET /api/dashboard-stats query parameters.
 * Uses coercion to convert string query params to appropriate types.
 *
 * Requirements: 6.3
 */
export const dashboardStatsQuerySchema = z.object({
  department: z.string().max(255).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

/**
 * Schema for GET /api/my-tasks query parameters.
 * Coerces string query params to numbers for pagination.
 * Uses unified page/pageSize parameters via parsePaginationParams.
 *
 * Requirements: 5.5, 6.3
 */
export const myTasksQuerySchema = z.object({
  page: z.coerce
    .number()
    .int({ message: 'page must be an integer' })
    .min(1, { message: 'page must be at least 1' })
    .default(1),
  pageSize: z.coerce
    .number()
    .int({ message: 'pageSize must be an integer' })
    .min(1, { message: 'pageSize must be at least 1' })
    .max(100, { message: 'pageSize must not exceed 100' })
    .default(20),
});

export type DashboardStatsQuery = z.infer<typeof dashboardStatsQuerySchema>;
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;

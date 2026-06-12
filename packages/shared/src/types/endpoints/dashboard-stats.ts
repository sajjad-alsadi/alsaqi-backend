/**
 * Endpoint contract interfaces for the Dashboard Stats module.
 * Defines the request/response shapes for each route.
 *
 * The aggregated dashboard statistics are produced by `DashboardService`
 * (`getDashboardStats` in `src/services/DashboardService.ts`) and typed by the
 * `DashboardStats` model (see `packages/shared/src/types/models.ts`).
 */
import type { DashboardStats } from '../models';

export interface DashboardStatsEndpoints {
  'GET /dashboard-stats': {
    query: { department?: string; riskLevel?: string };
    response: DashboardStats;
  };
}

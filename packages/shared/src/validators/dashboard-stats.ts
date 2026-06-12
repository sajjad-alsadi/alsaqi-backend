/**
 * Dashboard stats validation schemas.
 * Used by both API (response validation) and Frontend (shape assertions).
 *
 * This is a read-only endpoint, so the schema validates the successful HTTP 200
 * response body of `GET /v1/dashboard-stats`. It is authored against the live
 * `DashboardService.getDashboardStats` output (see
 * `src/services/DashboardService.ts`) and typed by the `DashboardStats` model
 * (see `packages/shared/src/types/models.ts`).
 */
import { z } from 'zod';

/**
 * A single row in the audit progress-by-type breakdown.
 * Mirrors the `AuditProgressByType` model.
 */
export const AuditProgressByTypeSchema = z.object({
  type: z.string(),
  planned: z.number(),
  completed: z.number(),
});

export type AuditProgressByTypeOutput = z.infer<typeof AuditProgressByTypeSchema>;

/**
 * A single risk-level bucket in the dashboard risk overview.
 * Mirrors the `RiskLevelBreakdown` model.
 */
export const RiskLevelBreakdownSchema = z.object({
  level: z.string(),
  count: z.number(),
});

export type RiskLevelBreakdownOutput = z.infer<typeof RiskLevelBreakdownSchema>;

/**
 * Aggregated dashboard statistics response schema.
 * Maps to the GET /dashboard-stats endpoint response body.
 *
 * The nested objects allow the extra fields the service emits beyond the
 * documented `DashboardStats` contract (e.g. `in_progress`, `delayed`,
 * `findings.summary.total`, `findings.byRisk`, `recommendations.total`) so the
 * live response validates without error while the documented fields remain
 * required.
 */
export const DashboardStatsResponseSchema = z.object({
  audits: z
    .object({
      total: z.number(),
      completed: z.number(),
      progress_by_type: z.array(AuditProgressByTypeSchema),
    })
    .passthrough(),
  findings: z
    .object({
      summary: z
        .object({
          open: z.number(),
          high_risk_open: z.number(),
        })
        .passthrough(),
    })
    .passthrough(),
  recommendations: z
    .object({
      open: z.number(),
      overdue: z.number(),
    })
    .passthrough(),
  risks: z
    .object({
      summary: z
        .object({
          total: z.number(),
          high: z.number(),
        })
        .passthrough(),
      byLevel: z.array(RiskLevelBreakdownSchema).optional(),
    })
    .passthrough(),
  correspondence: z.object({
    incoming_total: z.number(),
    outgoing_total: z.number(),
    pending_responses: z.number(),
  }),
  compliance: z.object({
    total: z.number(),
  }),
  activity: z.array(z.record(z.string(), z.unknown())),
});

export type DashboardStatsResponse = z.infer<typeof DashboardStatsResponseSchema>;

/**
 * Audit plans validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';

/**
 * Valid quarter values for audit plans.
 */
export const VALID_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4', 'Annual'] as const;

/**
 * Valid plan statuses.
 */
export const VALID_PLAN_STATUSES = ['Planned', 'Fieldwork', 'Reporting', 'Closed'] as const;

/**
 * Create audit plan request schema.
 * Maps to POST /audit-plans endpoint.
 */
export const CreateAuditPlanSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  year: z.number().int().min(2000).max(2100),
  quarter: z.enum(VALID_QUARTERS).default('Annual'),
  department: z.string().min(1).max(100).optional().nullable(),
  type: z.string().min(1).max(100).optional().nullable(),
  risk_rating: z.string().min(1).max(50).optional().nullable(),
  planned_start_date: z.string().min(1).max(50).optional().nullable(),
  planned_end_date: z.string().min(1).max(50).optional().nullable(),
  lead_auditor: z.string().min(1).max(100).optional().nullable(),
  team_members: z.string().min(1).max(1000).optional().nullable(),
  objectives: z.string().min(1).max(5000).optional().nullable(),
  scope: z.string().min(1).max(5000).optional().nullable(),
  notes: z.string().min(1).max(5000).optional().nullable(),
  program_id: z.string().min(1).max(100).optional().nullable(),
});

export type CreateAuditPlanInput = z.infer<typeof CreateAuditPlanSchema>;

/**
 * Update audit plan request schema.
 * All fields are optional (partial update).
 * Maps to PUT /audit-plans/:id endpoint.
 */
export const UpdateAuditPlanSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255).optional(),
  department: z.string().min(1).max(100).optional().nullable(),
  type: z.string().min(1).max(100).optional().nullable(),
  risk_rating: z.string().min(1).max(50).optional().nullable(),
  planned_start_date: z.string().min(1).max(50).optional().nullable(),
  planned_end_date: z.string().min(1).max(50).optional().nullable(),
  status: z.enum(VALID_PLAN_STATUSES).optional(),
  lead_auditor: z.string().min(1).max(100).optional().nullable(),
  team_members: z.string().min(1).max(1000).optional().nullable(),
  objectives: z.string().min(1).max(5000).optional().nullable(),
  scope: z.string().min(1).max(5000).optional().nullable(),
  notes: z.string().min(1).max(5000).optional().nullable(),
  program_id: z.string().min(1).max(100).optional().nullable(),
});

export type UpdateAuditPlanInput = z.infer<typeof UpdateAuditPlanSchema>;

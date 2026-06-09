/**
 * Audit findings validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';

/**
 * Valid finding types as defined in the AuditService.
 */
export const VALID_FINDING_TYPES = [
  'control_design_deficiency',
  'operational_design_deficiency',
] as const;

/**
 * Create finding request schema.
 * Maps to the POST /audit-findings endpoint.
 */
export const CreateFindingSchema = z.object({
  audit_id: z.string().min(1, 'Audit ID is required').max(100),
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().min(1).max(5000).optional(),
  criteria: z.string().min(1).max(5000).optional(),
  condition: z.string().min(1).max(5000).optional(),
  finding_type: z.enum(VALID_FINDING_TYPES),
  consequence: z.string().min(1).max(5000).optional(),
  risk_level: z.enum(['Low', 'Medium', 'High', 'Critical']),
});

export type CreateFindingInput = z.infer<typeof CreateFindingSchema>;

/**
 * Update finding request schema.
 * All fields are optional (partial update).
 * Maps to the PUT /audit-findings/:id endpoint.
 */
export const UpdateFindingSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500).optional(),
  description: z.string().min(1).max(5000).optional().nullable(),
  criteria: z.string().min(1).max(5000).optional().nullable(),
  condition: z.string().min(1).max(5000).optional().nullable(),
  finding_type: z.enum(VALID_FINDING_TYPES).optional(),
  consequence: z.string().min(1).max(5000).optional().nullable(),
  cause: z.string().min(1).max(5000).optional().nullable(),
  recommendation: z.string().min(1).max(5000).optional().nullable(),
  risk_level: z.enum(['Low', 'Medium', 'High', 'Critical']).optional(),
  status: z.enum(['Open', 'In Progress', 'Closed', 'Pending Approval']).optional(),
  impact: z.string().min(1).max(5000).optional().nullable(),
  root_cause: z.string().min(1).max(5000).optional().nullable(),
  responsible_unit_id: z.string().min(1).max(100).optional().nullable(),
});

export type UpdateFindingInput = z.infer<typeof UpdateFindingSchema>;

/**
 * Change finding status schema.
 * Maps to the PATCH /audit-findings/:id/status endpoint.
 */
export const ChangeFindingStatusSchema = z.object({
  status: z.enum(['Open', 'In Progress', 'Closed', 'Pending Approval']),
});

export type ChangeFindingStatusInput = z.infer<typeof ChangeFindingStatusSchema>;

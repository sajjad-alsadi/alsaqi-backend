/**
 * Audit tasks validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';

/**
 * Valid task statuses matching the workflow transitions.
 */
export const VALID_TASK_STATUSES = [
  'draft',
  'in_progress',
  'review',
  'approved',
  'completed',
] as const;

/**
 * Valid audit types for tasks.
 */
export const VALID_AUDIT_TYPES = [
  'Operational',
  'Financial',
  'Compliance',
  'IT',
  'AML',
  'Governance',
] as const;

/**
 * Create audit task request schema.
 * Maps to POST /audit-tasks endpoint.
 */
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  plan_id: z.string().min(1, 'Plan ID is required').max(100),
  program_id: z.string().min(1).max(100).optional().nullable(),
  audit_type: z.enum(VALID_AUDIT_TYPES),
  assigned_to: z.string().min(1).max(100).optional().nullable(),
  audited_unit_id: z.string().min(1).max(100).optional().nullable(),
  planned_hours: z.number().min(0).optional().nullable(),
  actual_hours: z.number().min(0).optional().nullable(),
  period_from: z.string().min(1).max(50).optional().nullable(),
  period_to: z.string().min(1).max(50).optional().nullable(),
  due_date: z.string().min(1).max(50).optional().nullable(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * Update audit task request schema.
 * All fields are optional (partial update).
 * Maps to PUT /audit-tasks/:id endpoint.
 */
export const UpdateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255).optional(),
  program_id: z.string().min(1).max(100).optional().nullable(),
  audit_type: z.enum(VALID_AUDIT_TYPES).optional(),
  assigned_to: z.string().min(1).max(100).optional().nullable(),
  audited_unit_id: z.string().min(1).max(100).optional().nullable(),
  planned_hours: z.number().min(0).optional().nullable(),
  actual_hours: z.number().min(0).optional().nullable(),
  period_from: z.string().min(1).max(50).optional().nullable(),
  period_to: z.string().min(1).max(50).optional().nullable(),
  due_date: z.string().min(1).max(50).optional().nullable(),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/**
 * Change task status schema.
 * Maps to PATCH /audit-tasks/:id/status endpoint.
 */
export const ChangeTaskStatusSchema = z.object({
  status: z.enum(VALID_TASK_STATUSES),
});

export type ChangeTaskStatusInput = z.infer<typeof ChangeTaskStatusSchema>;

/**
 * Assign users to a task schema.
 * Maps to POST /audit-tasks/:id/assign endpoint.
 */
export const AssignTaskUsersSchema = z.object({
  userIds: z.array(z.string().min(1).max(100)).min(1, 'At least one user ID is required'),
});

export type AssignTaskUsersInput = z.infer<typeof AssignTaskUsersSchema>;

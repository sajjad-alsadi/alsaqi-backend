/**
 * Risk register validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 *
 * Authored against the live `/v1/risk-register` response shape, which is
 * produced by the CRUD generator for the `risk_register` entity
 * (see `src/utils/crudGenerator.ts`) and typed by the `RiskItem` model
 * (see `packages/shared/src/types/models.ts`). The existing endpoint
 * contract (`types/endpoints/risk-register.ts`) is retained unchanged.
 */
import { z } from 'zod';

/**
 * Create risk register entry request schema.
 * Maps to the POST /risk-register endpoint.
 *
 * `risk_id` is omitted from the required set because it is auto-generated
 * server-side (see `AppCodeGenerator`); callers may still supply it.
 */
export const CreateRiskRegisterSchema = z.object({
  risk_id: z.string().min(1).max(100).optional(),
  description: z.string().min(1, 'Description is required').max(5000),
  owner: z.string().min(1).max(255).optional().nullable(),
  source: z.string().min(1).max(255).optional().nullable(),
  early_warning: z.string().min(1).max(5000).optional().nullable(),
  type: z.string().min(1).max(100).optional().nullable(),
  likelihood: z.string().min(1).max(50).optional().nullable(),
  impact: z.string().min(1).max(50).optional().nullable(),
  score: z.number().optional().nullable(),
  rating: z.string().min(1).max(50).optional().nullable(),
  controls: z.string().min(1).max(5000).optional().nullable(),
  control_assessment: z.string().min(1).max(5000).optional().nullable(),
  mitigation: z.string().min(1).max(5000).optional().nullable(),
  treatment_option: z.string().min(1).max(255).optional().nullable(),
  residual_likelihood: z.string().min(1).max(50).optional().nullable(),
  residual_impact: z.string().min(1).max(50).optional().nullable(),
  residual_score: z.number().optional().nullable(),
  residual_rating: z.string().min(1).max(50).optional().nullable(),
  status: z.string().min(1).max(50).optional().nullable(),
  target_date: z.string().min(1).max(50).optional().nullable(),
  review_date: z.string().min(1).max(50).optional().nullable(),
  notes: z.string().min(1).max(5000).optional().nullable(),
  entry_date: z.string().min(1).max(50).optional().nullable(),
  entered_by: z.string().min(1).max(255).optional().nullable(),
});

export type CreateRiskRegisterInput = z.infer<typeof CreateRiskRegisterSchema>;

/**
 * Update risk register entry request schema.
 * All fields are optional (partial update).
 * Maps to the PUT /risk-register/:id endpoint.
 */
export const UpdateRiskRegisterSchema = z.object({
  description: z.string().min(1, 'Description is required').max(5000).optional(),
  owner: z.string().min(1).max(255).optional().nullable(),
  source: z.string().min(1).max(255).optional().nullable(),
  early_warning: z.string().min(1).max(5000).optional().nullable(),
  type: z.string().min(1).max(100).optional().nullable(),
  likelihood: z.string().min(1).max(50).optional().nullable(),
  impact: z.string().min(1).max(50).optional().nullable(),
  score: z.number().optional().nullable(),
  rating: z.string().min(1).max(50).optional().nullable(),
  controls: z.string().min(1).max(5000).optional().nullable(),
  control_assessment: z.string().min(1).max(5000).optional().nullable(),
  mitigation: z.string().min(1).max(5000).optional().nullable(),
  treatment_option: z.string().min(1).max(255).optional().nullable(),
  residual_likelihood: z.string().min(1).max(50).optional().nullable(),
  residual_impact: z.string().min(1).max(50).optional().nullable(),
  residual_score: z.number().optional().nullable(),
  residual_rating: z.string().min(1).max(50).optional().nullable(),
  status: z.string().min(1).max(50).optional().nullable(),
  target_date: z.string().min(1).max(50).optional().nullable(),
  review_date: z.string().min(1).max(50).optional().nullable(),
  notes: z.string().min(1).max(5000).optional().nullable(),
  entry_date: z.string().min(1).max(50).optional().nullable(),
  entered_by: z.string().min(1).max(255).optional().nullable(),
});

export type UpdateRiskRegisterInput = z.infer<typeof UpdateRiskRegisterSchema>;

/**
 * Central bank instructions validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 *
 * Authored against the live `/v1/central-bank-instructions` response shape,
 * which is produced by the CRUD generator for the `central_bank_instructions`
 * entity (see `src/utils/crudGenerator.ts`, allowed fields:
 * `title, issue_date, reference_number, category, description,
 * related_department, attachment, status, related_instruction_id`) and typed
 * by the `CentralBankInstruction` model
 * (see `packages/shared/src/types/models.ts`).
 */
import { z } from 'zod';

/**
 * Create central bank instruction request schema.
 * Maps to the POST /central-bank-instructions endpoint.
 */
export const CreateCentralBankInstructionSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  issue_date: z.string().min(1, 'Issue date is required').max(50),
  reference_number: z.string().min(1, 'Reference number is required').max(200),
  category: z.string().min(1, 'Category is required').max(255),
  description: z.string().min(1, 'Description is required').max(5000),
  related_department: z.string().min(1, 'Related department is required').max(255),
  attachment: z.string().min(1).max(2000).optional().nullable(),
  status: z.string().min(1, 'Status is required').max(50),
  related_instruction_id: z.string().min(1).max(100).optional().nullable(),
});

export type CreateCentralBankInstructionInput = z.infer<typeof CreateCentralBankInstructionSchema>;

/**
 * Update central bank instruction request schema.
 * All fields are optional (partial update).
 * Maps to the PUT /central-bank-instructions/:id endpoint.
 */
export const UpdateCentralBankInstructionSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500).optional(),
  issue_date: z.string().min(1).max(50).optional(),
  reference_number: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(255).optional(),
  description: z.string().min(1).max(5000).optional(),
  related_department: z.string().min(1).max(255).optional(),
  attachment: z.string().min(1).max(2000).optional().nullable(),
  status: z.string().min(1).max(50).optional(),
  related_instruction_id: z.string().min(1).max(100).optional().nullable(),
});

export type UpdateCentralBankInstructionInput = z.infer<typeof UpdateCentralBankInstructionSchema>;

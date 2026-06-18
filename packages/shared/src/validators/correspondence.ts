/**
 * Correspondence validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';
import {
  ENTITY_TYPES,
  CLASSIFICATIONS,
  PRIORITIES,
  METHODS,
  LINK_TYPES,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
} from '../constants/correspondence';

/**
 * Create incoming correspondence schema.
 * Maps to POST /correspondence/incoming endpoint.
 */
export const CreateIncomingCorrespondenceSchema = z.object({
  letter_number: z.string().min(1, 'Letter number is required').max(100),
  sender_entity: z.string().min(1, 'Sender entity is required').max(255),
  sender_entity_type: z.enum(ENTITY_TYPES).optional(),
  subject: z.string().min(1, 'Subject is required').max(500),
  letter_date: z.string().min(1, 'Letter date is required').max(50),
  receipt_date: z.string().min(1, 'Receipt date is required').max(50),
  classification: z.enum(CLASSIFICATIONS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  method: z.enum(METHODS).optional(),
  receiving_dept_id: z.string().min(1).max(100).optional().nullable(),
  assigned_dept_id: z.string().min(1).max(100).optional().nullable(),
  assigned_user_id: z.string().min(1).max(100).optional().nullable(),
  follow_up_required: z.boolean().optional(),
  follow_up_date: z.string().min(1).max(50).optional().nullable(),
  response_required: z.boolean().optional(),
  response_due_date: z.string().min(1).max(50).optional().nullable(),
  notes: z.string().min(1).max(2000).optional().nullable(),
});

export type CreateIncomingCorrespondenceInput = z.infer<typeof CreateIncomingCorrespondenceSchema>;

/**
 * Update incoming correspondence schema (partial update).
 * Maps to PUT /correspondence/incoming/:id endpoint.
 */
export const UpdateIncomingCorrespondenceSchema = CreateIncomingCorrespondenceSchema.partial();

export type UpdateIncomingCorrespondenceInput = z.infer<typeof UpdateIncomingCorrespondenceSchema>;

/**
 * Create outgoing correspondence schema.
 * Maps to POST /correspondence/outgoing endpoint.
 */
export const CreateOutgoingCorrespondenceSchema = z.object({
  letter_date: z.string().min(1, 'Letter date is required').max(50),
  recipient_entity: z.string().min(1, 'Recipient entity is required').max(255),
  subject: z.string().min(1, 'Subject is required').max(500),
  classification: z.enum(CLASSIFICATIONS).optional(),
  sending_method: z.enum(METHODS).optional(),
  attachment_file: z.string().min(1).max(500).optional().nullable(),
});

export type CreateOutgoingCorrespondenceInput = z.infer<typeof CreateOutgoingCorrespondenceSchema>;

/**
 * Update outgoing correspondence schema (partial update).
 * Maps to PUT /correspondence/outgoing/:id endpoint.
 */
export const UpdateOutgoingCorrespondenceSchema = CreateOutgoingCorrespondenceSchema.partial();

export type UpdateOutgoingCorrespondenceInput = z.infer<typeof UpdateOutgoingCorrespondenceSchema>;

/**
 * Refer correspondence schema.
 * Maps to POST /correspondence/refer endpoint.
 */
export const ReferCorrespondenceSchema = z.object({
  incoming_id: z.string().min(1, 'Incoming ID is required').max(100),
  to_dept_id: z.string().min(1, 'Department ID is required').max(100),
  to_user_id: z.string().min(1).max(100).optional().nullable(),
  notes: z.string().min(1).max(2000).optional().nullable(),
});

export type ReferCorrespondenceInput = z.infer<typeof ReferCorrespondenceSchema>;

/**
 * Link correspondence schema.
 * Maps to POST /correspondence/link endpoint.
 */
export const LinkCorrespondenceSchema = z.object({
  incoming_id: z.string().min(1, 'Incoming ID is required').max(100),
  outgoing_id: z.string().min(1, 'Outgoing ID is required').max(100),
  link_type: z.enum(LINK_TYPES).optional().default('Reply'),
});

export type LinkCorrespondenceInput = z.infer<typeof LinkCorrespondenceSchema>;

/**
 * Status update schemas.
 * Maps to PUT /correspondence/status/:type/:id endpoint.
 * Type-aware: incoming and outgoing have different allowed status values.
 */
export const IncomingStatusUpdateSchema = z.object({
  new_status: z.enum(INCOMING_STATUSES),
  notes: z.string().min(1).max(2000).optional().nullable(),
});

export type IncomingStatusUpdateInput = z.infer<typeof IncomingStatusUpdateSchema>;

export const OutgoingStatusUpdateSchema = z.object({
  new_status: z.enum(OUTGOING_STATUSES),
  notes: z.string().min(1).max(2000).optional().nullable(),
});

export type OutgoingStatusUpdateInput = z.infer<typeof OutgoingStatusUpdateSchema>;

/**
 * @deprecated Use IncomingStatusUpdateSchema or OutgoingStatusUpdateSchema instead.
 * Kept for backward compatibility with existing consumers.
 */
export const CorrespondenceStatusUpdateSchema = z.object({
  new_status: z.string().min(1, 'Status is required').max(50),
  notes: z.string().min(1).max(2000).optional().nullable(),
});

export type CorrespondenceStatusUpdateInput = z.infer<typeof CorrespondenceStatusUpdateSchema>;

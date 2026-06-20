import { z } from 'zod';

/**
 * Allowed MIME types for correspondence attachments.
 * Covers common document, spreadsheet, and image formats.
 */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
] as const;

/**
 * Maximum file size in bytes: 10 MB
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10485760 bytes

/**
 * Maximum filename length
 */
export const MAX_FILENAME_LENGTH = 255;

/**
 * Schema for validating file upload metadata on POST /api/correspondence/attachments.
 *
 * Casing convention (finding 1.1 -> 2.1): `correspondence_type` is lowercase at the HTTP
 * edge (matching the lowercase `:type` path params); `CorrespondenceService.addAttachment`
 * normalizes it to the capitalized `Incoming`/`Outgoing` stored in the column before the insert.
 *
 * The schema validates the fields actually persisted by the DB insert — `file_type` (MIME,
 * checked against the allowlist) and `file_data` — rather than the unpersisted
 * `file_size`/`mime_type`. The route registers this schema WITHOUT `.passthrough()`, so any
 * column not declared here is stripped and never reaches the insert.
 *
 * Requirements: 6.4, 1.1, 2.1
 */
export const correspondenceAttachmentSchema = z.object({
  correspondence_id: z.string().uuid({ message: 'correspondence_id must be a valid UUID' }),
  correspondence_type: z.enum(['incoming', 'outgoing'], {
    message: 'correspondence_type must be "incoming" or "outgoing"',
  }),
  file_name: z
    .string()
    .min(1, { message: 'file_name is required' })
    .max(MAX_FILENAME_LENGTH, {
      message: `file_name must not exceed ${MAX_FILENAME_LENGTH} characters`,
    }),
  file_type: z.enum(ALLOWED_MIME_TYPES, {
    message: `file_type must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
  }),
  file_data: z.string().min(1, { message: 'file_data is required' }),
  description: z.string().max(500).optional().nullable(),
});

export type CorrespondenceAttachmentInput = z.infer<typeof correspondenceAttachmentSchema>;

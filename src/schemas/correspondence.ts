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
 * Validates file size, filename length, and MIME type against an allowlist.
 *
 * Requirements: 6.4
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
  file_size: z
    .number({ message: 'file_size must be a number' })
    .int({ message: 'file_size must be an integer' })
    .positive({ message: 'file_size must be positive' })
    .max(MAX_FILE_SIZE, {
      message: `file_size must not exceed ${MAX_FILE_SIZE} bytes (10 MB)`,
    }),
  mime_type: z.enum(ALLOWED_MIME_TYPES, {
    message: `mime_type must be one of: ${ALLOWED_MIME_TYPES.join(', ')}`,
  }),
  description: z.string().max(500).optional().nullable(),
});

export type CorrespondenceAttachmentInput = z.infer<typeof correspondenceAttachmentSchema>;

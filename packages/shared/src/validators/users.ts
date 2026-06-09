/**
 * User management validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';

/**
 * Valid user statuses.
 */
export const VALID_USER_STATUSES = ['Active', 'Inactive', 'Suspended'] as const;

/**
 * Create user schema (admin creating a new user).
 * Maps to POST /users endpoint.
 */
export const CreateUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().min(1, 'Email is required').max(255).email('Invalid email format'),
  role: z.string().min(1, 'Role is required').max(50),
  department: z.string().min(1).max(100).optional().nullable(),
  job_title_id: z.string().min(1).max(100).optional().nullable(),
  unit: z.string().min(1).max(100).optional().nullable(),
  reporting_manager_id: z.string().min(1).max(100).optional().nullable(),
  access_scope: z.string().min(1).max(50).optional().nullable(),
  phone_number: z.string().min(1).max(20).optional().nullable(),
  notes: z.string().min(1).max(1000).optional().nullable(),
  status: z.enum(VALID_USER_STATUSES).optional(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

/**
 * Update user schema (admin updating an existing user).
 * Maps to PUT /users/:id endpoint.
 * Username and password are optional on update.
 */
export const UpdateUserSchema = z.object({
  username: z.string().min(3).max(50).optional(),
  password: z.string().min(6).max(100).optional(),
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().min(1, 'Email is required').max(255).email('Invalid email format'),
  role: z.string().min(1, 'Role is required').max(50),
  department: z.string().min(1).max(100).optional().nullable(),
  job_title_id: z.string().min(1).max(100).optional().nullable(),
  unit: z.string().min(1).max(100).optional().nullable(),
  reporting_manager_id: z.string().min(1).max(100).optional().nullable(),
  access_scope: z.string().min(1).max(50).optional().nullable(),
  phone_number: z.string().min(1).max(20).optional().nullable(),
  notes: z.string().min(1).max(1000).optional().nullable(),
  status: z.enum(VALID_USER_STATUSES).optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/**
 * Admin reset password schema.
 * Maps to POST /users/:id/reset-password endpoint.
 */
export const ResetUserPasswordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters').max(100),
});

export type ResetUserPasswordInput = z.infer<typeof ResetUserPasswordSchema>;

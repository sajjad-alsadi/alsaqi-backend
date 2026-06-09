/**
 * Authentication validation schemas.
 * Used by both API (request validation) and Frontend (form validation).
 */
import { z } from 'zod';

/**
 * Login request schema.
 * Accepts username or email + password.
 */
export const LoginSchema = z.object({
  usernameOrEmail: z.string().min(1, 'Username or email is required').max(100),
  password: z.string().min(1, 'Password is required').max(100),
  rememberMe: z.boolean().optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;

/**
 * Register (create user) request schema.
 * Used when an admin creates a new user account.
 */
export const RegisterSchema = z.object({
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
  status: z.enum(['Active', 'Inactive', 'Suspended']).optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;

/**
 * Change password schema (mandatory password change after reset).
 * Only requires the new password.
 */
export const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(100),
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

/**
 * Update password schema (voluntary password change).
 * Requires current password for verification.
 */
export const UpdatePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(100),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(100),
});

export type UpdatePasswordInput = z.infer<typeof UpdatePasswordSchema>;

/**
 * Forgot password request schema.
 */
export const ForgotPasswordSchema = z.object({
  username: z.string().min(1, 'Username is required').max(50),
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

/**
 * Approve password reset schema (admin action).
 */
export const ApproveResetSchema = z.object({
  requestId: z.string().min(1, 'Request ID is required').max(100),
});

export type ApproveResetInput = z.infer<typeof ApproveResetSchema>;

/**
 * @alsaqi/shared - Validation schemas
 * Re-exports all Zod validation schemas used across both API and Frontend.
 */

// Auth schemas
export {
  LoginSchema,
  RegisterSchema,
  ChangePasswordSchema,
  UpdatePasswordSchema,
  ForgotPasswordSchema,
  ApproveResetSchema,
  type LoginInput,
  type RegisterInput,
  type ChangePasswordInput,
  type UpdatePasswordInput,
  type ForgotPasswordInput,
  type ApproveResetInput,
} from './auth';

// Findings schemas
export {
  CreateFindingSchema,
  UpdateFindingSchema,
  ChangeFindingStatusSchema,
  VALID_FINDING_TYPES,
  type CreateFindingInput,
  type UpdateFindingInput,
  type ChangeFindingStatusInput,
} from './findings';

// Audit plans schemas
export {
  CreateAuditPlanSchema,
  UpdateAuditPlanSchema,
  VALID_QUARTERS,
  VALID_PLAN_STATUSES,
  type CreateAuditPlanInput,
  type UpdateAuditPlanInput,
} from './audit-plans';

// Tasks schemas
export {
  CreateTaskSchema,
  UpdateTaskSchema,
  ChangeTaskStatusSchema,
  AssignTaskUsersSchema,
  VALID_TASK_STATUSES,
  VALID_AUDIT_TYPES,
  type CreateTaskInput,
  type UpdateTaskInput,
  type ChangeTaskStatusInput,
  type AssignTaskUsersInput,
} from './tasks';

// Users schemas
export {
  CreateUserSchema,
  UpdateUserSchema,
  ResetUserPasswordSchema,
  VALID_USER_STATUSES,
  type CreateUserInput,
  type UpdateUserInput,
  type ResetUserPasswordInput,
} from './users';

// Correspondence schemas
export {
  CreateIncomingCorrespondenceSchema,
  UpdateIncomingCorrespondenceSchema,
  CreateOutgoingCorrespondenceSchema,
  UpdateOutgoingCorrespondenceSchema,
  ReferCorrespondenceSchema,
  LinkCorrespondenceSchema,
  CorrespondenceStatusUpdateSchema,
  type CreateIncomingCorrespondenceInput,
  type UpdateIncomingCorrespondenceInput,
  type CreateOutgoingCorrespondenceInput,
  type UpdateOutgoingCorrespondenceInput,
  type ReferCorrespondenceInput,
  type LinkCorrespondenceInput,
  type CorrespondenceStatusUpdateInput,
} from './correspondence';

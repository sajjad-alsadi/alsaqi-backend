/**
 * Shared data model types extracted from the ALSAQI application.
 * These types are the single source of truth used by both API and Frontend.
 */
import type {
  UserRole,
  AuditType,
  RiskLevel,
  ControlTestType,
  CorrespondencePriority,
  CorrespondenceClassification,
  CorrespondenceStatus,
  CorrespondenceType,
  SendingMethod,
  EntityType,
} from './enums';

// ─── User ─────────────────────────────────────────────────────────────────────

export interface User {
  id?: number | string;
  username: string;
  password?: string;
  name: string;
  email: string;
  department: string;
  job_title?: string;
  role: `${UserRole}`;
  profile_picture?: string;
  status: 'Active' | 'Disabled';
  last_login?: string;
  theme?: 'light' | 'dark';
  permissions?: Array<{ module: string; action: string }>;
}

// ─── Audit Plan ───────────────────────────────────────────────────────────────

export interface AuditPlan {
  id?: string;
  plan_code?: string;
  title: string;
  department: string;
  type: `${AuditType}`;
  risk_rating: 'Low' | 'Medium' | 'High' | 'Critical';
  planned_start_date: string;
  planned_end_date: string;
  actual_start_date?: string;
  actual_end_date?: string;
  status: 'Planned' | 'Fieldwork' | 'Reporting' | 'Closed';
  lead_auditor: string;
  notes?: string;
}

// ─── Audit Task ───────────────────────────────────────────────────────────────

export interface AuditTask {
  id?: number | string;
  task_number: string;
  title: string;
  plan_id: string;
  program_id?: string;
  audit_type: string;
  status: 'draft' | 'in_progress' | 'review' | 'approved' | 'completed';
  assigned_to?: string;
  audited_unit_id?: string;
  planned_hours?: number;
  actual_hours?: number;
  period_from?: string;
  period_to?: string;
  due_date?: string;
  approved_by?: string;
  approved_at?: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string;
  // Legacy props for backward compatibility
  audit_id?: number | string;
  procedure?: string;
  responsible?: string;
  evidence_link?: string;
  evidence_id?: number;
}

// ─── Audit Program ────────────────────────────────────────────────────────────

export interface AuditProgram {
  id?: number;
  program_code: string;
  program_title: string;
  audit_area: string;
  department: string;
  audit_type: `${AuditType}`;
  audit_objective: string;
  audit_scope: string;
  key_risks: string;
  control_objectives: string;
  reference_standard: string;
  status: 'Active' | 'Archived' | 'Draft' | 'Submitted' | 'Approved';
  version_number: number;
  created_by: string;
  created_at?: string;
  updated_at?: string;
}

// ─── Audit Procedure ──────────────────────────────────────────────────────────

export interface AuditProcedure {
  id?: number;
  program_id: number;
  procedure_number: string;
  audit_step: string;
  audit_test_description: string;
  risk_addressed: string;
  control_test_type: `${ControlTestType}`;
  expected_evidence: string;
  sampling_method: string;
  responsible_auditor: string;
  remarks?: string;
}

// ─── Audit Finding ────────────────────────────────────────────────────────────

export interface AuditFinding {
  id?: number | string;
  audit_id: number | string;
  finding_number?: string;
  plan_code?: string;
  condition: string;
  criteria: string;
  cause: string;
  consequence: string;
  recommendation: string;
  risk_level: 'Low' | 'Medium' | 'High';
  status: 'Open' | 'In Progress' | 'Closed';
}

// ─── Audit Evidence ───────────────────────────────────────────────────────────

export interface AuditEvidence {
  id?: number | string;
  audit_id: number | string;
  finding_id: number | string;
  type: 'Document' | 'Email' | 'Screenshot' | 'System Log' | 'Contract';
  description: string;
  uploaded_by: string;
  upload_date: string;
  file_name: string;
  file_data?: string;
}

// ─── Recommendation ───────────────────────────────────────────────────────────

export interface Recommendation {
  id?: number;
  finding_id: number;
  department: string;
  responsible: string;
  due_date: string;
  status: 'Open' | 'In Progress' | 'Implemented' | 'Overdue';
  risk_level: 'Low' | 'Medium' | 'High';
}

// ─── Risk Item ────────────────────────────────────────────────────────────────

export interface RiskItem {
  id?: string;
  risk_id: string;
  description: string;
  owner: string;
  source: string;
  early_warning: string;
  type: string;
  likelihood: string;
  impact: string;
  score: number;
  rating: string;
  controls: string;
  control_assessment: string;
  mitigation: string;
  treatment_option: string;
  residual_likelihood: string;
  residual_impact: string;
  residual_score: number;
  residual_rating: string;
  status: string;
  target_date: string;
  review_date: string;
  notes: string;
  entry_date: string;
  entered_by: string;
}

// ─── Department ───────────────────────────────────────────────────────────────

export interface Department {
  id: string;
  name: string;
  name_ar: string;
  name_en: string | null;
  entity_code: string;
  entity_type: string;
  parent_id: string | null;
  manager_name: string | null;
  level: number;
  status: string;
  display_order: number;
  description?: string;
  location?: string;
  cost_center_code?: string;
  children?: Department[];
}

// ─── Notification ─────────────────────────────────────────────────────────────

export interface Notification {
  id?: string | number;
  recipient_row_id?: string;
  user_id?: number;
  event_type: string;
  title?: string | null;
  description: string;
  related_module: string;
  date: string;
  status?: 'Read' | 'Unread';
  is_read?: boolean;
  read_at?: string | null;
  link?: string;
  actor_id?: string;
  entity_id?: string;
  entity_type?: string;
  data?: Record<string, unknown>;
}

// ─── Correspondence ───────────────────────────────────────────────────────────

export interface Correspondence {
  id: string;
  type: `${CorrespondenceType}`;
  letter_number: string;
  subject: string;
  letter_date: string;
  classification: `${CorrespondenceClassification}`;
  priority: `${CorrespondencePriority}`;
  status: `${CorrespondenceStatus}`;
  notes: string | null;
  created_at: string;
  // Incoming-specific fields
  sender_entity?: string;
  sender_entity_type?: `${EntityType}`;
  receipt_date?: string;
  method?: `${SendingMethod}`;
  receiving_dept_id?: string | null;
  assigned_dept_id?: string | null;
  assigned_user_id?: string | null;
  follow_up_required?: boolean;
  follow_up_date?: string | null;
  response_required?: boolean;
  response_due_date?: string | null;
  // Outgoing-specific fields
  recipient_entity?: string;
  sending_method?: `${SendingMethod}`;
  attachment_file?: string | null;
}

// ─── Audit Trail ──────────────────────────────────────────────────────────────

export interface AuditTrail {
  id: number;
  user: string;
  action: string;
  module: string;
  timestamp: string;
  details: string;
}

// ─── Org Position ─────────────────────────────────────────────────────────────

export interface OrgPosition {
  id: number;
  title: string;
  department: string;
  unit?: string;
  employee_name: string;
  reporting_to?: number;
  role_description: string;
  access_level: 'High' | 'Medium' | 'Low';
  status: 'Active' | 'Archived';
}

// ─── Audit Report ─────────────────────────────────────────────────────────────

export interface AuditReport {
  id?: number | string;
  audit_id?: number | string;
  title: string;
  report_type?: string;
  generated_by: string;
  date_generated: string;
  status: 'Draft' | 'Final';
  content: string;
}

// ─── Central Bank Instruction ─────────────────────────────────────────────────

export interface CentralBankInstruction {
  id?: string;
  title: string;
  issue_date: string;
  reference_number: string;
  category: string;
  description: string;
  related_department: string;
  attachment?: string;
  status: string;
}

// ─── Law Bank Item ────────────────────────────────────────────────────────────

export interface LawBankItem {
  id?: number;
  title: string;
  type: string;
  authority: string;
  issue_date: string;
  description: string;
  related_risk_area: string;
  attachment?: string;
  keywords: string;
}

// ─── Fraud Case ───────────────────────────────────────────────────────────────

export interface FraudCase {
  id?: number;
  description: string;
  department: string;
  detection_method: string;
  status: string;
  notes?: string;
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

/** A single row in the audit progress-by-type breakdown. */
export interface AuditProgressByType {
  type: string;
  planned: number;
  completed: number;
}

/** A single risk-level bucket in the dashboard risk overview. */
export interface RiskLevelBreakdown {
  level: string;
  count: number;
}

/**
 * Aggregated dashboard statistics returned by `GET /v1/dashboard-stats`.
 */
export interface DashboardStats {
  audits: { total: number; completed: number; progress_by_type: AuditProgressByType[] };
  findings: { summary: { open: number; high_risk_open: number } };
  recommendations: { open: number; overdue: number };
  risks: { summary: { total: number; high: number }; byLevel?: RiskLevelBreakdown[] };
  correspondence: { incoming_total: number; outgoing_total: number; pending_responses: number };
  compliance: { total: number };
  activity: Array<Record<string, unknown>>;
}

// ─── User Management ────────────────────────────────────────────────────────────

export interface Role { id: string | number; name: string; description?: string; }
export interface Permission { id: string | number; module: string; action: string; }
export interface UserSession {
  id: string | number;
  user_id: string | number;
  ip_address?: string;
  user_agent?: string;
  created_at?: string;
  expires_at?: string;
}
export interface JobTitle { id: string | number; name: string; name_ar?: string; name_en?: string; }
export interface UserManagementSettings {
  failed_login_threshold?: number;
  inactive_account_threshold_days?: number;
  password_min_length?: number;
  password_require_uppercase?: number;
  password_require_lowercase?: number;
  password_require_numbers?: number;
  password_require_symbols?: number;
  password_expiry_days?: number;
  enforce_single_session?: number;
  session_timeout_minutes?: number;
}

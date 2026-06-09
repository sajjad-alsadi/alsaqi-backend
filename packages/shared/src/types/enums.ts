/**
 * Shared enum definitions for the ALSAQI application.
 * These enums are the single source of truth used by both API and Frontend.
 */

export enum UserRole {
  ADMIN = 'Admin',
  INTERNAL_AUDITOR = 'Internal Auditor',
  COMPLIANCE_OFFICER = 'Compliance Officer',
  RISK_OFFICER = 'Risk Officer',
  MANAGER = 'Manager',
  VIEWER = 'Viewer',
}

export enum AuditStatus {
  OPEN = 'Open',
  IN_PROGRESS = 'In Progress',
  COMPLETED = 'Completed',
  DELAYED = 'Delayed',
  DRAFT = 'Draft',
  CLOSED = 'Closed',
  FIELDWORK = 'Fieldwork',
  APPROVED = 'Approved',
  IMPLEMENTED = 'Implemented',
  OVERDUE = 'Overdue',
  PLANNED = 'Planned',
}

export enum RiskLevel {
  CRITICAL = 'Critical',
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low',
}

export enum AuditType {
  OPERATIONAL = 'Operational',
  FINANCIAL = 'Financial',
  COMPLIANCE = 'Compliance',
  IT = 'IT',
  AML = 'AML',
  GOVERNANCE = 'Governance',
}

export enum ControlTestType {
  WALKTHROUGH = 'Walkthrough',
  INSPECTION = 'Inspection',
  OBSERVATION = 'Observation',
  RECALCULATION = 'Recalculation',
  REPERFORMANCE = 'Reperformance',
  INQUIRY = 'Inquiry',
  ANALYTICAL_REVIEW = 'Analytical Review',
}

export enum Priority {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low',
}

export enum UserStatus {
  ACTIVE = 'Active',
  INACTIVE = 'Inactive',
  SUSPENDED = 'Suspended',
}

export enum CorrespondencePriority {
  NORMAL = 'Normal',
  URGENT = 'Urgent',
  VERY_URGENT = 'Very Urgent',
  CONFIDENTIAL = 'Confidential',
  RESTRICTED = 'Restricted',
}

export enum CorrespondenceClassification {
  GENERAL = 'General',
  AUDIT_RELATED = 'Audit Related',
  COMPLIANCE = 'Compliance',
  ADMINISTRATIVE = 'Administrative',
  FINANCIAL = 'Financial',
  HR_RELATED = 'HR Related',
}

export enum CorrespondenceStatus {
  RECEIVED = 'Received',
  REGISTERED = 'Registered',
  UNDER_REVIEW = 'Under Review',
  REFERRED = 'Referred',
  ACTION_TAKEN = 'Action Taken',
  CLOSED = 'Closed',
  ARCHIVED = 'Archived',
  CANCELLED = 'Cancelled',
}

export enum CorrespondenceType {
  INCOMING = 'Incoming',
  OUTGOING = 'Outgoing',
}

export enum SendingMethod {
  OFFICIAL_MAIL = 'Official Mail',
  HAND_DELIVERY = 'Hand Delivery',
  ELECTRONIC_SYSTEM = 'Electronic System',
  EMAIL = 'Email',
}

export enum EntityType {
  GOVERNMENT = 'Government',
  PRIVATE = 'Private',
  INTERNAL = 'Internal',
  REGULATORY = 'Regulatory',
}

export enum RecommendationStatus {
  OPEN = 'Open',
  IN_PROGRESS = 'In Progress',
  IMPLEMENTED = 'Implemented',
  OVERDUE = 'Overdue',
}

export enum RiskStatus {
  ACTIVE = 'Active',
  MITIGATED = 'Mitigated',
  CLOSED = 'Closed',
}

export enum ResetStatus {
  NONE = 'None',
  PENDING = 'Pending',
  APPROVED = 'Approved',
  REJECTED = 'Rejected',
}

export enum AccessScope {
  GLOBAL = 'Global',
  DEPARTMENT = 'Department',
  UNIT = 'Unit',
}

export enum Language {
  EN = 'en',
  AR = 'ar',
}

export enum NotificationType {
  INFO = 'info',
  SUCCESS = 'success',
  WARNING = 'warning',
  DANGER = 'danger',
}

export enum ModuleName {
  AUDIT = 'Audit',
  FINDING = 'Finding',
  RISK = 'Risk',
  RECOMMENDATION = 'Recommendation',
  CORRESPONDENCE = 'Correspondence',
  USER = 'User',
  SETTING = 'Setting',
}

export enum FindingStatus {
  OPEN = 'Open',
  IN_PROGRESS = 'In Progress',
  CLOSED = 'Closed',
}

export enum TaskStatus {
  DRAFT = 'draft',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  APPROVED = 'approved',
  COMPLETED = 'completed',
}

export enum AuditPlanStatus {
  PLANNED = 'Planned',
  FIELDWORK = 'Fieldwork',
  REPORTING = 'Reporting',
  CLOSED = 'Closed',
}

export enum AuditProgramStatus {
  ACTIVE = 'Active',
  ARCHIVED = 'Archived',
  DRAFT = 'Draft',
  SUBMITTED = 'Submitted',
  APPROVED = 'Approved',
}

export enum EvidenceType {
  DOCUMENT = 'Document',
  EMAIL = 'Email',
  SCREENSHOT = 'Screenshot',
  SYSTEM_LOG = 'System Log',
  CONTRACT = 'Contract',
}

export enum ReportStatus {
  DRAFT = 'Draft',
  FINAL = 'Final',
}

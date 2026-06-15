import { z } from 'zod';

/**
 * Schema-driven column whitelist for CRUD write operations (Requirement 4).
 *
 * This module is the single source of truth for which top-level keys a table
 * accepts on create/update operations. The whitelist for a table is derived
 * directly from the field names declared in that table's Zod write schema
 * (`schema.shape`), so there is no parallel list to keep in sync (Req 4.2).
 *
 * Any key not declared in the corresponding schema is treated as NOT whitelisted
 * and therefore must never be persisted (Req 4.1, 4.4). Restricted fields such as
 * `id`, `status`, `deleted_at`, ownership fields (`created_by`, `deleted_by`,
 * `approved_by`, ...), and `role` are intentionally omitted from these write
 * schemas so they can never be mass-assigned by a client unless a table
 * explicitly declares them as writable.
 *
 * All functions in this module are pure: they perform no I/O and do not mutate
 * their inputs.
 */

/**
 * A Zod object schema describing the writable fields of a table. Only the set of
 * declared field names is used to build the column whitelist; the field
 * validators are incidental to whitelist derivation.
 */
export type WriteSchema = z.ZodObject<z.ZodRawShape>;

// Reusable field primitives. Every field is optional because a write body may be
// a partial update; the whitelist cares only about which field *names* are
// permitted, not whether they are present.
const text = () => z.string().optional().nullable();
const num = () => z.number().optional().nullable();
const bool = () => z.boolean().optional().nullable();
const date = () => z.string().optional().nullable();

/**
 * Registry mapping each writable table name to its Zod write schema (Req 4.2).
 *
 * System-managed and generated columns (`id`, `created_at`, `updated_at`,
 * `deleted_at`, `deleted_by`, `archived_at`, `archived_by`, `approved_at`,
 * generated `*_calc` columns) and privilege/ownership fields are deliberately
 * excluded so they cannot be written through the generic CRUD path.
 */
export const TABLE_WRITE_SCHEMAS: Record<string, WriteSchema> = {
  audit_programs: z.object({
    program_code: text(),
    program_title: text(),
    audit_area: text(),
    department: text(),
    audit_type: text(),
    audit_objective: text(),
    audit_scope: text(),
    key_risks: text(),
    control_objectives: text(),
    reference_standard: text(),
    status: text(),
    version_number: num(),
  }),

  audit_plans: z.object({
    plan_code: text(),
    program_id: text(),
    title: text(),
    department: text(),
    type: text(),
    risk_rating: text(),
    planned_start_date: date(),
    planned_end_date: date(),
    status: text(),
    lead_auditor: text(),
    team_members: text(),
    objectives: text(),
    scope: text(),
    notes: text(),
    year: num(),
    quarter: text(),
    is_archived: bool(),
  }),

  audit_tasks: z.object({
    task_number: text(),
    title: text(),
    plan_id: text(),
    program_id: text(),
    task_type: text(),
    audit_type: text(),
    status: text(),
    assigned_to: text(),
    audited_unit_id: text(),
    planned_hours: num(),
    actual_hours: num(),
    period_from: date(),
    period_to: date(),
    due_date: date(),
  }),

  audit_findings: z.object({
    audit_id: text(),
    finding_number: text(),
    title: text(),
    finding_type: text(),
    description: text(),
    criteria: text(),
    condition: text(),
    cause: text(),
    consequence: text(),
    impact: text(),
    root_cause: text(),
    recommendation: text(),
    risk_level: text(),
    status: text(),
    responsible_unit_id: text(),
    risk_id: text(),
  }),

  recommendations: z.object({
    finding_id: text(),
    plan_id: text(),
    rec_number: text(),
    department: text(),
    responsible: text(),
    responsible_person_id: text(),
    action_plan: text(),
    due_date: date(),
    follow_up_date: date(),
    status: text(),
    risk_level: text(),
    priority: text(),
    closure_evidence_path: text(),
  }),

  risk_register: z.object({
    risk_id: text(),
    description: text(),
    owner: text(),
    source: text(),
    early_warning: text(),
    type: text(),
    likelihood: text(),
    impact: text(),
    score: num(),
    rating: text(),
    controls: text(),
    control_assessment: text(),
    mitigation: text(),
    treatment_option: text(),
    residual_likelihood: text(),
    residual_impact: text(),
    residual_score: num(),
    residual_rating: text(),
    status: text(),
    target_date: date(),
    review_date: date(),
    notes: text(),
    entry_date: date(),
    entered_by: text(),
    likelihood_num: num(),
    impact_num: num(),
  }),

  compliance_items: z.object({
    ref_number: text(),
    title: text(),
    source_type: text(),
    issuing_authority: text(),
    category: text(),
    issue_date: date(),
    effective_date: date(),
    review_date: date(),
    compliance_status: text(),
    maturity_score: num(),
    gap_notes: text(),
    responsible_person_id: text(),
    department_id: text(),
    description: text(),
    keywords: text(),
    version: text(),
    attachment_path: text(),
  }),

  central_bank_instructions: z.object({
    title: text(),
    issue_date: date(),
    reference_number: text(),
    category: text(),
    description: text(),
    related_department: text(),
    attachment: text(),
    status: text(),
    related_instruction_id: text(),
  }),

  law_bank: z.object({
    title: text(),
    type: text(),
    authority: text(),
    issue_date: date(),
    keywords: text(),
    bookmarked: bool(),
    file_url: text(),
  }),

  departments: z.object({
    name: text(),
    description: text(),
  }),
};

/**
 * Returns the column whitelist for a table as the exact set of field names
 * declared in that table's Zod write schema (Req 4.2).
 *
 * If the table has no registered write schema, an empty set is returned, which
 * causes every key to be treated as non-whitelisted (fail closed).
 *
 * @param tableName the target table name
 * @returns a Set of permitted top-level column names
 */
export function getColumnWhitelist(tableName: string): Set<string> {
  const schema = TABLE_WRITE_SCHEMAS[tableName];
  if (!schema) {
    return new Set<string>();
  }
  return new Set<string>(Object.keys(schema.shape));
}

/**
 * Result of a whitelist check over a write request body.
 */
export interface WhitelistResult {
  /** True when every top-level key in the body is permitted for the table. */
  ok: boolean;
  /** Top-level keys present in the body that are not in the column whitelist. */
  rejectedKeys: string[];
}

/**
 * Pure check over a request body's top-level keys against a table's column
 * whitelist (Req 4.1, 4.3, 4.4).
 *
 * The check is all-or-nothing: any top-level key not in the whitelist makes the
 * result not-ok and is reported in `rejectedKeys`, so the caller can reject the
 * entire request without persisting any value. Restricted fields such as
 * `status`, `deleted_at`, ownership fields, and `role` are rejected unless the
 * table's write schema explicitly declares them (Req 4.4).
 *
 * This function performs no I/O and does not mutate its arguments.
 *
 * @param tableName the target table name
 * @param body the write request body whose top-level keys are validated
 * @returns a {@link WhitelistResult} describing acceptance and any rejected keys
 */
export function checkWhitelist(
  tableName: string,
  body: Record<string, unknown>
): WhitelistResult {
  const whitelist = getColumnWhitelist(tableName);
  const rejectedKeys = Object.keys(body ?? {}).filter((key) => !whitelist.has(key));
  return {
    ok: rejectedKeys.length === 0,
    rejectedKeys,
  };
}

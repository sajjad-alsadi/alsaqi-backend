/**
 * TemplateTypeRegistry — Central registry for template type keys.
 * Solves the key mismatch between frontend (Arabic labels) and backend (English keys).
 *
 * NOTE: This is a minimal placeholder created by task 1.3 to satisfy the import
 * from types/pdf.ts. Task 1.1 will flesh out the full implementation with
 * resolveTemplateTypeKey, LEGACY_MAPPING, TEMPLATE_TYPES array, etc.
 */

export type TemplateTypeKey =
  | 'audit_report'
  | 'quarterly_report'
  | 'annual_report'
  | 'audit_plan'
  | 'audit_missions'
  | 'recommendations'
  | 'outgoing_letter'
  | 'general';

export interface TemplateTypeDefinition {
  key: TemplateTypeKey;
  i18nLabel: string;
  defaultTemplate?: string;
}

export const TEMPLATE_TYPES: TemplateTypeDefinition[] = [
  { key: 'audit_report', i18nLabel: 'pdfTemplates.auditReport' },
  { key: 'quarterly_report', i18nLabel: 'pdfTemplates.quarterlyReport' },
  { key: 'annual_report', i18nLabel: 'pdfTemplates.annualReport' },
  { key: 'audit_plan', i18nLabel: 'pdfTemplates.auditPlan' },
  { key: 'audit_missions', i18nLabel: 'pdfTemplates.auditMissions' },
  { key: 'recommendations', i18nLabel: 'pdfTemplates.recommendations' },
  { key: 'outgoing_letter', i18nLabel: 'pdfTemplates.outgoingLetter' },
  { key: 'general', i18nLabel: 'pdfTemplates.general' },
];

const VALID_KEYS = new Set<string>(TEMPLATE_TYPES.map((t) => t.key));

/**
 * Type guard: checks if a string is a valid TemplateTypeKey.
 */
export function isValidTemplateTypeKey(input: string): input is TemplateTypeKey {
  return VALID_KEYS.has(input);
}

/**
 * Legacy mapping from old camelCase keys and Arabic labels to TemplateTypeKey.
 */
const LEGACY_MAPPING: Record<string, TemplateTypeKey> = {
  // Arabic labels
  'تقرير التدقيق': 'audit_report',
  'التقرير الربعي': 'quarterly_report',
  'التقرير السنوي': 'annual_report',
  'خطة التدقيق': 'audit_plan',
  'مهام التدقيق': 'audit_missions',
  'التوصيات': 'recommendations',
  'خطاب صادر': 'outgoing_letter',
  'عام': 'general',
  // Legacy English camelCase keys
  'auditReport': 'audit_report',
  'quarterlyReport': 'quarterly_report',
  'complianceRequirements': 'audit_report',
  'activityAuditResults': 'audit_report',
  'eventParticipationSummary': 'general',
  'monthlyDepartmentReport': 'quarterly_report',
};

/**
 * Resolves any input string to a valid TemplateTypeKey.
 * Returns 'general' for unrecognized, empty, null, or undefined inputs.
 */
export function resolveTemplateTypeKey(input: string | null | undefined): TemplateTypeKey {
  if (!input) return 'general';

  // Already a valid key? Return as-is.
  if (isValidTemplateTypeKey(input)) return input;

  // Check legacy mapping (use hasOwn to avoid prototype property leaks)
  if (Object.hasOwn(LEGACY_MAPPING, input)) {
    return LEGACY_MAPPING[input];
  }

  return 'general';
}

/**
 * Property-based tests for resolveTemplateTypeKey.
 *
 * Property 2: resolveTemplateTypeKey always returns a valid key
 *   - For ANY arbitrary string input, the function always returns one of the 8 valid TemplateTypeKey values.
 *   - It never throws an exception for any input.
 *   - Recognized Arabic labels map to their correct key.
 *   - Legacy camelCase keys map to their correct key.
 *   - Empty string, null, undefined inputs return 'general'.
 *   - Any string that is already a valid TemplateTypeKey is returned unchanged (idempotency).
 *
 * **Validates: Requirements 3.2, 3.5, 3.7, 3.8**
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveTemplateTypeKey, type TemplateTypeKey } from './templateTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_KEYS: TemplateTypeKey[] = [
  'audit_report',
  'quarterly_report',
  'annual_report',
  'audit_plan',
  'audit_missions',
  'recommendations',
  'outgoing_letter',
  'general',
];

const VALID_KEYS_SET = new Set<string>(VALID_KEYS);

const ARABIC_LABEL_MAPPING: Record<string, TemplateTypeKey> = {
  'تقرير التدقيق': 'audit_report',
  'التقرير الربعي': 'quarterly_report',
  'التقرير السنوي': 'annual_report',
  'خطة التدقيق': 'audit_plan',
  'مهام التدقيق': 'audit_missions',
  'التوصيات': 'recommendations',
  'خطاب صادر': 'outgoing_letter',
  'عام': 'general',
};

const LEGACY_CAMELCASE_MAPPING: Record<string, TemplateTypeKey> = {
  'auditReport': 'audit_report',
  'quarterlyReport': 'quarterly_report',
  'complianceRequirements': 'audit_report',
  'activityAuditResults': 'audit_report',
  'eventParticipationSummary': 'general',
  'monthlyDepartmentReport': 'quarterly_report',
};

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Arbitrary that generates any string including unicode, empty, whitespace, etc. */
const arbAnyString = fc.string({ minLength: 0, maxLength: 500 });

/** Arbitrary that generates one of the valid TemplateTypeKey values */
const arbValidKey = fc.constantFrom(...VALID_KEYS);

/** Arbitrary that generates one of the recognized Arabic labels */
const arbArabicLabel = fc.constantFrom(...Object.keys(ARABIC_LABEL_MAPPING));

/** Arbitrary that generates one of the legacy camelCase keys */
const arbCamelCaseKey = fc.constantFrom(...Object.keys(LEGACY_CAMELCASE_MAPPING));

/** Arbitrary for null-like inputs */
const arbNullLike = fc.constantFrom(null, undefined, '');

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Property 2: resolveTemplateTypeKey always returns a valid key', () => {
  it('for ANY arbitrary string, always returns a value from the 8 valid TemplateTypeKey constants', () => {
    fc.assert(
      fc.property(arbAnyString, (input) => {
        const result = resolveTemplateTypeKey(input);
        expect(VALID_KEYS_SET.has(result)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  it('never throws an exception for any arbitrary string input', () => {
    fc.assert(
      fc.property(arbAnyString, (input) => {
        expect(() => resolveTemplateTypeKey(input)).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it('never throws for unicode, control characters, and very long strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme-composite', minLength: 0, maxLength: 200 }), (input) => {
        expect(() => resolveTemplateTypeKey(input)).not.toThrow();
        const result = resolveTemplateTypeKey(input);
        expect(VALID_KEYS_SET.has(result)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('recognized Arabic labels always map to their correct key', () => {
    fc.assert(
      fc.property(arbArabicLabel, (label) => {
        const result = resolveTemplateTypeKey(label);
        expect(result).toBe(ARABIC_LABEL_MAPPING[label]);
      }),
      { numRuns: 100 }
    );
  });

  it('legacy camelCase keys always map to their correct key', () => {
    fc.assert(
      fc.property(arbCamelCaseKey, (key) => {
        const result = resolveTemplateTypeKey(key);
        expect(result).toBe(LEGACY_CAMELCASE_MAPPING[key]);
      }),
      { numRuns: 100 }
    );
  });

  it('empty string, null, and undefined all return "general"', () => {
    fc.assert(
      fc.property(arbNullLike, (input) => {
        const result = resolveTemplateTypeKey(input as string | null | undefined);
        expect(result).toBe('general');
      }),
      { numRuns: 50 }
    );
  });

  it('any valid TemplateTypeKey is returned unchanged (idempotency)', () => {
    fc.assert(
      fc.property(arbValidKey, (key) => {
        const result = resolveTemplateTypeKey(key);
        expect(result).toBe(key);
      }),
      { numRuns: 100 }
    );
  });

  it('unrecognized strings always fall back to "general"', () => {
    // Generate strings that are NOT valid keys and NOT in any mapping
    const arbUnrecognized = arbAnyString.filter(
      (s) =>
        s.length > 0 &&
        !VALID_KEYS_SET.has(s) &&
        !(s in ARABIC_LABEL_MAPPING) &&
        !(s in LEGACY_CAMELCASE_MAPPING)
    );

    fc.assert(
      fc.property(arbUnrecognized, (input) => {
        const result = resolveTemplateTypeKey(input);
        expect(result).toBe('general');
      }),
      { numRuns: 200 }
    );
  });
});

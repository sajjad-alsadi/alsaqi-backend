// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_TYPES,
  isValidTemplateTypeKey,
  resolveTemplateTypeKey,
  type TemplateTypeKey,
  type TemplateTypeDefinition,
} from './templateTypes';

describe('TemplateTypeRegistry', () => {
  describe('TEMPLATE_TYPES constant', () => {
    it('contains exactly 8 template type definitions', () => {
      expect(TEMPLATE_TYPES).toHaveLength(8);
    });

    it('contains all required keys', () => {
      const keys = TEMPLATE_TYPES.map((t) => t.key);
      expect(keys).toContain('audit_report');
      expect(keys).toContain('quarterly_report');
      expect(keys).toContain('annual_report');
      expect(keys).toContain('audit_plan');
      expect(keys).toContain('audit_missions');
      expect(keys).toContain('recommendations');
      expect(keys).toContain('outgoing_letter');
      expect(keys).toContain('general');
    });

    it('each definition has a key and i18nLabel', () => {
      for (const def of TEMPLATE_TYPES) {
        expect(def.key).toBeDefined();
        expect(typeof def.key).toBe('string');
        expect(def.i18nLabel).toBeDefined();
        expect(typeof def.i18nLabel).toBe('string');
        expect(def.i18nLabel).toMatch(/^pdfTemplates\./);
      }
    });
  });

  describe('isValidTemplateTypeKey', () => {
    it('returns true for all valid keys', () => {
      const validKeys: TemplateTypeKey[] = [
        'audit_report',
        'quarterly_report',
        'annual_report',
        'audit_plan',
        'audit_missions',
        'recommendations',
        'outgoing_letter',
        'general',
      ];
      for (const key of validKeys) {
        expect(isValidTemplateTypeKey(key)).toBe(true);
      }
    });

    it('returns false for invalid strings', () => {
      expect(isValidTemplateTypeKey('invalid')).toBe(false);
      expect(isValidTemplateTypeKey('auditReport')).toBe(false);
      expect(isValidTemplateTypeKey('تقرير التدقيق')).toBe(false);
      expect(isValidTemplateTypeKey('')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(isValidTemplateTypeKey(null)).toBe(false);
      expect(isValidTemplateTypeKey(undefined)).toBe(false);
      expect(isValidTemplateTypeKey(123)).toBe(false);
      expect(isValidTemplateTypeKey({})).toBe(false);
    });
  });

  describe('resolveTemplateTypeKey', () => {
    it('returns input unchanged if already a valid TemplateTypeKey', () => {
      expect(resolveTemplateTypeKey('audit_report')).toBe('audit_report');
      expect(resolveTemplateTypeKey('quarterly_report')).toBe('quarterly_report');
      expect(resolveTemplateTypeKey('general')).toBe('general');
    });

    it('maps Arabic labels correctly', () => {
      expect(resolveTemplateTypeKey('تقرير التدقيق')).toBe('audit_report');
      expect(resolveTemplateTypeKey('التقرير الربعي')).toBe('quarterly_report');
      expect(resolveTemplateTypeKey('التقرير السنوي')).toBe('annual_report');
      expect(resolveTemplateTypeKey('خطة التدقيق')).toBe('audit_plan');
      expect(resolveTemplateTypeKey('مهام التدقيق')).toBe('audit_missions');
      expect(resolveTemplateTypeKey('التوصيات')).toBe('recommendations');
      expect(resolveTemplateTypeKey('خطاب صادر')).toBe('outgoing_letter');
      expect(resolveTemplateTypeKey('عام')).toBe('general');
    });

    it('maps English camelCase keys correctly', () => {
      expect(resolveTemplateTypeKey('auditReport')).toBe('audit_report');
      expect(resolveTemplateTypeKey('quarterlyReport')).toBe('quarterly_report');
      expect(resolveTemplateTypeKey('complianceRequirements')).toBe('audit_report');
      expect(resolveTemplateTypeKey('activityAuditResults')).toBe('audit_report');
      expect(resolveTemplateTypeKey('eventParticipationSummary')).toBe('general');
      expect(resolveTemplateTypeKey('monthlyDepartmentReport')).toBe('quarterly_report');
    });

    it('returns "general" for unrecognized input', () => {
      expect(resolveTemplateTypeKey('unknownType')).toBe('general');
      expect(resolveTemplateTypeKey('something_random')).toBe('general');
      expect(resolveTemplateTypeKey('12345')).toBe('general');
    });

    it('returns "general" for null, undefined, and empty string', () => {
      expect(resolveTemplateTypeKey(null)).toBe('general');
      expect(resolveTemplateTypeKey(undefined)).toBe('general');
      expect(resolveTemplateTypeKey('')).toBe('general');
      expect(resolveTemplateTypeKey('   ')).toBe('general');
    });

    it('never throws an exception for any input', () => {
      const edgeCases = [null, undefined, '', '   ', 'x'.repeat(10000), '💻🔥', '\n\t\r'];
      for (const input of edgeCases) {
        expect(() => resolveTemplateTypeKey(input as any)).not.toThrow();
      }
    });
  });
});

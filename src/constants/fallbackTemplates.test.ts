// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { FALLBACK_TEMPLATES, buildFallbackHtml } from './fallbackTemplates';
import type { TemplateTypeKey } from './templateTypes';

const ALL_KEYS: TemplateTypeKey[] = [
  'audit_report',
  'quarterly_report',
  'annual_report',
  'audit_plan',
  'audit_missions',
  'recommendations',
  'outgoing_letter',
  'general',
];

const SAMPLE_DATA = {
  auditTitle: 'تقرير تدقيق الأداء',
  auditDate: '2024-03-15',
  auditorName: 'أحمد محمد',
  departmentName: 'إدارة التدقيق الداخلي',
  scope: 'نطاق التدقيق يشمل جميع العمليات',
  objectives: 'تقييم كفاءة العمليات',
  planCode: 'AP-2024-001',
  status: 'Active',
  findings: [
    { title: 'ملاحظة أولى', description: 'وصف الملاحظة', risk_level: 'عالي', status: 'مفتوح' },
    { title: 'ملاحظة ثانية', description: 'وصف آخر', risk_level: 'متوسط', status: 'مغلق' },
  ],
  recommendations: [
    { action_plan: 'تحسين العمليات', responsible: 'مدير القسم', due_date: '2024-06-01', status: 'قيد التنفيذ' },
  ],
  evidence: [
    { type: 'document', description: 'وثيقة مرفقة', file_name: 'evidence.pdf' },
  ],
};

describe('FALLBACK_TEMPLATES', () => {
  it('contains exactly 8 templates (one per TemplateTypeKey)', () => {
    expect(Object.keys(FALLBACK_TEMPLATES)).toHaveLength(8);
  });

  it('has a template for every TemplateTypeKey', () => {
    for (const key of ALL_KEYS) {
      expect(FALLBACK_TEMPLATES[key]).toBeDefined();
      expect(typeof FALLBACK_TEMPLATES[key]).toBe('string');
      expect(FALLBACK_TEMPLATES[key].length).toBeGreaterThan(0);
    }
  });

  it('all templates contain RTL/LTR direction handling', () => {
    for (const key of ALL_KEYS) {
      expect(FALLBACK_TEMPLATES[key]).toContain('{{#if isRtl}}rtl{{else}}ltr{{/if}}');
    }
  });
});

describe('buildFallbackHtml', () => {
  it('compiles all 8 templates without throwing', () => {
    for (const key of ALL_KEYS) {
      expect(() => buildFallbackHtml(SAMPLE_DATA, 'ar', key)).not.toThrow();
      expect(() => buildFallbackHtml(SAMPLE_DATA, 'en', key)).not.toThrow();
    }
  });

  it('returns dir="rtl" for Arabic', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'ar', 'audit_report');
    expect(html).toContain('dir="rtl"');
    expect(html).not.toContain('dir="ltr"');
  });

  it('returns dir="ltr" for English', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'en', 'audit_report');
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('dir="rtl"');
  });

  it('includes auditTitle in the output', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'ar', 'audit_report');
    expect(html).toContain('تقرير تدقيق الأداء');
  });

  it('renders findings table rows', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'ar', 'audit_report');
    expect(html).toContain('ملاحظة أولى');
    expect(html).toContain('ملاحظة ثانية');
    expect(html).toContain('عالي');
    expect(html).toContain('متوسط');
  });

  it('renders recommendations when present', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'ar', 'recommendations');
    expect(html).toContain('تحسين العمليات');
    expect(html).toContain('مدير القسم');
  });

  it('defaults to general template when no key is provided', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'ar');
    expect(html).toContain('تقرير تدقيق الأداء');
  });

  it('handles empty findings gracefully', () => {
    const data = { ...SAMPLE_DATA, findings: [] };
    const html = buildFallbackHtml(data, 'ar', 'audit_report');
    expect(html).toContain('لا توجد نتائج');
  });

  it('handles empty data without throwing', () => {
    const minimalData = {
      auditTitle: '',
      auditDate: '',
      auditorName: '',
      departmentName: '',
      findings: [],
    };
    for (const key of ALL_KEYS) {
      expect(() => buildFallbackHtml(minimalData, 'en', key)).not.toThrow();
    }
  });

  it('renders outgoing_letter with proper letter structure', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'en', 'outgoing_letter');
    expect(html).toContain('Date');
    expect(html).toContain('From');
    expect(html).toContain('Regards');
    expect(html).toContain('أحمد محمد');
  });

  it('renders audit_plan with planCode', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'en', 'audit_plan');
    expect(html).toContain('AP-2024-001');
    expect(html).toContain('Plan Code');
  });

  it('renders audit_missions with evidence', () => {
    const html = buildFallbackHtml(SAMPLE_DATA, 'en', 'audit_missions');
    expect(html).toContain('وثيقة مرفقة');
    expect(html).toContain('evidence.pdf');
  });
});

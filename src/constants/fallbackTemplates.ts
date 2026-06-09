/**
 * Fallback Templates — Built-in HTML templates for each TemplateTypeKey.
 * Used when no stored template exists for a given type (or when a stored
 * template has invalid Handlebars syntax).
 *
 * Each template supports RTL via the `isRtl` flag injected by buildFallbackHtml.
 */
import Handlebars from 'handlebars';
import type { TemplateTypeKey } from './templateTypes.js';

/**
 * Record of fallback HTML (Handlebars) templates — one per TemplateTypeKey.
 */
export const FALLBACK_TEMPLATES: Record<TemplateTypeKey, string> = {
  audit_report: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if scope}}
  <h3>{{#if isRtl}}النطاق{{else}}Scope{{/if}}</h3>
  <p>{{scope}}</p>
  {{/if}}

  {{#if objectives}}
  <h3>{{#if isRtl}}الأهداف{{else}}Objectives{{/if}}</h3>
  <p>{{objectives}}</p>
  {{/if}}

  <h3>{{#if isRtl}}النتائج{{else}}Findings{{/if}}</h3>
  {{#if findings.length}}
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}العنوان{{else}}Title{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}مستوى المخاطر{{else}}Risk Level{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{risk_level}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد نتائج{{else}}No findings{{/if}}</p>
  {{/if}}

  {{#if recommendations.length}}
  <h3>{{#if isRtl}}التوصيات{{else}}Recommendations{{/if}}</h3>
  <table style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}خطة العمل{{else}}Action Plan{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المسؤول{{else}}Responsible{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}تاريخ الاستحقاق{{else}}Due Date{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each recommendations}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{action_plan}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{responsible}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{due_date}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{/if}}
</div>`,

  quarterly_report: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if scope}}
  <h3>{{#if isRtl}}نطاق الفترة{{else}}Period Scope{{/if}}</h3>
  <p>{{scope}}</p>
  {{/if}}

  <h3>{{#if isRtl}}مؤشرات الأداء الرئيسية{{else}}Key Performance Indicators{{/if}}</h3>
  {{#if findings.length}}
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المؤشر{{else}}Indicator{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المستوى{{else}}Level{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{risk_level}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد بيانات{{else}}No data available{{/if}}</p>
  {{/if}}

  {{#if recommendations.length}}
  <h3>{{#if isRtl}}التوصيات{{else}}Recommendations{{/if}}</h3>
  <ul>
    {{#each recommendations}}
    <li>{{action_plan}}{{#if responsible}} — {{responsible}}{{/if}}{{#if due_date}} ({{due_date}}){{/if}}</li>
    {{/each}}
  </ul>
  {{/if}}
</div>`,

  annual_report: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if scope}}
  <h3>{{#if isRtl}}الملخص السنوي{{else}}Annual Summary{{/if}}</h3>
  <p>{{scope}}</p>
  {{/if}}

  {{#if objectives}}
  <h3>{{#if isRtl}}الأهداف المحققة{{else}}Achieved Objectives{{/if}}</h3>
  <p>{{objectives}}</p>
  {{/if}}

  <h3>{{#if isRtl}}النتائج الرئيسية{{else}}Key Findings{{/if}}</h3>
  {{#if findings.length}}
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}العنوان{{else}}Title{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}مستوى المخاطر{{else}}Risk Level{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{risk_level}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد نتائج{{else}}No findings{{/if}}</p>
  {{/if}}

  {{#if recommendations.length}}
  <h3>{{#if isRtl}}التوصيات والخطط المستقبلية{{else}}Recommendations & Future Plans{{/if}}</h3>
  <table style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}خطة العمل{{else}}Action Plan{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المسؤول{{else}}Responsible{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}تاريخ الاستحقاق{{else}}Due Date{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each recommendations}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{action_plan}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{responsible}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{due_date}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{/if}}
</div>`,

  audit_plan: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if planCode}}
  <p><strong>{{#if isRtl}}رمز الخطة{{else}}Plan Code{{/if}}:</strong> {{planCode}}</p>
  {{/if}}

  {{#if status}}
  <p><strong>{{#if isRtl}}الحالة{{else}}Status{{/if}}:</strong> {{status}}</p>
  {{/if}}

  {{#if objectives}}
  <h3>{{#if isRtl}}أهداف التدقيق{{else}}Audit Objectives{{/if}}</h3>
  <p>{{objectives}}</p>
  {{/if}}

  {{#if scope}}
  <h3>{{#if isRtl}}نطاق التدقيق{{else}}Audit Scope{{/if}}</h3>
  <p>{{scope}}</p>
  {{/if}}

  <h3>{{#if isRtl}}مهام الخطة{{else}}Plan Tasks{{/if}}</h3>
  {{#if findings.length}}
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المهمة{{else}}Task{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الأولوية{{else}}Priority{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{risk_level}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد مهام{{else}}No tasks defined{{/if}}</p>
  {{/if}}
</div>`,

  audit_missions: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if scope}}
  <h3>{{#if isRtl}}نطاق المهام{{else}}Mission Scope{{/if}}</h3>
  <p>{{scope}}</p>
  {{/if}}

  <h3>{{#if isRtl}}المهام{{else}}Missions{{/if}}</h3>
  {{#if findings.length}}
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المهمة{{else}}Mission{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المستوى{{else}}Level{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{risk_level}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد مهام{{else}}No missions{{/if}}</p>
  {{/if}}

  {{#if evidence}}
  <h3>{{#if isRtl}}الأدلة{{else}}Evidence{{/if}}</h3>
  <ul>
    {{#each evidence}}
    <li>{{description}}{{#if file_name}} ({{file_name}}){{/if}}</li>
    {{/each}}
  </ul>
  {{/if}}
</div>`,

  recommendations: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if recommendations.length}}
  <h3>{{#if isRtl}}التوصيات{{else}}Recommendations{{/if}}</h3>
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}خطة العمل{{else}}Action Plan{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}المسؤول{{else}}Responsible{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}تاريخ الاستحقاق{{else}}Due Date{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each recommendations}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{action_plan}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{responsible}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{due_date}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا توجد توصيات{{else}}No recommendations{{/if}}</p>
  {{/if}}

  {{#if findings.length}}
  <h3>{{#if isRtl}}النتائج المرتبطة{{else}}Related Findings{{/if}}</h3>
  <ul>
    {{#each findings}}
    <li><strong>{{title}}</strong>{{#if description}} — {{description}}{{/if}}</li>
    {{/each}}
  </ul>
  {{/if}}
</div>`,

  outgoing_letter: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <div style="text-align: {{#if isRtl}}right{{else}}left{{/if}}; margin-bottom: 32px;">
    <p style="margin: 4px 0;"><strong>{{#if isRtl}}التاريخ{{else}}Date{{/if}}:</strong> {{auditDate}}</p>
    <p style="margin: 4px 0;"><strong>{{#if isRtl}}من{{else}}From{{/if}}:</strong> {{auditorName}}</p>
    <p style="margin: 4px 0;"><strong>{{#if isRtl}}الإدارة{{else}}Department{{/if}}:</strong> {{departmentName}}</p>
  </div>

  <h2 style="text-align: center; margin-bottom: 24px;">{{auditTitle}}</h2>

  {{#if scope}}
  <p style="margin-bottom: 16px;">{{scope}}</p>
  {{/if}}

  {{#if findings.length}}
  <h3>{{#if isRtl}}التفاصيل{{else}}Details{{/if}}</h3>
  <ul>
    {{#each findings}}
    <li>{{title}}{{#if description}} — {{description}}{{/if}}</li>
    {{/each}}
  </ul>
  {{/if}}

  {{#if recommendations.length}}
  <h3>{{#if isRtl}}الإجراءات المطلوبة{{else}}Required Actions{{/if}}</h3>
  <ul>
    {{#each recommendations}}
    <li>{{action_plan}}{{#if due_date}} ({{#if ../isRtl}}بحلول{{else}}by{{/if}} {{due_date}}){{/if}}</li>
    {{/each}}
  </ul>
  {{/if}}

  <div style="margin-top: 48px; text-align: {{#if isRtl}}left{{else}}right{{/if}};">
    <p>{{#if isRtl}}مع التحية{{else}}Regards{{/if}},</p>
    <p><strong>{{auditorName}}</strong></p>
    <p>{{departmentName}}</p>
  </div>
</div>`,

  general: `<div dir="{{#if isRtl}}rtl{{else}}ltr{{/if}}" style="font-family: Tahoma, sans-serif; padding: 20px;">
  <h1 style="text-align: center; margin-bottom: 8px;">{{auditTitle}}</h1>
  <p style="text-align: center; color: #555; margin-bottom: 24px;">{{auditDate}} | {{auditorName}} | {{departmentName}}</p>

  {{#if scope}}
  <p>{{scope}}</p>
  {{/if}}

  {{#if objectives}}
  <h3>{{#if isRtl}}الأهداف{{else}}Objectives{{/if}}</h3>
  <p>{{objectives}}</p>
  {{/if}}

  {{#if findings.length}}
  <h3>{{#if isRtl}}المحتوى{{else}}Content{{/if}}</h3>
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background: #f0f0f0;">
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}العنوان{{else}}Title{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الوصف{{else}}Description{{/if}}</th>
        <th style="border: 1px solid #ccc; padding: 8px;">{{#if isRtl}}الحالة{{else}}Status{{/if}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each findings}}
      <tr>
        <td style="border: 1px solid #ccc; padding: 8px;">{{title}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{description}}</td>
        <td style="border: 1px solid #ccc; padding: 8px;">{{status}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p>{{#if isRtl}}لا يوجد محتوى{{else}}No content{{/if}}</p>
  {{/if}}
</div>`,
};

/**
 * Builds fallback HTML by compiling the appropriate template with the given data.
 * Injects `isRtl: true` when language is Arabic for RTL support.
 *
 * @param data - Template data (audit fields, findings, recommendations, etc.)
 * @param language - 'ar' for Arabic (RTL) or 'en' for English (LTR)
 * @param templateTypeKey - Which fallback template to use (defaults to 'general')
 * @returns Compiled HTML string
 */
export function buildFallbackHtml(
  data: Record<string, unknown>,
  language: 'ar' | 'en',
  templateTypeKey: TemplateTypeKey = 'general'
): string {
  const fallbackHtml = FALLBACK_TEMPLATES[templateTypeKey];
  const compiled = Handlebars.compile(fallbackHtml);
  return compiled({ ...data, isRtl: language === 'ar' });
}

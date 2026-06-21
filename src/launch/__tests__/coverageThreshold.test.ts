// @vitest-environment node
// Feature: production-launch-readiness, Task 20.3
// اختبار وحدة (مبني على أمثلة) لمنطق تقييم عتبة التغطية (evaluateCoverageThreshold).
//
// يُغطّي:
//  - وسم وحدة بتغطية عبارات < 90% كفجوة، وعدم وسم وحدة ≥ 90% (16.4).
//  - إرجاع statementsPct لكل وحدة ضمن المجال [0..100].
//  - الفشل المُغلق (fail-closed):
//      * ملخّص null/غير قابل للتحليل ⇒ ok=false + errorCause 'report-missing'.
//      * وحدة مسار حرج بلا مدخل ⇒ ok=false + errorCause 'module-entry-missing'.
//      * قيمة pct غير صالحة ⇒ ok=false + errorCause 'module-metric-invalid'.
//  - ok===true فقط عند انعدام الفجوات والأخطاء.
//
// Requirements: 16.4
import { describe, it, expect } from 'vitest';
import {
  evaluateCoverageThreshold,
  type CoverageSummaryShape,
} from '../coverageThreshold.js';

/** عتبة الاختبار: 90% (الافتراضية الموثّقة في 16.4). */
const THRESHOLD = 90;

/** قائمة وحدات مسار حرج مُصغّرة للاختبار. */
const CRITICAL_MODULES = [
  'src/auth/login.ts',
  'src/audit/engine.ts',
] as const;

/**
 * ملخّص تغطية مُصغّر inline على شكل ما يُصدِره مبلّغ json-summary:
 * إحدى الوحدتين فوق العتبة والأخرى دونها لاختبار وسم الفجوة.
 */
function makeSummary(
  loginPct: number,
  enginePct: number,
): CoverageSummaryShape {
  return {
    total: { statements: { pct: (loginPct + enginePct) / 2 } },
    'src/auth/login.ts': { statements: { pct: loginPct } },
    'src/audit/engine.ts': { statements: { pct: enginePct } },
  };
}

describe('evaluateCoverageThreshold', () => {
  it('يَسِم وحدة < 90% كفجوة ولا يَسِم وحدة ≥ 90%', () => {
    // login = 95 (≥ 90، ليست فجوة)، engine = 80 (< 90، فجوة).
    const result = evaluateCoverageThreshold(
      makeSummary(95, 80),
      CRITICAL_MODULES,
      THRESHOLD,
    );

    const login = result.perModule.find((m) => m.module === 'src/auth/login.ts');
    const engine = result.perModule.find((m) => m.module === 'src/audit/engine.ts');

    expect(login?.isGap).toBe(false);
    expect(engine?.isGap).toBe(true);

    expect(result.gaps).toContain('src/audit/engine.ts');
    expect(result.gaps).not.toContain('src/auth/login.ts');

    // وجود فجوة ⇒ ok=false (بلا خطأ fail-closed).
    expect(result.ok).toBe(false);
    expect(result.errorCause).toBeUndefined();
  });

  it('يَسِم الوحدة عند العتبة تماماً (90%) كغير فجوة (مقارنة <)', () => {
    const result = evaluateCoverageThreshold(
      makeSummary(90, 90),
      CRITICAL_MODULES,
      THRESHOLD,
    );

    expect(result.gaps).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.perModule.every((m) => m.isGap === false)).toBe(true);
  });

  it('يُرجِع statementsPct لكل وحدة ضمن المجال [0..100]', () => {
    const result = evaluateCoverageThreshold(
      makeSummary(100, 0),
      CRITICAL_MODULES,
      THRESHOLD,
    );

    for (const m of result.perModule) {
      expect(m.statementsPct).not.toBeNull();
      expect(m.statementsPct as number).toBeGreaterThanOrEqual(0);
      expect(m.statementsPct as number).toBeLessThanOrEqual(100);
    }
  });

  it('ok===true فقط عند انعدام الفجوات والأخطاء', () => {
    const ok = evaluateCoverageThreshold(makeSummary(99, 91), CRITICAL_MODULES, THRESHOLD);
    expect(ok.ok).toBe(true);
    expect(ok.gaps).toEqual([]);
    expect(ok.error).toBeUndefined();
  });

  describe('الفشل المُغلق (fail-closed)', () => {
    it('ملخّص null ⇒ ok=false مع errorCause = report-missing', () => {
      const result = evaluateCoverageThreshold(null, CRITICAL_MODULES, THRESHOLD);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.errorCause).toBe('report-missing');
    });

    it('ملخّص undefined/غير كائن ⇒ ok=false مع errorCause = report-missing', () => {
      const result = evaluateCoverageThreshold(undefined, CRITICAL_MODULES, THRESHOLD);
      expect(result.ok).toBe(false);
      expect(result.errorCause).toBe('report-missing');
    });

    it('وحدة مسار حرج مفقودة من الملخّص ⇒ ok=false مع errorCause = module-entry-missing', () => {
      // ملخّص يحوي login فقط، بينما engine وحدة حرجة مفقودة.
      const summary: CoverageSummaryShape = {
        total: { statements: { pct: 95 } },
        'src/auth/login.ts': { statements: { pct: 95 } },
      };
      const result = evaluateCoverageThreshold(summary, CRITICAL_MODULES, THRESHOLD);

      expect(result.ok).toBe(false);
      expect(result.errorCause).toBe('module-entry-missing');
      // الوحدة المفقودة تُوسَم فجوة بقيمة null.
      const engine = result.perModule.find((m) => m.module === 'src/audit/engine.ts');
      expect(engine?.statementsPct).toBeNull();
      expect(engine?.isGap).toBe(true);
      expect(result.gaps).toContain('src/audit/engine.ts');
    });

    it('قيمة pct غير صالحة (خارج المجال) ⇒ ok=false مع errorCause = module-metric-invalid', () => {
      const summary: CoverageSummaryShape = {
        total: { statements: { pct: 95 } },
        'src/auth/login.ts': { statements: { pct: 95 } },
        // pct = 150 خارج المجال [0..100] ⇒ غير صالح.
        'src/audit/engine.ts': { statements: { pct: 150 } },
      };
      const result = evaluateCoverageThreshold(summary, CRITICAL_MODULES, THRESHOLD);

      expect(result.ok).toBe(false);
      expect(result.errorCause).toBe('module-metric-invalid');
      const engine = result.perModule.find((m) => m.module === 'src/audit/engine.ts');
      expect(engine?.statementsPct).toBeNull();
      expect(engine?.isGap).toBe(true);
    });

    it('مدخل وحدة بلا مقياس statements ⇒ معامَل كقيمة غير صالحة (module-metric-invalid)', () => {
      const summary: CoverageSummaryShape = {
        total: { statements: { pct: 95 } },
        'src/auth/login.ts': { statements: { pct: 95 } },
        'src/audit/engine.ts': {}, // لا statements.
      };
      const result = evaluateCoverageThreshold(summary, CRITICAL_MODULES, THRESHOLD);

      expect(result.ok).toBe(false);
      expect(result.errorCause).toBe('module-metric-invalid');
    });
  });
});

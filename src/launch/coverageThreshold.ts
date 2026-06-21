/**
 * فحص عتبة تغطية وحدات المسار الحرج (Coverage Threshold Check).
 *
 * يستهلك هذا الملف Coverage_Report المُنتَج من vitest (مُخرَج `json-summary`
 * عند `./coverage/coverage-summary.json`، انظر المهمة 20.1 و`vitest.config.ts`)
 * ويُقيّم تغطية العبارات (statement coverage) لكل وحدة من وحدات المسار الحرج
 * المُعرَّفة في `criticalPathModules.ts`.
 *
 * المنطق هنا **نقيّ (pure)** وقابل للاختبار وحدةً دون أثر جانبي:
 *  - `evaluateCoverageThreshold` يتلقّى بنية ملخّص التغطية ومجموعة الوحدات
 *    والعتبة، ويُرجِع نسبة تغطية العبارات [0..100] لكل وحدة ووسم الفجوات.
 *  - "الفشل المُغلق" (fail-closed): إذا كان التقرير مفقوداً أو غير قابل للتحليل،
 *    أو افتقدت وحدةٌ مدخلَها (إخفاق المُشغِّل أو تعذّر جمع التغطية)، يُرجَع مؤشّر
 *    خطأ يحدّد السبب و`ok=false` — ولا يُمرَّر الفحص بصمت.
 *
 * يُوفَّر أيضاً غلاف رقيق ذو أثر (`runCoverageThresholdCheck`) يقرأ ملف الملخّص
 * من القرص لاستعماله في خطوط CI، مع إبقاء منطق التحليل/العتبة نقيّاً.
 *
 * Reference: design.md "التغطية (16)"، requirements.md "Requirement 16"
 * Requirements: 16.3, 16.4, 16.5
 */

import { CRITICAL_PATH_MODULE_GLOBS } from './criticalPathModules.js';

/** العتبة الافتراضية لتغطية العبارات (٪) التي تُوسَم الوحدات دونها كفجوة (16.4). */
export const DEFAULT_COVERAGE_THRESHOLD_PCT = 90;

/**
 * بنية مدخل مقياس واحد ضمن ملخّص istanbul/v8 (`coverage-summary.json`).
 * يهمّنا منها `statements.pct` لتقييم عتبة تغطية العبارات.
 */
export interface CoverageMetricShape {
  pct: number;
}

/**
 * بنية مدخل ملف واحد ضمن ملخّص التغطية. الحقل المعتمَد عليه هو `statements`.
 */
export interface CoverageFileSummaryShape {
  statements?: CoverageMetricShape;
}

/**
 * بنية ملخّص التغطية القابلة للقراءة آلياً كما يُصدِرها مُبلّغ `json-summary`:
 * خريطة من مسار الملف (وكذلك مفتاح `total`) إلى مقاييسه.
 */
export interface CoverageSummaryShape {
  [filePath: string]: CoverageFileSummaryShape | undefined;
}

/** سبب إخفاق فحص العتبة (مجموعة مغلقة) — يُمكّن المُستهلك من التمييز برمجياً. */
export type CoverageThresholdErrorCause =
  | 'report-missing' // التقرير مفقود (لم يُنتَج / غير موجود على القرص).
  | 'report-unparseable' // التقرير موجود لكن تعذّر تحليله إلى بنية صالحة.
  | 'module-entry-missing' // وحدة مسار حرج بلا مدخل (إخفاق المُشغِّل أو تعذّر الجمع).
  | 'module-metric-invalid'; // مدخل الوحدة موجود لكن قيمة تغطية العبارات غير صالحة.

/** تقييم تغطية وحدة مسار حرج واحدة. */
export interface ModuleCoverageEvaluation {
  /** مسار الوحدة كما هو معرّف في مجموعة المسار الحرج. */
  module: string;
  /** نسبة تغطية العبارات [0..100]، أو `null` إذا تعذّر تحديدها (مدخل مفقود/غير صالح). */
  statementsPct: number | null;
  /** هل تُعدّ الوحدة فجوة تغطية (statementsPct < threshold أو غير قابلة للتحديد). */
  isGap: boolean;
}

/** ناتج تقييم عتبة التغطية للمجموعة كاملة. */
export interface CoverageThresholdResult {
  /** تقييم لكل وحدة مسار حرج بالترتيب المُدخَل. */
  perModule: ModuleCoverageEvaluation[];
  /** مسارات الوحدات المُوسَّمة كفجوات تغطية. */
  gaps: string[];
  /** نجاح الفحص: لا فجوات ولا أخطاء. */
  ok: boolean;
  /** مؤشّر الخطأ الوصفي عند الفشل المُغلق (مفقود/غير قابل للتحليل/مدخل ناقص). */
  error?: string;
  /** السبب المُصنَّف للخطأ، إن وُجد، للتمييز البرمجي. */
  errorCause?: CoverageThresholdErrorCause;
}

/**
 * يتحقّق من أنّ قيمة نسبة التغطية رقم محدود ضمن المجال [0..100].
 */
function isValidPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * يقيّم عتبة تغطية العبارات لوحدات المسار الحرج — دالة نقيّة بلا أثر جانبي.
 *
 * @param summary         بنية ملخّص التغطية المُحلَّلة (أو `null`/`undefined` إذا
 *                        تعذّر إنتاجها أو تحليلها — يُفعّل الفشل المُغلق).
 * @param criticalModules قائمة مسارات وحدات المسار الحرج الواجب تقييمها.
 * @param thresholdPct    عتبة تغطية العبارات (٪)؛ الوحدة دونها فجوة. الافتراضي 90.
 * @returns CoverageThresholdResult يضمّ التقييم لكل وحدة والفجوات وحالة النجاح،
 *          ومؤشّر خطأ يحدّد السبب عند الفشل المُغلق.
 */
export function evaluateCoverageThreshold(
  summary: CoverageSummaryShape | null | undefined,
  criticalModules: readonly string[] = CRITICAL_PATH_MODULE_GLOBS,
  thresholdPct: number = DEFAULT_COVERAGE_THRESHOLD_PCT,
): CoverageThresholdResult {
  // الفشل المُغلق (16.5): تقرير مفقود/غير قابل للتحليل ⇒ خطأ صريح، لا تمرير صامت.
  if (summary === null || summary === undefined || typeof summary !== 'object') {
    return {
      perModule: [],
      gaps: [],
      ok: false,
      error:
        'تقرير التغطية مفقود أو غير قابل للتحليل؛ تعذّر تقييم عتبة تغطية وحدات المسار الحرج (fail-closed).',
      errorCause: 'report-missing',
    };
  }

  const perModule: ModuleCoverageEvaluation[] = [];
  const gaps: string[] = [];
  const missingEntries: string[] = [];
  const invalidMetrics: string[] = [];

  for (const module of criticalModules) {
    const entry = resolveEntry(summary, module);

    if (entry === undefined) {
      // مدخل وحدة مفقود ⇒ إخفاق المُشغِّل أو تعذّر جمع التغطية لها (16.5).
      missingEntries.push(module);
      perModule.push({ module, statementsPct: null, isGap: true });
      gaps.push(module);
      continue;
    }

    const pct = entry.statements?.pct;
    if (!isValidPct(pct)) {
      // المدخل موجود لكن قيمة التغطية غير صالحة ⇒ تعذّر التحديد (fail-closed).
      invalidMetrics.push(module);
      perModule.push({ module, statementsPct: null, isGap: true });
      gaps.push(module);
      continue;
    }

    const isGap = pct < thresholdPct;
    perModule.push({ module, statementsPct: pct, isGap });
    if (isGap) {
      gaps.push(module);
    }
  }

  // الفشل المُغلق عند نقص مداخل أو قيم غير صالحة: يُصدَر مؤشّر خطأ يحدّد السبب.
  if (missingEntries.length > 0) {
    return {
      perModule,
      gaps,
      ok: false,
      error:
        `تعذّر جمع تغطية وحدات المسار الحرج التالية (مدخل مفقود من التقرير — ` +
        `قد يكون المُشغِّل أخفق أو لم تُجمَع التغطية): ${missingEntries.join(', ')}.`,
      errorCause: 'module-entry-missing',
    };
  }

  if (invalidMetrics.length > 0) {
    return {
      perModule,
      gaps,
      ok: false,
      error:
        `قيمة تغطية العبارات غير صالحة (خارج المجال [0..100] أو غير رقمية) للوحدات: ` +
        `${invalidMetrics.join(', ')}.`,
      errorCause: 'module-metric-invalid',
    };
  }

  return {
    perModule,
    gaps,
    ok: gaps.length === 0,
  };
}

/**
 * يحلّ مدخل وحدة ضمن الملخّص، مع مطابقة مرنة للمسار:
 * مبلّغ json-summary قد يستعمل مفاتيح مطلقة أو بفواصل نظام التشغيل، بينما تُعرّف
 * مجموعة المسار الحرج المسارات بصيغة POSIX نسبةً لجذر المشروع. نطابق بالمساواة
 * المباشرة ثم بمطابقة لاحقة (suffix) بعد توحيد الفواصل.
 */
function resolveEntry(
  summary: CoverageSummaryShape,
  module: string,
): CoverageFileSummaryShape | undefined {
  const direct = summary[module];
  if (direct !== undefined) {
    return direct;
  }

  const normalizedModule = normalizePath(module);
  for (const key of Object.keys(summary)) {
    if (key === 'total') {
      continue;
    }
    const normalizedKey = normalizePath(key);
    if (normalizedKey === normalizedModule || normalizedKey.endsWith(`/${normalizedModule}`)) {
      return summary[key];
    }
  }
  return undefined;
}

/** يوحّد فواصل المسار إلى POSIX لمطابقة متسامحة عبر الأنظمة. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─────────────────────────────────────────────────────────────────────────────
// الغلاف ذو الأثر (Effectful Wrapper) — لاستعمال CI. يُبقي المنطق أعلاه نقيّاً.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** المسار الافتراضي لملخّص التغطية كما يُصدِره مبلّغ json-summary (انظر vitest.config.ts). */
export const DEFAULT_COVERAGE_SUMMARY_PATH = './coverage/coverage-summary.json';

/**
 * يقرأ ملف ملخّص التغطية من القرص ويحلّله، ثم يُقيّم عتبة التغطية — غلاف ذو أثر.
 *
 * يطبّق الفشل المُغلق: عند تعذّر قراءة الملف (مفقود) أو تحليله (JSON تالف) يُرجَع
 * `CoverageThresholdResult` بحالة `ok=false` ومؤشّر خطأ يحدّد السبب، دون رمي
 * استثناء غير معالَج.
 *
 * @param summaryPath     مسار ملف ملخّص التغطية (افتراضياً ./coverage/coverage-summary.json).
 * @param criticalModules قائمة وحدات المسار الحرج (افتراضياً المجموعة المعرّفة).
 * @param thresholdPct    عتبة تغطية العبارات (٪)، الافتراضي 90.
 */
export function runCoverageThresholdCheck(
  summaryPath: string = DEFAULT_COVERAGE_SUMMARY_PATH,
  criticalModules: readonly string[] = CRITICAL_PATH_MODULE_GLOBS,
  thresholdPct: number = DEFAULT_COVERAGE_THRESHOLD_PCT,
): CoverageThresholdResult {
  let raw: string;
  try {
    raw = readFileSync(summaryPath, 'utf-8');
  } catch {
    return {
      perModule: [],
      gaps: [],
      ok: false,
      error:
        `تقرير التغطية مفقود في المسار "${summaryPath}"؛ تعذّر تقييم عتبة التغطية. ` +
        `شغّل اختبارات vitest مع التغطية أولاً (fail-closed).`,
      errorCause: 'report-missing',
    };
  }

  let summary: CoverageSummaryShape;
  try {
    summary = JSON.parse(raw) as CoverageSummaryShape;
  } catch {
    return {
      perModule: [],
      gaps: [],
      ok: false,
      error: `تعذّر تحليل تقرير التغطية في المسار "${summaryPath}" (JSON غير صالح) (fail-closed).`,
      errorCause: 'report-unparseable',
    };
  }

  return evaluateCoverageThreshold(summary, criticalModules, thresholdPct);
}

/**
 * نقطة دخول CLI: تقرأ الملخّص الافتراضي، تطبع تقريراً موجزاً لكل وحدة،
 * وتُنهي العملية برمز غير صفري عند وجود فجوات أو خطأ (للاستعمال في CI).
 */
export function main(): void {
  const result = runCoverageThresholdCheck();

  for (const m of result.perModule) {
    const pctText = m.statementsPct === null ? 'N/A' : `${m.statementsPct.toFixed(2)}%`;
    const flag = m.isGap ? '✗ GAP' : '✓ OK';
    console.log(`[CoverageThreshold] ${flag}  ${pctText}  ${m.module}`);
  }

  if (!result.ok) {
    if (result.error) {
      console.error(`[CoverageThreshold] FATAL: ${result.error}`);
    }
    if (result.gaps.length > 0) {
      console.error(`[CoverageThreshold] فجوات التغطية (< ${DEFAULT_COVERAGE_THRESHOLD_PCT}%): ${result.gaps.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('[CoverageThreshold] OK: كل وحدات المسار الحرج تستوفي عتبة التغطية.');
}

// يُشغَّل فقط عند تنفيذ هذا الملف مباشرةً، لا عند استيراده في الاختبارات.
const isDirectRun =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main();
}

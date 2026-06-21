/**
 * بنية تسجيل نتائج اختبار حمل سير العمل الحرج (Load_Test_Suite).
 *
 * حصّة الخلفية من متطلب اختبار الحمل العابر للمستودعات: `Load_Test_Suite` نفسه
 * يقيم في مستودع الواجهة الأمامية ويُنفَّذ مقابل الخلفية الحقيقية عبر HTTPS.
 * تعرّف هذه الوحدة:
 *  - العتبات المتفق عليها مسبقاً (LoadTestThresholds) — 15.5
 *  - بنية تسجيل النتائج المُلاحَظة (LoadTestResult) — 15.3
 *  - تصنيف نتيجة التشغيل (LoadTestClassification) — 15.4، 15.6، 15.7
 *
 * Reference: docs/load-test-thresholds.md، design.md "المنطقة (ك‑15)"
 * Requirements: 15.3, 15.4, 15.5, 15.6, 15.7
 */

/**
 * تصنيف نتيجة تشغيل اختبار الحمل (المجموعة المغلقة):
 * - `pass`            : صالح ومجتاز لكل العتبات.
 * - `launch-blocking` : عيب أداء حاصر للإطلاق (15.4، 15.6).
 * - `invalid`         : تشغيل غير صالح يستلزم إعادة التنفيذ (15.7).
 */
export type LoadTestClassification = 'pass' | 'launch-blocking' | 'invalid';

/**
 * العتبات المتفق عليها مسبقاً التي تُقيَّم عليها نتيجة التشغيل (15.5).
 * تُجمَّد قبل التنفيذ ولا تُعدَّل بعد رؤية النتيجة.
 */
export interface LoadTestThresholds {
  /** الحمل المتزامن المستهدف (عدد المستخدمين الافتراضيين المتزامنين). */
  targetConcurrency: number;
  /** مدة الحمل المستمر المطلوب الحفاظ عليها (بالثواني). */
  sustainedDurationSeconds: number;
  /** أقصى مئين p50 مقبول لزمن الاستجابة (مللي ثانية). */
  p50ThresholdMs: number;
  /** أقصى مئين p95 مقبول لزمن الاستجابة (مللي ثانية). */
  p95ThresholdMs: number;
  /** أقصى مئين p99 مقبول لزمن الاستجابة (مللي ثانية). */
  p99ThresholdMs: number;
  /** أقصى معدّل طلبات فاشلة مقبول (نسبة من 0 إلى 1). */
  failureRateThreshold: number;
  /** حدّ ذاكرة `API_Container` المُعدّ (بالبايت). */
  apiContainerMemoryLimitBytes: number;
}

/**
 * بنية تسجيل نتيجة تشغيل واحد لاختبار الحمل عند اكتماله (15.3).
 */
export interface LoadTestResult {
  /** مُعرّف فريد للتشغيل. */
  runId: string;
  /** الطابع الزمني لاكتمال التشغيل (ISO-8601). */
  completedAt: string;

  /** العتبات المتفق عليها مسبقاً المستخدمة في تقييم هذا التشغيل (15.5). */
  thresholds: LoadTestThresholds;

  // —— المقاييس المُلاحَظة (15.3) ——
  /** الحمل المتزامن المُلاحَظ فعلياً الذي بلغه المُشغِّل. */
  observedConcurrency: number;
  /** الإنتاجية المُلاحَظة (طلبات في الثانية). */
  observedThroughputRps: number;
  /** مئين p50 المُلاحَظ لزمن الاستجابة (مللي ثانية). */
  observedP50Ms: number;
  /** مئين p95 المُلاحَظ لزمن الاستجابة (مللي ثانية). */
  observedP95Ms: number;
  /** مئين p99 المُلاحَظ لزمن الاستجابة (مللي ثانية). */
  observedP99Ms: number;
  /** معدّل الطلبات الفاشلة المُلاحَظ (نسبة من 0 إلى 1). */
  observedFailureRate: number;
  /** ذروة استهلاك ذاكرة `API_Container` المُلاحَظة (بالبايت). */
  peakApiContainerMemoryBytes: number;

  // —— أعلام حالة التشغيل التي تُغذّي التصنيف ——
  /** قُتل `API_Container` بسبب تجاوز حدّ ذاكرته أثناء الاختبار (15.4). */
  apiContainerOomKilled: boolean;
  /** أكمل الحمل المتزامن المستهدف طوال مدة الحمل المستمر المحدّدة (15.7). */
  loadCompletedFullDuration: boolean;
  /** تجاوز مُشغِّل الحمل المبني على Puppeteer حدّ ذاكرته (15.7). */
  puppeteerDriverOutOfMemory: boolean;

  /** تصنيف نتيجة التشغيل (15.4، 15.6، 15.7). */
  classification: LoadTestClassification;
}

/**
 * المُدخَلات المُلاحَظة لتصنيف تشغيل اختبار حمل، مجرّدةً عن حقول السياق
 * (مُعرّف التشغيل/الطابع الزمني/التصنيف المُسجَّل). تُستعمل لحساب التصنيف نقيّاً.
 */
export type LoadTestObservations = Omit<
  LoadTestResult,
  'runId' | 'completedAt' | 'thresholds' | 'classification'
>;

/**
 * يصنّف نتيجة تشغيل اختبار حمل وفق قواعد التصنيف الموثّقة (15.4، 15.6، 15.7).
 *
 * دالة نقيّة (pure) بلا أثر جانبي تطبّق ترتيب التقييم الموثّق في
 * `docs/load-test-thresholds.md`، وحرفيّته أنّ `invalid` له الأسبقية على
 * `launch-blocking`:
 *
 *   1) إذا (puppeteerDriverOutOfMemory أو NOT loadCompletedFullDuration) → `invalid`
 *   2) وإلا إذا (apiContainerOomKilled
 *               أو تجاوُز أي مئين عتبته
 *               أو تجاوُز معدّل الفشل عتبته
 *               أو observedConcurrency < targetConcurrency) → `launch-blocking`
 *   3) وإلا → `pass`
 *
 * علّة الأسبقية: التشغيل غير المكتمل أو الذي نفدت ذاكرة مُشغِّله قياسُه غير موثوق،
 * فلا يصحّ الحكم عليه بالفشل الحاصر للإطلاق بل يُعاد تنفيذه.
 *
 * @param observations المقاييس المُلاحَظة وأعلام حالة التشغيل.
 * @param thresholds   العتبات المتفق عليها مسبقاً المُجمَّدة قبل التنفيذ (15.5).
 * @returns تصنيف نتيجة التشغيل: `pass` أو `launch-blocking` أو `invalid`.
 */
export function classifyLoadTestResult(
  observations: LoadTestObservations,
  thresholds: LoadTestThresholds,
): LoadTestClassification {
  // 1) تشغيل غير صالح يستلزم إعادة التنفيذ — يُقيَّم أولاً (15.7).
  if (observations.puppeteerDriverOutOfMemory || !observations.loadCompletedFullDuration) {
    return 'invalid';
  }

  // 2) عيب أداء حاصر للإطلاق (15.4، 15.6).
  const exceededLatency =
    observations.observedP50Ms > thresholds.p50ThresholdMs ||
    observations.observedP95Ms > thresholds.p95ThresholdMs ||
    observations.observedP99Ms > thresholds.p99ThresholdMs;
  const exceededFailureRate = observations.observedFailureRate > thresholds.failureRateThreshold;
  const belowTargetConcurrency = observations.observedConcurrency < thresholds.targetConcurrency;

  if (
    observations.apiContainerOomKilled ||
    exceededLatency ||
    exceededFailureRate ||
    belowTargetConcurrency
  ) {
    return 'launch-blocking';
  }

  // 3) اجتياز.
  return 'pass';
}

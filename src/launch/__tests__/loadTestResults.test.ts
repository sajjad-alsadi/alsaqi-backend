// @vitest-environment node
// Feature: production-launch-readiness, Task 19.2
// اختبار وحدة (مبني على أمثلة) لحصّة الخلفية من اختبار الاستقرار تحت الحمل.
//
// التشغيل الفعلي لاختبار الحمل يقيم في مستودع الواجهة ويُنفَّذ مقابل API الحقيقي
// عبر HTTPS (15.1). حصّة الخلفية المُختبَرة هنا هي منطق التصنيف
// (classifyLoadTestResult) وحدّ ذاكرة API_Container المُعدّ (≥ 2 GiB):
//  - بقاء ذاكرة API_Container ضمن الحدّ + بقاء الخدمة عاملة + استيفاء العتبات ⇒ 'pass' (15.2).
//  - قتل API_Container بسبب الذاكرة (apiContainerOomKilled) ⇒ 'launch-blocking' (15.4).
//  - تجاوز مُشغِّل Puppeteer لذاكرته أو عدم إكمال المدة ⇒ 'invalid' (15.7).
//
// Requirements: 15.1, 15.2
import { describe, it, expect } from 'vitest';
import {
  classifyLoadTestResult,
  type LoadTestObservations,
  type LoadTestThresholds,
} from '../loadTestResults.js';

/** حدّ ذاكرة API_Container المُعدّ كما توثّقه load-test-thresholds.md: 2 GiB. */
const TWO_GIB_BYTES = 2 * 1024 * 1024 * 1024; // 2147483648

/**
 * العتبات المتفق عليها مسبقاً المطابقة للقيم الموثّقة في
 * docs/load-test-thresholds.md (15.5).
 */
const THRESHOLDS: LoadTestThresholds = {
  targetConcurrency: 50,
  sustainedDurationSeconds: 600,
  p50ThresholdMs: 300,
  p95ThresholdMs: 800,
  p99ThresholdMs: 1500,
  failureRateThreshold: 0.01,
  apiContainerMemoryLimitBytes: TWO_GIB_BYTES,
};

/**
 * مُلاحظات تشغيل سليم: بلغ الحمل المستهدف، وكل المئينات ومعدّل الفشل ضمن
 * العتبات، وبقيت ذاكرة API_Container دون الحدّ، ولم يُقتل، واكتمل طوال المدة.
 */
function healthyObservations(overrides: Partial<LoadTestObservations> = {}): LoadTestObservations {
  return {
    observedConcurrency: 50,
    observedThroughputRps: 120,
    observedP50Ms: 180,
    observedP95Ms: 600,
    observedP99Ms: 1200,
    observedFailureRate: 0.002,
    peakApiContainerMemoryBytes: Math.floor(TWO_GIB_BYTES * 0.75),
    apiContainerOomKilled: false,
    loadCompletedFullDuration: true,
    puppeteerDriverOutOfMemory: false,
    ...overrides,
  };
}

describe('حدّ ذاكرة API_Container المُعدّ (≥ 2 GiB) — حصّة الخلفية (Requirement 15.2)', () => {
  it('العتبة المُعدّة لذاكرة API_Container لا تقل عن 2 GiB (2147483648 بايت)', () => {
    expect(TWO_GIB_BYTES).toBe(2147483648);
    expect(THRESHOLDS.apiContainerMemoryLimitBytes).toBeGreaterThanOrEqual(2147483648);
  });
});

describe('classifyLoadTestResult — تصنيف الاستقرار تحت الحمل (Requirements 15.1, 15.2)', () => {
  describe("'pass' — استقرار ضمن الحدّ والخدمة عاملة", () => {
    it('ذاكرة دون الحدّ + لم يُقتل + استيفاء العتبات + بلوغ الحمل ⇒ pass (15.2)', () => {
      const result = classifyLoadTestResult(healthyObservations(), THRESHOLDS);
      expect(result).toBe('pass');
    });

    it('ذروة الذاكرة عند الحدّ تماماً (لم تتجاوزه) ولم يُقتل ⇒ pass', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ peakApiContainerMemoryBytes: TWO_GIB_BYTES }),
        THRESHOLDS,
      );
      expect(result).toBe('pass');
    });

    it('قيم المئينات ومعدّل الفشل عند العتبات تماماً (دون تجاوز) ⇒ pass', () => {
      const result = classifyLoadTestResult(
        healthyObservations({
          observedP50Ms: 300,
          observedP95Ms: 800,
          observedP99Ms: 1500,
          observedFailureRate: 0.01,
        }),
        THRESHOLDS,
      );
      expect(result).toBe('pass');
    });
  });

  describe("'launch-blocking' — عيب أداء حاصر للإطلاق (Requirements 15.4, 15.6)", () => {
    it('قُتل API_Container بسبب تجاوز حدّ ذاكرته (OOM) ⇒ launch-blocking (15.4)', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ apiContainerOomKilled: true }),
        THRESHOLDS,
      );
      expect(result).toBe('launch-blocking');
    });

    it('تجاوُز مئين p95 العتبة ⇒ launch-blocking (15.6)', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ observedP95Ms: 801 }),
        THRESHOLDS,
      );
      expect(result).toBe('launch-blocking');
    });

    it('تجاوُز معدّل الفشل العتبة المقبولة ⇒ launch-blocking (15.6)', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ observedFailureRate: 0.05 }),
        THRESHOLDS,
      );
      expect(result).toBe('launch-blocking');
    });

    it('عدم بلوغ الحمل المتزامن المستهدف ⇒ launch-blocking (15.6)', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ observedConcurrency: 40 }),
        THRESHOLDS,
      );
      expect(result).toBe('launch-blocking');
    });
  });

  describe("'invalid' — تشغيل غير صالح يستلزم إعادة التنفيذ (Requirement 15.7)", () => {
    it('تجاوُز مُشغِّل Puppeteer لذاكرته ⇒ invalid', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ puppeteerDriverOutOfMemory: true }),
        THRESHOLDS,
      );
      expect(result).toBe('invalid');
    });

    it('عدم إكمال الحمل طوال المدة المحدّدة ⇒ invalid', () => {
      const result = classifyLoadTestResult(
        healthyObservations({ loadCompletedFullDuration: false }),
        THRESHOLDS,
      );
      expect(result).toBe('invalid');
    });

    it("'invalid' له الأسبقية على 'launch-blocking' حتى مع قتل الحاوية بسبب الذاكرة", () => {
      // قياس غير موثوق (لم يكتمل) ⇒ يُعاد التنفيذ بدل الحكم بالفشل الحاصر.
      const result = classifyLoadTestResult(
        healthyObservations({
          loadCompletedFullDuration: false,
          apiContainerOomKilled: true,
          observedP99Ms: 9999,
        }),
        THRESHOLDS,
      );
      expect(result).toBe('invalid');
    });
  });
});

/**
 * Deploy Guard — منطقة (ط) في التصميم (المتطلب 5.1، 5.2)
 *
 * يَفشل الإطلاق قبل بدء أي خدمة إذا كان `docker-compose.override.yml` موجوداً في
 * دليل النشر، لأن `docker compose` يُحمّله تلقائياً ويعيد كشف منافذ التطوير.
 *
 * يُفصَل المنطق الحتمي النقي (`detectAutoLoadedOverride`) عن آثار التشغيل
 * (`runDeployGuard`/CLI main) ليبقى قابلاً لاختبار الوحدة (PBT/unit) دون أثر جانبي.
 */

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** اسم الملف الذي يُحمّله `docker compose` تلقائياً ويجب ألا يوجد في دليل النشر. */
export const AUTO_LOADED_OVERRIDE_FILENAME = 'docker-compose.override.yml';

/**
 * دالة نقية: تُرجِع `true` إذا وفقط إذا احتوت قائمة ملفات دليل النشر على
 * `docker-compose.override.yml` تماماً (مطابقة اسم حسّاسة لحالة الأحرف).
 *
 * @param filesInDeployDir أسماء الملفات الموجودة في دليل النشر.
 */
export function detectAutoLoadedOverride(filesInDeployDir: string[]): boolean {
  return filesInDeployDir.includes(AUTO_LOADED_OVERRIDE_FILENAME);
}

/** نتيجة تقييم حارس النشر (قابلة للاختبار دون إنهاء العملية). */
export interface DeployGuardResult {
  /** `true` ⇒ يُسمح بالمتابعة، `false` ⇒ يجب إفشال الإطلاق. */
  ok: boolean;
  /** رسالة الخطأ الصريحة عند الفشل (تُحدّد الملف بالاسم)، أو `null` عند النجاح. */
  message: string | null;
}

/**
 * منطق الحارس النقي فوق قائمة ملفات: يبني النتيجة ورسالة الخطأ الصريحة دون أثر.
 */
export function evaluateDeployGuard(filesInDeployDir: string[]): DeployGuardResult {
  if (detectAutoLoadedOverride(filesInDeployDir)) {
    return {
      ok: false,
      message:
        `[DeployGuard] FATAL: العثور على "${AUTO_LOADED_OVERRIDE_FILENAME}" في دليل النشر. ` +
        `سيُحمّله "docker compose" تلقائياً ويعيد كشف منافذ التطوير. ` +
        `أزِل "${AUTO_LOADED_OVERRIDE_FILENAME}" قبل النشر الإنتاجي. تم إفشال الإطلاق قبل بدء أي خدمة.`,
    };
  }
  return { ok: true, message: null };
}

/**
 * حارس النشر مع الأثر: يقرأ قائمة ملفات دليل النشر (افتراضياً `process.cwd()`)،
 * ويُنهي العملية برمز غير صفري قبل بدء أي خدمة عند وجود ملف التجاوز التلقائي.
 *
 * @param deployDir دليل النشر المراد فحصه (افتراضياً دليل العمل الحالي).
 */
export function runDeployGuard(deployDir: string = process.cwd()): void {
  const files = readdirSync(deployDir);
  const result = evaluateDeployGuard(files);

  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }

  console.log('[DeployGuard] OK: لا يوجد ملف تجاوز تلقائي في دليل النشر.');
}

// CLI main: يُشغَّل فقط عند تنفيذ هذا الملف مباشرةً، لا عند استيراده في الاختبارات.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runDeployGuard();
}

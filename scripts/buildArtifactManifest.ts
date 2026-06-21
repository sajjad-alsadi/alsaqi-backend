/**
 * Build_Artifact_Manifest generator — نموذج البيانات `BuildArtifactManifest`
 * (المتطلب 20.5؛ يدعم سياق 20.2–20.4 في خطّ أنابيب CD).
 *
 * عند بناء الصورة الإنتاجية، يُنتِج خطّ أنابيب CD بياناً (manifest) لناتج البناء
 * يسجّل قيمة digest المحلولة لكل صورة أساس مُستخدَمة، إضافةً إلى ملخّص فحص الثغرات
 * (الأداة، أعداد HIGH/CRITICAL، وعلم اكتمال الفحص `completed`).
 *
 * البنية: هذا الملف يحتوي **منطقاً نقياً فقط** (`buildArtifactManifest`) دون أثر
 * جانبي (لا قراءة ملفات، لا شبكة، لا تنفيذ أوامر)، ليبقى قابلاً لاختبار الوحدة
 * (يستورده اختبار المهمة 25.3). آثار التشغيل (حلّ الـ digest عبر
 * `docker buildx imagetools inspect`، قراءة نتائج Trivy، كتابة الملف) تُنفَّذ في
 * خطوات CD في `.github/workflows/cd.yml`، وتُمرَّر المُدخلات النقية إلى هذه الدالة.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { BuildArtifactManifest } from '../src/launch/types.js';

/** مدخل صورة أساس مُستخدَمة في البناء مع الـ digest المحلول لها. */
export interface ResolvedImage {
  /** مرجع الصورة كما ورد في تعليمة FROM (مثل `node:20-alpine`). */
  ref: string;
  /** قيمة digest المحلولة (مثل `sha256:...`) للصورة الأساس. */
  resolvedDigest: string;
}

/** ملخّص نتيجة فحص الثغرات الذي تُنتجه أداة الفحص (Trivy). */
export interface ScanSummary {
  /** اسم أداة الفحص (مثل `trivy`). */
  tool: string;
  /** عدد الثغرات بدرجة HIGH. */
  highCount: number;
  /** عدد الثغرات بدرجة CRITICAL. */
  criticalCount: number;
  /**
   * `true` ⇔ اكتمل الفحص فعلياً (نجح تشغيل الأداة وتوفّرت بيانات الثغرات).
   * `false` ⇔ تعذّر إكمال الفحص (fail-closed: يجب عدم النشر).
   */
  completed: boolean;
}

/**
 * دالة نقية: تبني `BuildArtifactManifest` من وقت البناء، وقائمة الصور المحلولة،
 * وملخّص الفحص — دون أي أثر جانبي.
 *
 * @param builtAt وقت البناء بصيغة ISO-8601.
 * @param images الصور الأساس المُستخدَمة مع الـ digest المحلول لكل منها.
 * @param scan ملخّص فحص الثغرات (الأداة، أعداد HIGH/CRITICAL، علم الاكتمال).
 */
export function buildArtifactManifest(
  builtAt: string,
  images: ResolvedImage[],
  scan: ScanSummary,
): BuildArtifactManifest {
  return {
    builtAt,
    images: images.map((image) => ({
      ref: image.ref,
      resolvedDigest: image.resolvedDigest,
    })),
    scan: {
      tool: scan.tool,
      highCount: scan.highCount,
      criticalCount: scan.criticalCount,
      completed: scan.completed,
    },
  };
}

// ---------------------------------------------------------------------------
// طبقة الأثر (CLI): تُشغَّل فقط عند تنفيذ هذا الملف مباشرةً من خطوة CD، لا عند
// استيراد الدالة النقية في اختبارات الوحدة (المهمة 25.3).
//
// يقرأ المُدخلات من متغيّرات البيئة التي تهيّئها خطوات CD:
//   BUILT_AT          وقت البناء ISO-8601 (افتراضياً وقت التشغيل الحالي).
//   MANIFEST_IMAGES   JSON لمصفوفة [{ ref, resolvedDigest }] للصور الأساس.
//   SCAN_TOOL         اسم أداة الفحص (افتراضياً "trivy").
//   SCAN_HIGH_COUNT   عدد ثغرات HIGH.
//   SCAN_CRITICAL_COUNT عدد ثغرات CRITICAL.
//   SCAN_COMPLETED    "true" ⇔ اكتمل الفحص (fail-closed خلاف ذلك).
//   MANIFEST_OUTPUT   مسار ملف الإخراج (افتراضياً "build-artifact-manifest.json").

function parseImagesEnv(raw: string | undefined): ResolvedImage[] {
  if (!raw || raw.trim() === '') {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('MANIFEST_IMAGES must be a JSON array of { ref, resolvedDigest }.');
  }
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.ref !== 'string' || typeof e.resolvedDigest !== 'string') {
      throw new Error('Each MANIFEST_IMAGES entry must have string ref and resolvedDigest.');
    }
    return { ref: e.ref, resolvedDigest: e.resolvedDigest };
  });
}

function runCli(): void {
  const builtAt = process.env.BUILT_AT && process.env.BUILT_AT.trim() !== ''
    ? process.env.BUILT_AT
    : new Date().toISOString();

  const images = parseImagesEnv(process.env.MANIFEST_IMAGES);

  const scan: ScanSummary = {
    tool: process.env.SCAN_TOOL && process.env.SCAN_TOOL.trim() !== '' ? process.env.SCAN_TOOL : 'trivy',
    highCount: Number.parseInt(process.env.SCAN_HIGH_COUNT ?? '0', 10) || 0,
    criticalCount: Number.parseInt(process.env.SCAN_CRITICAL_COUNT ?? '0', 10) || 0,
    completed: process.env.SCAN_COMPLETED === 'true',
  };

  const manifest = buildArtifactManifest(builtAt, images, scan);

  const outputPath = process.env.MANIFEST_OUTPUT && process.env.MANIFEST_OUTPUT.trim() !== ''
    ? process.env.MANIFEST_OUTPUT
    : 'build-artifact-manifest.json';

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[BuildArtifactManifest] wrote ${outputPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runCli();
}

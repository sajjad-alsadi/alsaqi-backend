/**
 * نماذج بيانات برنامج جاهزية الإطلاق الإنتاجي (production-launch-readiness).
 *
 * تقتصر هذه الوحدة على الكيانات الجديدة التي يحتاجها هذا البرنامج:
 * سجل تمرين الاسترجاع، وجرد المسار↔الصلاحية، وبيانات التكافؤ/البصمة،
 * وتقرير تكافؤ سجل الصلاحيات، وتجميع بوابة الإطلاق، وبيان ناتج البناء.
 *
 * Reference: design.md "Data Models"
 * Requirements: 3.6, 6.4, 8.3, 17.1, 20.5, 22.2
 */

// 1. سجل تمرين الاسترجاع (المتطلب 3.5، 3.6، 3.8)
export interface RestoreDrillLog {
  restoreId: string;
  backupId: string;
  executedAt: string; // ISO-8601
  targetDatabase: string; // الهدف النظيف
  tableRowCounts: Record<string, { expected: number; actual: number }>; // الجداول الحرجة
  result: 'verified' | 'failed';
  verifiedRestorable: boolean; // true ⇔ result === 'verified' وكل الأعداد متطابقة
}

// 2. مدخل جرد المسار↔الصلاحية (المتطلب 6.4، 6.5)
export interface RoutePermissionEntry {
  method: string;
  path: string;
  permission: { module: string; action: string } | null; // null = لا فحص صلاحية
  mutating: boolean;
  isGap: boolean; // mutating && permission === null
}

// 3. بصمة السطح العام لـ Shared_Package + بيان التكافؤ (المتطلب 8.3)
export interface SharedSurfaceFingerprint {
  version: string; // مُعرّف نسخة @alsaqi/shared
  fingerprint: string; // SHA-256 hex فوق السطح المُقنَّن
}

export interface ParityManifest {
  backend: SharedSurfaceFingerprint;
  frontend: SharedSurfaceFingerprint;
  match: boolean; // backend.fingerprint === frontend.fingerprint
}

// 4. تقرير تكافؤ سجل الصلاحيات (المتطلب 17.1، 17.2، 17.3)
export type ParitySide = 'both' | 'backend-only' | 'frontend-only';

export interface PermissionParityRow {
  module: string;
  permission: string;
  side: ParitySide;
}

export interface PermissionParityReport {
  rows: PermissionParityRow[];
  gaps: PermissionParityRow[]; // كل صف side !== 'both'
}

// 5. تجميع بوابة الإطلاق (Launch_Gate) (المتطلب 22.1، 22.2، 22.5، 22.6)
export type GateStatus = 'pass' | 'fail' | 'unverified'; // المجموعة المغلقة في 22.2؛ unverified ≡ "غير مُتحقَّق منه" (يشمل تعذّر التقييم)

export interface LaunchGateCriterion {
  id: string; // مُعرّف معيار قبول P0، مثل "1.2"
  priority: 'P0' | 'P1' | 'P2';
  status: GateStatus;
  evidenceRef: string | null; // مرجع دليل يوثّق أساس الحالة المُسنَدة (22.5)؛ null = لا دليل مسجَّل
}

export interface LaunchGateResult {
  criteria: LaunchGateCriterion[]; // تعداد كل معايير P0 (22.1)
  gatePassed: boolean; // true ⇔ كل معيار P0 حالته 'pass' وله evidenceRef غير فارغ (22.4، 22.6)
}

// 6. بيان ناتج البناء (المتطلب 20.5)
export interface BuildArtifactManifest {
  builtAt: string;
  images: Array<{ ref: string; resolvedDigest: string }>; // digest محلول لكل صورة أساس
  scan: { tool: string; highCount: number; criticalCount: number; completed: boolean };
}

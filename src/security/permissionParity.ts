/**
 * مولّد تقرير تكافؤ سجل الصلاحيات (Permission Registry Parity).
 *
 * يوفّق بين سجل صلاحيات الخلفية (Permission_Registry) وسجل صلاحيات الواجهة
 * الأمامية (Frontend_Permission_Registry، يعيش في مستودع الواجهة ويُمرَّر هنا
 * كوسيط). لكل وحدة/صلاحية في اتحاد السجلّين، يُنتَج صف مُؤشَّر بـ:
 *   - 'both'          : معرَّف في كلا السجلّين
 *   - 'backend-only'  : معرَّف في سجل الخلفية وحده (مفقود من الواجهة)
 *   - 'frontend-only' : معرَّف في سجل الواجهة وحده (مفقود من الخلفية)
 *
 * `gaps` = كل صف `side !== 'both'`؛ وبذلك تكون `gaps` فارغة إذا وفقط إذا
 * احتوى السجلّان على المجموعة نفسها تماماً من الوحدات والصلاحيات.
 *
 * Reference: design.md "Property 8: كشف فجوات تكافؤ سجل الصلاحيات"
 * Requirements: 17.1, 17.2, 17.3
 */

import type {
  ParitySide,
  PermissionParityRow,
  PermissionParityReport,
} from '../launch/types.js';

/**
 * مدخل سجل صلاحيات: وحدة + صلاحية. يُقبل من أي من السجلّين (الخلفية أو الواجهة).
 */
export interface PermissionRegistryEntry {
  module: string;
  permission: string;
}

/**
 * يبني تقرير تكافؤ سجل الصلاحيات من سجلّي الخلفية والواجهة.
 *
 * كل صف يُمثّل زوج (module, permission) فريد ضمن اتحاد السجلّين، مُؤشَّر باتجاه
 * النقص. الصفوف مُرتَّبة ترتيباً مُحدَّداً (module ثم permission) لضمان ناتج
 * قابل للتكرار بغضّ النظر عن ترتيب المدخلات.
 *
 * @param backendRegistry  سجل صلاحيات الخلفية (Permission_Registry).
 * @param frontendRegistry سجل صلاحيات الواجهة (Frontend_Permission_Registry).
 * @returns تقرير يحتوي كل الصفوف وقائمة الفجوات (`side !== 'both'`).
 */
export function buildPermissionParityReport(
  backendRegistry: ReadonlyArray<PermissionRegistryEntry>,
  frontendRegistry: ReadonlyArray<PermissionRegistryEntry>,
): PermissionParityReport {
  const backendKeys = new Set(backendRegistry.map(keyOf));
  const frontendKeys = new Set(frontendRegistry.map(keyOf));

  // اتحاد السجلّين: مدخل واحد لكل (module, permission) فريد.
  const union = new Map<string, PermissionRegistryEntry>();
  for (const entry of backendRegistry) union.set(keyOf(entry), normalize(entry));
  for (const entry of frontendRegistry) union.set(keyOf(entry), normalize(entry));

  const rows: PermissionParityRow[] = [];
  for (const [key, entry] of union) {
    const inBackend = backendKeys.has(key);
    const inFrontend = frontendKeys.has(key);
    const side: ParitySide = inBackend && inFrontend
      ? 'both'
      : inBackend
        ? 'backend-only'
        : 'frontend-only';
    rows.push({ module: entry.module, permission: entry.permission, side });
  }

  // ترتيب مُحدَّد لضمان ناتج قابل للتكرار.
  rows.sort(
    (a, b) =>
      a.module.localeCompare(b.module) || a.permission.localeCompare(b.permission),
  );

  const gaps = rows.filter((row) => row.side !== 'both');

  return { rows, gaps };
}

/** مفتاح فريد لزوج (module, permission). */
function keyOf(entry: PermissionRegistryEntry): string {
  return `${entry.module}\u0000${entry.permission}`;
}

/** نسخة مُجرَّدة من أي حقول إضافية، تحتفظ بـ module وpermission فقط. */
function normalize(entry: PermissionRegistryEntry): PermissionRegistryEntry {
  return { module: entry.module, permission: entry.permission };
}

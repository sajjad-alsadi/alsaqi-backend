/**
 * مجموعة وحدات المسار الحرج (Critical-Path Module Set) لبرنامج جاهزية الإطلاق الإنتاجي.
 *
 * يُعرّف هذا الملف — كمصدر وحيد قابل للتعداد صراحةً — وحدات الشيفرة المصدرية التي
 * تنفّذ المصادقة (authentication) والتفويض (authorization) ومنطق النسخ الاحتياطي
 * أو الاسترجاع (backup/restore). تُستهلك هذه المجموعة من قِبل:
 *  - إعداد تغطية vitest (`coverage.include`) لتوليد Coverage_Report بمدخل لكل وحدة (16.1).
 *  - فحص عتبة التغطية (المهمة 20.2) لوسم أي وحدة < 90% كفجوة تغطية (16.4).
 *
 * مرجع: requirements.md "Requirement 16"، design.md "تغطية اختبارات المسارات الحرجة".
 * Requirements: 16.1, 16.2
 */

/**
 * تصنيف وظيفي لوحدة المسار الحرج ضمن المجموعة المغلقة المعرّفة في 16.2:
 * المصادقة، أو التفويض، أو منطق النسخ الاحتياطي/الاسترجاع.
 */
export type CriticalPathCategory = 'authentication' | 'authorization' | 'backup-restore';

/**
 * مدخل واحد قابل للتعداد يصف وحدة مسار حرج وموقعها الفعلي في الشيفرة المصدرية.
 */
export interface CriticalPathModule {
  /** مُعرّف مستقر وقابل للقراءة آلياً للوحدة (يُستخدم مفتاحاً في تقارير التغطية). */
  id: string;
  /** التصنيف الوظيفي ضمن المجموعة المغلقة (16.2). */
  category: CriticalPathCategory;
  /**
   * مسار الملف نسبةً إلى جذر مشروع الخلفية (alsaqi-backend)، بصيغة POSIX،
   * مطابق لنمط `coverage.include` في `vitest.config.ts`.
   */
  path: string;
  /** توثيق موجز لمسؤولية الوحدة ضمن المسار الحرج. */
  description: string;
}

/**
 * المجموعة المغلقة لوحدات المسار الحرج (16.2).
 *
 * كل مدخل يطابق وحدة شيفرة مصدرية واحدة. تُحافظ على هذا الجدول متزامناً مع
 * `coverage.include` في `vitest.config.ts`؛ أي إضافة وحدة مصادقة/تفويض/نسخ
 * احتياطي جديدة يجب أن تُسجَّل هنا وفي إعداد التغطية معاً.
 */
export const CRITICAL_PATH_MODULES: readonly CriticalPathModule[] = [
  // ── المصادقة (Authentication) ──────────────────────────────────────────────
  {
    id: 'auth-middleware',
    category: 'authentication',
    path: 'src/middleware/auth.ts',
    description:
      'مصنع وسائط المصادقة (createAuthMiddlewares): التحقق من رموز JWT وإرفاق المستخدم ' +
      'بالطلب، وإنتاج البدائيتين authenticate وcheckPermission اللتين تعتمد عليهما المسارات المحمية.',
  },

  // ── التفويض (Authorization) ─────────────────────────────────────────────────
  {
    id: 'permission-service',
    category: 'authorization',
    path: 'src/services/PermissionService.ts',
    description:
      'خدمة حلّ الصلاحيات الفعّالة (getUserPermissions/getEffectivePermissions/resolvePermission): ' +
      'تجمع منح الأدوار مع تجاوزات المستخدم وتطرح الرفض الصريح لإنفاذ RBAC وقت التشغيل.',
  },
  {
    id: 'permission-registry',
    category: 'authorization',
    path: 'src/permissions/registry.ts',
    description:
      'سجل صلاحيات الخلفية (Permission_Registry): التعريف المرجعي للوحدات والإجراءات ' +
      'الذي يُقاس عليه تكافؤ الصلاحيات وتُبنى عليه فحوص checkPermission.',
  },
  {
    id: 'permission-modules',
    category: 'authorization',
    path: 'src/permissions/modules.ts',
    description:
      'تعريف وحدات الصلاحيات وخريطة PERMISSION_MODULE_MAP المستهلكة من @alsaqi/shared، ' +
      'وهي أساس ربط كل مسار محمي بزوج الوحدة-والإجراء.',
  },

  // ── منطق النسخ الاحتياطي/الاسترجاع (Backup / Restore) ───────────────────────
  {
    id: 'backup-service',
    category: 'backup-restore',
    path: 'src/utils/backup.ts',
    description:
      'خدمة النسخ الاحتياطي (Backup_Service): إنتاج نسخ قاعدة البيانات مع تشفير AES-256 ' +
      'وتضمين UPLOAD_DIR والنسخ إلى Offsite_Store ووسم الدورات الفاشلة.',
  },
  {
    id: 'restore-drill',
    category: 'backup-restore',
    path: 'scripts/restoreDrill.ts',
    description:
      'سكربت تمرين الاسترجاع (Restore_Drill): استعادة نسخة مشفّرة إلى هدف نظيف ومقارنة ' +
      'أعداد صفوف الجداول الحرجة وتسجيل RestoreDrillLog (verified/failed).',
  },
] as const;

/**
 * قائمة مسارات الملفات وحدها — صيغة ملائمة لإسنادها مباشرةً إلى `coverage.include`.
 */
export const CRITICAL_PATH_MODULE_GLOBS: readonly string[] = CRITICAL_PATH_MODULES.map(
  (m) => m.path,
);

/**
 * إرجاع وحدات المسار الحرج المنتمية إلى تصنيف وظيفي محدّد.
 */
export function getCriticalPathModulesByCategory(
  category: CriticalPathCategory,
): readonly CriticalPathModule[] {
  return CRITICAL_PATH_MODULES.filter((m) => m.category === category);
}

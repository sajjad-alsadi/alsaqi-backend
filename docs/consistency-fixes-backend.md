# Backend Consistency Fixes (alsaqi-backend)

> توثيق إصلاحات جانب الواجهة الخلفية الناتجة عن مراجعة الاتساق بين الواجهة الأمامية (`alsaqi-frontend`) والخلفية.
> النطاق: هذا المستند يغطّي **إصلاحات الـ backend فقط**. إصلاحات الواجهة الأمامية مُسلّمة في ملف منفصل (`docs/frontend-consistency-fixes-handoff.md`).

تاريخ المراجعة: 2026-06-12

## السياق
- نقطة الدخول الحيّة للخادم: `src/main.ts` → `createApiServer` (`src/index.ts`) → `createV1Router` (`src/routes/v1/index.ts`).
- الحزمة المشتركة `packages/shared` **منسوخة يدوياً** في كلا المستودعين. المقارنة أظهرت تطابقاً تاماً في كل الملفات (enums, validators, api.ts, endpoints/*, constants) **عدا** `types/models.ts`.
- جميع نقاط النهاية التي تستدعيها الواجهة الأمامية موجودة فعلاً في الراوتر الحيّ.

---

## FIX-BE-1 — مزامنة `packages/shared/src/types/models.ts` (أولوية عالية)
**المشكلة:** نسخة الواجهة الأمامية من `models.ts` تحتوي 8 أنواع إضافية غير موجودة في نسخة الخادم، رغم أن الملف يُفترض أنه "single source of truth".

**الأنواع الناقصة في الخادم:**
`DashboardStats`, `AuditProgressByType`, `RiskLevelBreakdown`, `Role`, `Permission`, `UserSession`, `JobTitle`, `UserManagementSettings`.

**الإجراء:** إضافة الكتلتين التاليتين إلى نهاية `packages/shared/src/types/models.ts` (مطابقة لنسخة الواجهة الأمامية):

```ts
// ─── Dashboard Stats ──────────────────────────────────────────────────────────

/** A single row in the audit progress-by-type breakdown. */
export interface AuditProgressByType {
  type: string;
  planned: number;
  completed: number;
}

/** A single risk-level bucket in the dashboard risk overview. */
export interface RiskLevelBreakdown {
  level: string;
  count: number;
}

/**
 * Aggregated dashboard statistics returned by `GET /v1/dashboard-stats`.
 */
export interface DashboardStats {
  audits: { total: number; completed: number; progress_by_type: AuditProgressByType[] };
  findings: { summary: { open: number; high_risk_open: number } };
  recommendations: { open: number; overdue: number };
  risks: { summary: { total: number; high: number }; byLevel?: RiskLevelBreakdown[] };
  correspondence: { incoming_total: number; outgoing_total: number; pending_responses: number };
  compliance: { total: number };
  activity: Array<Record<string, unknown>>;
}

// ─── User Management ────────────────────────────────────────────────────────────

export interface Role { id: string | number; name: string; description?: string; }
export interface Permission { id: string | number; module: string; action: string; }
export interface UserSession {
  id: string | number;
  user_id: string | number;
  ip_address?: string;
  user_agent?: string;
  created_at?: string;
  expires_at?: string;
}
export interface JobTitle { id: string | number; name: string; name_ar?: string; name_en?: string; }
export interface UserManagementSettings {
  failed_login_threshold?: number;
  inactive_account_threshold_days?: number;
  password_min_length?: number;
  password_require_uppercase?: number;
  password_require_lowercase?: number;
  password_require_numbers?: number;
  password_require_symbols?: number;
  password_expiry_days?: number;
  enforce_single_session?: number;
  session_timeout_minutes?: number;
}
```

**التحقق:** بعد الإضافة يجب أن يصبح ملفّا `models.ts` في المستودعين متطابقين بايتياً. شغّل بناء حزمة shared (`tsc`) للتأكد من عدم وجود أخطاء.

---

## FIX-BE-2 — حذف الكود الميّت `src/routes/index.ts`
**المشكلة:** `src/routes/index.ts` يصدّر `setupRoutes` لكنه **غير مستخدم** في مسار التشغيل (الراوتر الحيّ هو `src/routes/v1/index.ts`). الملفان انحرفا (مثلاً `/reports` موجود في `v1/index.ts` فقط)، ما يخلق خطر تعديل الملف الخطأ.

**الإجراء:**
1. ابحث عن أي استيراد لـ `setupRoutes` للتأكد من عدم استخدامه في الإنتاج (المتوقع: المراجع فقط في الاختبارات/قديمة).
2. احذف `src/routes/index.ts`، أو إن كان مستخدماً في اختبارات، حوّل الاختبارات لاستخدام `createV1Router` ثم احذفه.

**التحقق:** `npm run build` + تشغيل مجموعة الاختبارات.

---

## FIX-BE-3 — إزالة/ربط المسار اليتيم `src/routes/regulatory.ts`
**المشكلة:** `regulatory.ts` غير مُركّب في أي راوتر، وفيه `POST /central-bank-instructions` يعيد `501 Not Implemented`. عملياً كيان `central_bank_instructions` يُخدَم بالكامل عبر مولّد الـ CRUD العام (`createCrudRoutes` → `generateRoutes("central_bank_instructions", "central-bank-instructions", "Policies")`)، لذا هذا الملف مضلّل.

**الإجراء:** احذف `src/routes/regulatory.ts` (وأي خدمة `RegulatoryService` غير مستخدمة بعده) ما لم تكن هناك نية لاستبدال مسار الـ CRUD العام بمسار مخصّص. إن أُبقي عليه، يجب ربطه في `createV1Router` وإكمال تنفيذ الـ POST بدل `501`.

---

## FIX-BE-4 — تسجيل مزدوج لـ `/roles/:id/permissions`
**المشكلة:** المسار مُعرّف في موضعين مُركّبين على `/`:
- `src/routes/roles.ts` → `GET` و `POST /roles/:id/permissions`
- `src/routes/permissionAdmin.ts` → `GET` و `PUT /roles/:id/permissions`

الواجهة الأمامية تستخدم `POST` (يلتقطه `roles.ts`). التداخل يسبب التباساً في مصدر الحقيقة.

**الإجراء:** وحّد منطق تحديث صلاحيات الدور في وحدة واحدة (يُفضّل `permissionAdmin.ts` لأنه يحوي مصفوفة الصلاحيات الكاملة والتدقيق)، واتفق مع جانب الواجهة الأمامية على فعل واحد (`POST` أو `PUT`). راجع `src/utils/routeRegistry.ts` / `logDuplicateRoutes` للتأكد من رصد التكرار.

---

## FIX-BE-5 — إغلاق فجوة تغطية العقد بالأنواع (أولوية متوسطة)
**المشكلة:** العقود المُوثّقة (`packages/shared/src/types/endpoints/*` + `validators/*`) تغطّي ~10 مجالات فقط. نقاط تخدمها الواجهة الأمامية لا تملك عقداً مشتركاً:
- `/v1/risk-register` (CRUD generator)
- `/v1/central-bank-instructions` (CRUD generator)
- `/v1/dashboard-stats`
- مجموعة user-management: `/v1/users/init`, `/v1/users/summary`, `/v1/user-management-settings`, `/v1/login-history`, `/v1/audit-trail`, `/v1/permissions`, `/v1/roles/:id/permissions`

**الإجراء:** أضِف عقود `endpoints/*` ومخططات `validators/*` لهذه النطاقات في `packages/shared`، بحيث يستهلكها الطرفان بدل تعريف مخططات Zod محلية في الواجهة الأمامية. هذا يجب أن يُنفّذ بالتنسيق مع جانب الواجهة الأمامية (انظر FIX-FE-3).

---

## FIX-BE-6 — (معماري) توحيد `packages/shared` كمصدر واحد
**المشكلة:** النسخ اليدوي للحزمة المشتركة بين المستودعين هو جذر الانحراف (FIX-BE-1).

**الإجراء (اختيار واحد):**
- نشر `@alsaqi/shared` كحزمة مُصدّرة بنسخة (npm registry خاص) يستهلكها الطرفان، أو
- استخدام git submodule لمجلد `shared` مشترك، أو
- دمج المستودعين في monorepo واحد بحزمة `shared` وحيدة.

بعد التوحيد، تصبح FIX-BE-1 غير ضرورية مستقبلاً لأن المزامنة تلقائية.

---

## ترتيب التنفيذ المقترح
1. FIX-BE-1 (مزامنة فورية تمنع أخطاء الأنواع).
2. FIX-BE-2 و FIX-BE-3 و FIX-BE-4 (تنظيف كود ميّت/مكرّر — منخفضة المخاطر).
3. FIX-BE-5 (توسيع العقود) بالتنسيق مع الواجهة الأمامية.
4. FIX-BE-6 (القرار المعماري طويل المدى).

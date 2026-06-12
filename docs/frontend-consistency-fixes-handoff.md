# Frontend Consistency Fixes — Handoff (alsaqi-frontend)

> ملف تسليم لمساعد الواجهة الأمامية. الإصلاحات أدناه تُنفَّذ داخل مستودع `alsaqi-frontend`
> (المسارات نسبية إلى جذر ذلك المستودع). صادرة من مراجعة الاتساق frontend ↔ backend.
> ملاحظة: الإصلاحات المعمارية المشتركة (FIX-FE-1, FIX-FE-3) يجب أن تُنسّق مع جانب الـ backend.

تاريخ المراجعة: 2026-06-12

## ملخص الوضع
- كل نقطة نهاية تستدعيها الواجهة الأمامية موجودة فعلاً في الخادم — لا توجد استدعاءات معطّلة (404 متوقّع).
- المشكلة الجوهرية: الحزمة المشتركة `packages/shared` منسوخة يدوياً في المستودعين وانحرفت في ملف `types/models.ts` فقط (نسخة الواجهة الأمامية هي الأحدث/superset).
- توجد تحسينات اتساق داخلية في طبقة `apps/web/src/api`.

---

## FIX-FE-1 — توحيد الحزمة المشتركة (تنسيق مع الـ backend)
**الوضع:** نسخة الواجهة الأمامية من `packages/shared/src/types/models.ts` تحتوي 8 أنواع إضافية صحيحة وغير موجودة في الخادم:
`DashboardStats`, `AuditProgressByType`, `RiskLevelBreakdown`, `Role`, `Permission`, `UserSession`, `JobTitle`, `UserManagementSettings`.

**المطلوب من جانب الواجهة الأمامية:**
- لا تحذف هذه الأنواع — هي الأصل الصحيح. جانب الـ backend سيضيفها لمزامنة نسخته (مُوثّق لديه).
- توقّف عن إدخال أي تعديلات محلية إضافية على `packages/shared` دون التنسيق، حتى يُتّفق على مصدر مشترك واحد (npm package / git submodule / monorepo).
- بعد قرار التوحيد: بدّل الاستيراد إلى الحزمة الموحّدة الوحيدة وأزِل النسخة المحلية المكرّرة.

---

## FIX-FE-2 — توحيد مصدر استيراد الأنواع في وحدات الـ API
**المشكلة:** عدم اتساق في مصدر الاستيراد بين الوحدات:
- معظم الوحدات تستورد من `@alsaqi/shared` (الصحيح).
- لكن `apps/web/src/api/modules/regulatory.ts` يستورد `CentralBankInstruction` من `../../types` بدلاً من `@alsaqi/shared`:
  ```ts
  // الحالي (غير متّسق):
  import type { CentralBankInstruction } from '../../types';
  // المطلوب:
  import type { CentralBankInstruction } from '@alsaqi/shared';
  ```

**الإجراء:** وحّد كل استيرادات نماذج البيانات المشتركة لتأتي من `@alsaqi/shared`. افحص بقية الوحدات في `apps/web/src/api/modules/*` و `apps/web/src/types` لرصد أي استيراد محلي مكرّر لنوع موجود أصلاً في الحزمة المشتركة.

---

## FIX-FE-3 — نقل مخططات Zod المحلية إلى الحزمة المشتركة (تنسيق مع الـ backend)
**المشكلة:** عدة وحدات تعرّف مخططات Zod محلياً بدل الاعتماد على عقد مشترك مُوثّق، ما يجعلها عرضة للانحراف الصامت عن الخادم:
- `apps/web/src/api/modules/risk-register.ts` → `RiskItemSchema`
- `apps/web/src/api/modules/regulatory.ts` → `InstructionSchema`
- `apps/web/src/api/modules/dashboard.ts` → `DashboardStatsSchema`
- `apps/web/src/api/modules/user-management.ts` → `RoleSchema`, `PermissionSchema`, `SessionSchema`, `SettingsSchema`, `JobTitleSchema`

**الإجراء:** انقل هذه المخططات إلى `packages/shared/src/validators/*` وأضِف عقود `types/endpoints/*` المقابلة، بحيث يستهلكها الطرفان من مصدر واحد. (جانب الـ backend سيضيف العقود المقابلة — FIX-BE-5).

---

## FIX-FE-4 — إزالة كبت أخطاء TypeScript (`@ts-expect-error`)
**المشكلة:** توجد عدة `@ts-expect-error` لتجاوز تعارض `exactOptionalPropertyTypes` مع `.optional()` في Zod، في:
- `apps/web/src/api/modules/dashboard.ts` (`DashboardStatsSchema`)
- `apps/web/src/api/modules/risk-register.ts` (`RiskItemSchema`)
- `apps/web/src/api/modules/user-management.ts` (`RoleSchema`, `SessionSchema`, `SettingsSchema`, `JobTitleSchema`)

**الإجراء:** أصلح أنماط النوع بدل كبتها — مثلاً استخدم `z.infer` لاشتقاق النوع من المخطط بدل تثبيت `z.ZodType<T>` يدوياً، أو واءم تعريفات الحقول الاختيارية مع `exactOptionalPropertyTypes`. الهدف: صفر `@ts-expect-error` في طبقة الـ API.

---

## FIX-FE-5 — التأكد من ضبط عنوان الـ API والإصدار
**الوضع المرصود (سليم لكن يستحق التأكيد):**
- `apps/web/src/api/httpClient.ts` يستخدم `baseUrl: env.VITE_API_URL || '/api'`.
- الخادم يضبط ترويسة `X-API-Version: 1.0` ويتوقّع المسارات تحت `/api/v1/` مع إعادة كتابة `/api/{resource}` تلقائياً.
- العميل يفكّ غلاف `{ success, data, meta }` ويقارن `major.minor` مع ثابت `API_VERSION` من `@alsaqi/shared`.

**الإجراء:** تأكّد أن `VITE_API_URL` في بيئات الواجهة الأمامية يشير إلى أصل الخادم الصحيح (مثلاً `http://localhost:3000/api` للتطوير، حيث الخادم على المنفذ 3000 افتراضياً)، وأن `API_VERSION` في الحزمة المشتركة يطابق `major.minor` للخادم.

---

## ترتيب التنفيذ المقترح
1. FIX-FE-2 و FIX-FE-4 (تنظيف محلي سريع، منخفض المخاطر).
2. FIX-FE-5 (تأكيد إعدادات البيئة).
3. FIX-FE-3 و FIX-FE-1 (معماري — بالتنسيق مع جانب الـ backend).

# تصميم إصلاح تناقضات مصفوفة الامتثال (Compliance Matrix Consistency Fix — Bugfix Design)

## Overview

تتناول هذه الوثيقة تصميم إصلاح مجموعة عيوب التناقض في وحدة «مصفوفة الامتثال»
(Compliance Matrix) ضمن مشروع `alsaqi-backend`. جوهر المشكلة هو وجود **مصدرين
متعارضين للحقيقة** لتعريف جدول `compliance_items`: المخطط المرجعي
`database/schema.sql` (يعرّف أعمدة `type`, `notes`, وتواريخ `DATE`, وقيد `CHECK`
يسمح بـ `partially_compliant`) مقابل ترحيل وقت التشغيل في `src/db/migrations.ts`
(يعرّف `source_type`, `gap_notes`, `category`, `review_date`, `maturity_score`,
`department_id`, `keywords`, `version` كأعمدة `TEXT` بلا قيد `CHECK`). يعتمد الكود
الحي (`ComplianceService`, `routes/compliance.ts`) على أعمدة الترحيل، فبات المخطط
المرجعي عاجزاً عن إعادة إنشاء قاعدة بيانات يعمل عليها الكود.

تتفرّع عن هذا الانجراف عيوب مترابطة: مسار كتابة عام مكرر (`/api/compliance-items`
عبر `createCrudRoutes`) يتعارض مع المسار المخصص (`/api/v1/compliance`)، وقائمة
حقول قديمة في `columnWhitelist.ts` و`crudGenerator.ts`، وقيم حالة امتثال غير
متّسقة (`partial` مقابل `partially_compliant`)، وفجوة صلاحية `View` على مسارات
القراءة، وأخطاء طبقة الخدمة (إرجاع 500 بدل 404، غياب الترقيم، عدم تهريب أحرف
`LIKE`)، ومُعرّف سجل خاطئ في `BaseService.create` تحت PostgreSQL/PGlite، واختبار
تكامل يموّه السلوك الفعلي.

استراتيجية الإصلاح: **توحيد مصدر الحقيقة** على تعريف الترحيل الحي، وإلغاء المسار
المكرر، وتوحيد قيم الحالة، وإغلاق فجوة الصلاحية، وتصحيح أخطاء الخدمة والأساس، مع
**الحفاظ الصارم** على السلوك السليم القائم لكل مدخل لا يحقّق شرط الخطأ. تُعرَّف
الدالة الأصلية قبل الإصلاح بـ **F**، والدالة بعد الإصلاح بـ **F'**.

## Glossary

- **Bug_Condition (C)**: شرط الخطأ — مجموعة المدخلات/الحالات التي تُظهر أحد عيوب التناقض، كما تعرّفها `isBugCondition(X)` في `bugfix.md`.
- **Property (P)**: الخاصية المطلوبة — السلوك الصحيح المتوقّع من F' لكل مدخل يحقّق C.
- **Preservation (الحفظ)**: ضمان أن F'(X) = F(X) لكل مدخل لا يحقّق C (منع التراجع/Regression).
- **مصدر الحقيقة الواحد (Single Source of Truth)**: أن يطابق `database/schema.sql` تعريف `compliance_items` في `src/db/migrations.ts` الذي يعتمده الكود الحي.
- **المسار المعتمد (Canonical Route)**: المسار المخصص `/api/v1/compliance` المُنشأ عبر `createComplianceRoutes` في `src/routes/compliance.ts`، وهو الوحيد المعتمد للكتابة على الجدول.
- **المسار المكرر (Duplicate Route)**: المسار العام `/api/compliance-items` المُولّد عبر `createCrudRoutes`/`generateRoutes` في `src/utils/crudGenerator.ts` لأن `compliance-items` غير مُدرج في `CRUD_EXCLUDED_ROUTES`.
- **ComplianceService**: الخدمة في `src/services/ComplianceService.ts` التي تنفّذ `getAll`, `getById`, `create`, `update`, `softDelete`, `getSummary` على `compliance_items`.
- **BaseService**: طبقة الأساس العامة في `src/services/BaseService.ts` للعمليات CRUD على الجداول المسجّلة.
- **finding_compliance**: جدول الربط بين الملاحظات والامتثال، المُعرّف بصورة متعارضة في `schema.sql` (يشير إلى `central_bank_instructions`, `ON DELETE CASCADE`) والترحيل (يشير إلى `compliance_items`, دون `CASCADE`).

## Bug Details

### Bug Condition

يتجلّى الخطأ عند تحقّق أيٍّ من الفروع التالية: انجراف المخطط بين `schema.sql`
والترحيل، أو قيمة حالة امتثال غير متّسقة عبر الطبقات، أو وصول عبر المسار العام
المكرر، أو كتابة عبر `BaseService` بأعمدة قديمة (`type`/`notes`) أو دون
`source_type`، أو قراءة عبر مسار غير محمي بصلاحية `View`، أو طلب عنصر غير موجود،
أو إنشاء عبر `BaseService` تحت Postgres/PGlite دون `RETURNING`، أو حذف ناعم لعنصر
محذوف مسبقاً أو دون ضبط `deleted_by`، أو طلب قائمة بلا ترقيم، أو بحث يحتوي أحرف
بدل غير مهرّبة.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type ComplianceRequestOrSchemaState
  OUTPUT: boolean

  RETURN
       (X.source = 'schema_recreate' AND X.schemaDefn ≠ X.migrationDefn)        // 1.1
    OR (X.field = 'compliance_status' AND NOT consistentAcrossLayers(X.value))  // 1.2
    OR (X.route = '/api/compliance-items')                                      // 1.3
    OR (X.path = 'BaseService.write'
        AND (usesLegacyColumns(X) OR missing(X.source_type)))                   // 1.4
    OR (X.method = 'GET' AND X.route STARTS WITH '/api/v1/compliance'
        AND NOT X.checksViewPermission)                                         // 1.5
    OR (X.op = 'getById' AND NOT exists(X.id))                                  // 1.6
    OR (X.path = 'BaseService.create' AND X.engine ∈ {Postgres, PGlite})        // 1.8
    OR (X.op = 'softDelete' AND (X.alreadyDeleted OR NOT X.setsDeletedBy))      // 1.11
    OR (X.op = 'getAll' AND X.expectsPagination)                               // 1.12
    OR (X.op = 'getAll' AND containsWildcard(X.search))                        // 1.13
END FUNCTION
```

### Examples

- **انجراف المخطط (1.1)**: إعادة إنشاء القاعدة من `schema.sql` ثم تشغيل `ComplianceService.getAll` → فشل لأن العمود `source_type` غير موجود في تعريف `schema.sql` (الذي يحوي `type`/`notes` فقط). المتوقّع: نجاح التشغيل على مخطط موحّد.
- **حالة غير متّسقة (1.2)**: إرسال `compliance_status = 'partial'` عبر `PATCH /api/v1/compliance/:id/status` → يقبلها مُتحقق Zod ومسار PATCH، لكنها تنتهك قيد `CHECK` في `schema.sql` (الذي يسمح بـ `partially_compliant` فقط). المتوقّع: مجموعة قيم موحّدة عبر كل الطبقات.
- **المسار المكرر (1.3)**: تسجيل المسارين معاً يولّد `POST /api/compliance-items` (عام) و`POST /api/v1/compliance` (مخصص) على الجدول نفسه بسلوك مختلف. المتوقّع: مسار كتابة واحد معتمد.
- **كتابة بأعمدة قديمة (1.4)**: `POST /api/compliance-items` يمرّ عبر `BaseService.create` و`columnWhitelist` الذي يسمح بـ `type`/`notes` فقط ولا يوفّر `source_type NOT NULL` → خطأ قاعدة بيانات. المتوقّع: الكتابة إلى الأعمدة الفعلية فقط.
- **قراءة غير محمية (1.5)**: `GET /api/v1/compliance` يستدعي `authenticate` فقط دون `checkPermission('ComplianceMatrix','View')`، بينما `/api/compliance-items` يفرضها. المتوقّع: فرض `View` على كل مسارات القراءة.
- **عنصر غير موجود (1.6)**: `ComplianceService.getById('non-existent')` يرمي `new Error('NOT_FOUND')` الخام → استجابة 500. المتوقّع: `NotFoundError` → 404.
- **مُعرّف خاطئ (1.8)**: `BaseService.create` يُرجِع `{ id: info.lastInsertRowid }` تحت PGlite → `id = undefined`. المتوقّع: `id` حقيقي عبر `RETURNING id`.
- **حذف ناعم غير آمن (1.11)**: `ComplianceService.softDelete` يضبط `deleted_at` فقط دون `WHERE deleted_at IS NULL` ودون `deleted_by`. المتوقّع: تقييد بـ `deleted_at IS NULL` وضبط `deleted_by`.
- **قائمة بلا ترقيم (1.12)**: `getAll` يُرجِع كل الصفوف. المتوقّع: دعم `page`/`pageSize`.
- **بحث بأحرف بدل (1.13)**: `search = "50%"` يُعامَل `%` كحرف بدل في `LIKE`. المتوقّع: تهريب `%` و`_` ومعاملتها حرفياً.

## Expected Behavior

### Preservation Requirements

**السلوكيات التي يجب ألّا تتغيّر (Unchanged Behaviors):**
- قبول وحفظ قيم `compliance_status` الصالحة الموحّدة (`compliant`, `non_compliant`, `under_review`) كما هي الآن.
- نجاح `POST /api/v1/compliance` مع `source_type` صحيح وإرجاع 201 ومُعرّف العنصر.
- إرجاع `getById` للعنصر الموجود بحقوله المُجمّعة (`responsible_person_name`, `department_name`).
- تطبيق مرشحات `source_type` و`compliance_status` و`search` في `getAll` بصورة صحيحة.
- رفض عمليات الكتابة (`Create`/`Edit`/`Delete`) لمن لا يملك الصلاحية برمز 403.
- إرجاع `getSummary` بالشكل والقيم نفسها `{counts, overdueReview, dueSoon}`.
- استمرار عمل `BaseService.create/update/delete` لكل الجداول الأخرى (غير `compliance_items`) دون تغيير، بما في ذلك منع الإسناد الجماعي (Mass-Assignment).

**النطاق (Scope):**
كل مدخل لا يحقّق `isBugCondition` يجب أن يبقى سلوكه تحت F' مطابقاً تماماً لسلوكه تحت F. يشمل ذلك على وجه الخصوص:
- طلبات الكتابة الصالحة على المسار المخصص بالحقول الفعلية.
- عمليات `BaseService` على الجداول الأخرى (تستخدم `RETURNING` أصلاً في `update`/`delete`).
- مدخلات البحث الخالية من أحرف البدل والطلبات التي لا تتوقّع ترقيماً صريحاً.

> ملاحظة: السلوك الصحيح المتوقّع لكل فرع من فروع شرط الخطأ مُعرّف في قسم **Correctness Properties** أدناه.

## Hypothesized Root Cause

بناءً على تحليل الكود الفعلي، الأسباب الجذرية الأرجح:

1. **مصدران متعارضان لتعريف المخطط (1.1, 1.2)**: لم يُحدَّث `database/schema.sql` ليواكب توسّع الجدول الذي جرى في `src/db/migrations.ts`. فبقي `schema.sql` يحوي `type`, `notes`, تواريخ `DATE`, وقيد `CHECK (... 'partially_compliant')`، بينما الترحيل يحوي `source_type`, `gap_notes`, `category`, `review_date`, `maturity_score`, `department_id`, `keywords`, `version` كـ `TEXT` بلا `CHECK`.

2. **عدم استبعاد المسار العام (1.3, 1.4)**: قائمة `CRUD_EXCLUDED_ROUTES` في `src/utils/crudGenerator.ts` تحوي `['audit-tasks','audit-programs','recommendations','audit-findings']` ولا تحوي `compliance-items`، فيُنفّذ `generateRoutes("compliance_items","compliance-items","ComplianceMatrix")` وينشئ مساراً عاماً مكرراً يعتمد `TABLE_ALLOWED_FIELDS['compliance_items']` و`columnWhitelist` القديمين (`type`/`notes`).

3. **قيم حالة غير موحّدة (1.2)**: مُتحقق Zod في `routes/compliance.ts` (`z.enum([... 'partial' ...])`) ومصفوفة `allowed` في مسار PATCH يستخدمان `partial`، بينما `schema.sql` يفرض `partially_compliant`، والترحيل لا يفرض شيئاً.

4. **خطأ خام بدل خطأ مُصنّف (1.6)**: `ComplianceService.getById` يرمي `new Error('NOT_FOUND')` لا `NotFoundError` (المُعرّف في `src/utils/errors.ts` برمز 404)، فيقع في فرع 500 لمعالج الأخطاء العام.

5. **افتراض دلالات SQLite في الأساس (1.8)**: `BaseService.create` يُرجِع `info.lastInsertRowid` (مفهوم خاص بـ SQLite)؛ في حين أن `update`/`delete` في الملف نفسه تستخدمان `RETURNING id` صحيحاً تحت Postgres/PGlite.

6. **حذف ناعم/تحديث ناقص في الخدمة (1.11, 1.12, 1.13)**: `ComplianceService.softDelete` لا يقيّد بـ `deleted_at IS NULL` ولا يضبط `deleted_by`؛ و`getAll` يُرجِع كل الصفوف بلا `LIMIT/OFFSET` ولا يهرّب `%`/`_` في `LIKE`؛ و`update` يستخدم `COALESCE` يمنع التصفير المقصود.

7. **تعارض تعريف جدول الربط (1.10)**: `finding_compliance` في `schema.sql` يشير `compliance_id` إلى `central_bank_instructions` مع `ON DELETE CASCADE` على `finding_id`، بينما الترحيل يشير إلى `compliance_items` دون `CASCADE`.

8. **اختبار تكامل مُضلِّل (1.7)**: `compliance.integration.test.ts` يموّه `getSummary` بشكل `{compliant, partial, non_compliant, under_review}` المخالف للشكل الفعلي `{counts, overdueReview, dueSoon}`، ولا يختبر 404 ولا تفرّد المسار ولا المخطط الحقيقي.

## Correctness Properties

Property 1: Bug Condition — توحيد مصدر الحقيقة للمخطط

_For any_ حالة `X` حيث `X.source = 'schema_recreate'` (شرط الخطأ في 1.1)، يجب أن
يطابق تعريف `compliance_items` في `database/schema.sql` تعريفه في
`src/db/migrations.ts` (الأعمدة وأنواعها)، بحيث تنجح إعادة إنشاء القاعدة وتشغيل
الكود الحي على مخطط واحد دون فشل.

**Validates: Requirements 2.1**

Property 2: Bug Condition — اتساق قيم حالة الامتثال عبر الطبقات

_For any_ قيمة `compliance_status` مُرسلة، يجب أن تكون مجموعة القيم المسموح بها
موحّدة عبر مُتحقق Zod ومسار PATCH وقيد قاعدة البيانات، فتُقبل القيمة نفسها في كل
الطبقات أو تُرفض بصورة متّسقة في كلٍّ منها دون انتهاك أي قيد `CHECK`.

**Validates: Requirements 2.2**

Property 3: Bug Condition — مسار كتابة واحد معتمد

_For any_ طلب وصول إلى `compliance_items`، يجب أن يُوجد مسار كتابة واحد معتمد
(`/api/v1/compliance`)، وألّا يولّد المسار العام نقطة وصول مكررة على
`/api/compliance-items` (بإدراج `compliance-items` في `CRUD_EXCLUDED_ROUTES`).

**Validates: Requirements 2.3, 2.9**

Property 4: Bug Condition — الكتابة إلى الأعمدة الفعلية فقط

_For any_ عملية كتابة (POST/PUT) على مصفوفة الامتثال، يجب أن يكتب النظام إلى
الأعمدة الموجودة فعلاً ويوفّر العمود الإلزامي `source_type`، وألّا يكتب إلى أعمدة
غير موجودة (`type`, `notes`)؛ وعند الإبقاء على أي مسار عام يجب أن تطابق قائمة
الحقول (`columnWhitelist.ts`, `crudGenerator.ts`) المخطط الحي.

**Validates: Requirements 2.4**

Property 5: Bug Condition — فرض صلاحية View على القراءة

_For any_ طلب `GET` على مسارات `/api/v1/compliance` (القائمة، الملخّص، عنصر
بالمعرّف)، يجب أن يفرض النظام `checkPermission('ComplianceMatrix','View')` بصورة
متّسقة قبل إرجاع البيانات.

**Validates: Requirements 2.5**

Property 6: Bug Condition — 404 للعنصر غير الموجود

_For any_ استدعاء `getById(id)` حيث لا يوجد عنصر بالمعرّف `id`، يجب أن يرمي
النظام `NotFoundError` فتُرجَع الاستجابة برمز HTTP 404 لا 500.

**Validates: Requirements 2.6**

Property 7: Bug Condition — مُعرّف سجل صحيح من BaseService.create

_For any_ إنشاء سجل عبر `BaseService.create` تحت Postgres/PGlite، يجب أن يُرجِع
النظام المُعرّف الحقيقي للسجل المُنشأ (عبر `RETURNING id`)، بحيث يكون `result.id`
معرّفاً (ليس `undefined`) وتحمل الإشعارات `entityId` صحيحاً.

**Validates: Requirements 2.8**

Property 8: Bug Condition — حذف ناعم آمن

_For any_ استدعاء `softDelete(id)`، يجب أن يقيّد النظام التحديث بـ
`WHERE deleted_at IS NULL` (فلا يُعاد حذف عنصر محذوف مسبقاً) وأن يضبط `deleted_by`
بعد توحيد وجود العمود في المخطط.

**Validates: Requirements 2.11**

Property 9: Bug Condition — دعم الترقيم في getAll

_For any_ استدعاء `getAll` يتوقّع ترقيماً، يجب أن يدعم النظام `page`/`pageSize`
(عبر `LIMIT/OFFSET`) بدل إرجاع كل الصفوف.

**Validates: Requirements 2.12**

Property 10: Bug Condition — تهريب أحرف البدل في LIKE

_For any_ نص بحث يحتوي `%` أو `_`، يجب أن يهرّبها النظام في عبارة `LIKE` (مع
`ESCAPE`) فتُعامَل كنص حرفي لا كأحرف بدل.

**Validates: Requirements 2.13**

Property 11: Bug Condition — تعريف جدول الربط الموحّد + اختبار صادق

_For any_ إنشاء `finding_compliance`، يجب أن يكون تعريفه موحّداً بين `schema.sql`
والترحيل (نفس الجدول المرجعي لـ `compliance_id` ونفس سلوك `ON DELETE`)؛ وأن يعكس
اختبار التكامل الشكل الفعلي لـ `getSummary` (`{counts, overdueReview, dueSoon}`)
ويختبر سلوك 404 وتفرّد المسار.

**Validates: Requirements 2.7, 2.10**

Property 12: Preservation — حفظ السلوك السليم القائم

_For any_ مدخل `X` لا يحقّق `isBugCondition(X)`، يجب أن يُنتِج النظام المُصلَح F'
النتيجة نفسها التي يُنتجها النظام الأصلي F، محافظاً على: قبول القيم الصالحة
الموحّدة، ونجاح الإنشاء الصالح (201 + مُعرّف)، وإرجاع العناصر الموجودة بحقولها
المُجمّعة، والتصفية الصحيحة، ورفض غير المخوّلين (403)، وشكل الملخّص، وعمل
`BaseService` لبقية الجداول مع منع الإسناد الجماعي.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

بافتراض صحّة التحليل الجذري أعلاه، تُجرى التغييرات الآتية على الملفات الفعلية،
مع اعتماد تعريف الترحيل الحي مصدراً للحقيقة وإلغاء المسار المكرر.

**1) توحيد المخطط — File: `database/schema.sql`** (يحقّق Property 1, 2)

- إعادة تعريف `CREATE TABLE compliance_items` ليطابق تعريف `src/db/migrations.ts`:
  - استبدال `type TEXT NOT NULL` بـ `source_type TEXT NOT NULL`.
  - استبدال `notes` بـ `gap_notes`، وإضافة `category`, `review_date`, `maturity_score INTEGER CHECK(maturity_score BETWEEN 0 AND 100)`, `department_id UUID REFERENCES org_entities(id)`, `description`, `keywords`, `version`.
  - تحويل `issue_date`/`effective_date`/`review_date` إلى `TEXT` (مطابقةً للترحيل الذي يخزّنها نصياً).
  - **توحيد قيد `compliance_status`**: اعتماد مجموعة القيم النهائية الموحّدة. القرار المعتمد في هذا التصميم هو إسقاط `partial`/`partially_compliant` نهائياً واستخدام `CHECK (compliance_status IN ('compliant','non_compliant','under_review'))` في كلٍّ من `schema.sql` والترحيل، لمطابقة قيم Preservation في المتطلب 3.1.
  - الإبقاء على `deleted_by UUID REFERENCES users(id)` (موجود في `schema.sql`) وإضافته إلى تعريف الترحيل لتوحيد دعم `softDelete`.

**2) توحيد الترحيل — File: `src/db/migrations.ts`** (يحقّق Property 1, 2, 8, 11)

- إضافة قيد `CHECK` على `compliance_status` بالقيم الموحّدة نفسها (عبر `ALTER TABLE ... ADD CONSTRAINT` أو ضمن `CREATE TABLE`).
- إضافة العمود `deleted_by UUID REFERENCES users(id)` إلى تعريف `compliance_items` وإلى قائمة `addColumnIfNotExists`.
- توحيد `finding_compliance`: حسم الجدول المرجعي لـ `compliance_id` (`compliance_items` كما في الترحيل، وهو الأنسب لوحدة الامتثال) وتطبيق `ON DELETE CASCADE` على `finding_id` في الموضعين ليتطابق التعريفان.

**3) إلغاء المسار المكرر — File: `src/utils/crudGenerator.ts`** (يحقّق Property 3, 4)

- إضافة `'compliance-items'` إلى `CRUD_EXCLUDED_ROUTES` بحيث يتخطّى `generateRoutes("compliance_items", "compliance-items", "ComplianceMatrix")` التسجيل (عبر الحارس `if (CRUD_EXCLUDED_ROUTES.includes(routeName)) return;`).
- إن تقرّر مستقبلاً الإبقاء على أي مسار عام: تحديث `TABLE_ALLOWED_FIELDS['compliance_items']` لإزالة `type`/`notes` وإضافة `source_type` والأعمدة الفعلية. (في المسار المعتمد لهذا التصميم: الإلغاء هو الحل.)

**4) توحيد قائمة الأعمدة — File: `src/services/columnWhitelist.ts`** (يحقّق Property 4)

- تحديث مخطط `compliance_items` في `TABLE_WRITE_SCHEMAS` ليطابق الأعمدة الفعلية: استبدال `type`→`source_type`، و`notes`→`gap_notes`، وإضافة `category`, `review_date`, `maturity_score`, `department_id`, `description`, `keywords`, `version`. (يبقى هذا فعّالاً لأي كتابة عبر `BaseService`، ويمنع الإسناد الجماعي بشكل متّسق مع المخطط — مع الحفاظ على عدم السماح بـ `created_by`/`deleted_by`.)

**5) فرض صلاحية View — File: `src/routes/compliance.ts`** (يحقّق Property 5)

- إضافة `checkPermission('ComplianceMatrix','View')` إلى المسارات الثلاثة: `GET /`, `GET /summary`, `GET /:id` (بعد `authenticate` وقبل `asyncHandler`)، أسوةً بمسارات الكتابة.
- توحيد قيم `compliance_status`: تعديل `z.enum` في `itemSchema` ومصفوفة `allowed` في مسار `PATCH /:id/status` لإزالة `'partial'` واعتماد `['compliant','non_compliant','under_review']` فقط.

**6) تصحيح طبقة الخدمة — File: `src/services/ComplianceService.ts`** (يحقّق Property 6, 8, 9, 10)

- استيراد `NotFoundError` من `../utils/errors` واستبدال `throw new Error('NOT_FOUND')` في `getById` بـ `throw new NotFoundError(...)`.
- `softDelete`: تقييد التحديث بـ `WHERE id = ? AND deleted_at IS NULL` وضبط `deleted_by = ?` (تمرير `deletedBy` من المسار `req.user.id`)، وإرجاع مؤشّر عدم وجود (أو رمي `NotFoundError`) عند عدم تأثّر أي صف.
- `getAll`: إضافة معاملي `page`/`pageSize` مع `LIMIT ? OFFSET ?`، وتهريب أحرف البدل في `search` (`%`→`\%`, `_`→`\_`) مع `ESCAPE '\'` في عبارات `LIKE`.
- `update`: السماح بالتصفير المقصود للحقول حيث يلزم بدل `COALESCE` الذي يمنعه (للحقول الاختيارية القابلة للتصفير).

**7) تصحيح طبقة الأساس — File: `src/services/BaseService.ts`** (يحقّق Property 7)

- في `create`: استبدال `INSERT ... ` المنتهي بإرجاع `info.lastInsertRowid` بـ `INSERT ... RETURNING id`، والحصول على `id` من الصف المُعاد (أسوةً بـ `update`/`delete` التي تستخدم `RETURNING` أصلاً)، بحيث يكون `id` و`payload.id` للحدث المُخزّن (`enqueueEvent`) صحيحين.

**8) تصحيح اختبار التكامل — File: `src/routes/__tests__/compliance.integration.test.ts`** (يحقّق Property 11)

- تعديل تمويه `getSummary` ليُرجِع الشكل الفعلي `{ counts: [...], overdueReview: n, dueSoon: m }`، وتعديل التوكيد المقابل.
- إضافة حالة اختبار 404 للعنصر غير الموجود (تموّه `getById` لترمي `NotFoundError`).
- إضافة فرض صلاحية `View` على مسارات القراءة في إعداد الاختبار، والتحقق من تفرّد المسار المعتمد.

## Testing Strategy

### Validation Approach

تتبع الاستراتيجية نهجاً من مرحلتين: أولاً، إظهار أمثلة مضادّة (Counterexamples)
تُبرهن وجود الخطأ على الكود **غير المُصلَح** لتأكيد التحليل الجذري أو دحضه؛ ثم
التحقّق من أن الإصلاح يعمل صحيحاً (Fix Checking) وأنه يحافظ على السلوك القائم
(Preservation Checking).

### Exploratory Bug Condition Checking

**Goal**: إظهار أمثلة مضادّة تُبرهن العيوب **قبل** الإصلاح، وتأكيد/دحض التحليل الجذري. إن دُحض، يلزم إعادة صياغة الفرضية.

**Test Plan**: كتابة اختبارات تُشغَّل على الكود غير المُصلَح لرصد الإخفاقات الفعلية وفهم الجذر، لكل فرع من فروع شرط الخطأ.

**Test Cases**:
1. **انجراف المخطط (1.1)**: إنشاء قاعدة من `database/schema.sql` ثم استدعاء `ComplianceService.getAll` → يفشل لغياب `source_type` (will fail on unfixed code).
2. **حالة غير متّسقة (1.2)**: `PATCH .../status` بـ `partial` على قاعدة من `schema.sql` → انتهاك قيد `CHECK` (will fail on unfixed code).
3. **المسار المكرر (1.3)**: التحقق من تسجيل كلٍّ من `/api/compliance-items` و`/api/v1/compliance` عبر `routeRegistry`/الفحص → وجود نقطتين (will fail on unfixed code).
4. **عنصر غير موجود (1.6)**: `GET /api/v1/compliance/non-existent` → رمز 500 بدل 404 (will fail on unfixed code).
5. **مُعرّف خاطئ (1.8)**: `BaseService.create` تحت PGlite → `result.id === undefined` (will fail on unfixed code).
6. **قراءة غير محمية (1.5)**: مستخدم بلا `View` يستدعي `GET /api/v1/compliance` → ينجح خطأً (will fail on unfixed code).
7. **حذف مكرّر (1.11)**: استدعاء `softDelete` مرتين على العنصر نفسه → لا فرق في السلوك/لا ضبط `deleted_by` (will fail on unfixed code).
8. **بحث بأحرف بدل (1.13)**: `getAll({ search: '50%' })` → معاملة `%` كحرف بدل (may fail on unfixed code).

**Expected Counterexamples**:
- فشل تشغيل الكود الحي على قاعدة من `schema.sql`؛ وجود نقطتي وصول؛ استجابة 500 بدل 404؛ `id` غير معرّف؛ نجاح قراءة غير مخوّلة.
- أسباب محتملة: مصدران للمخطط، غياب `compliance-items` من `CRUD_EXCLUDED_ROUTES`، خطأ خام بدل `NotFoundError`، اعتماد `lastInsertRowid`.

### Fix Checking

**Goal**: التحقق من أن F' يُنتِج السلوك المتوقّع لكل مدخل يحقّق شرط الخطأ.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result ← F'(X)
  ASSERT
       singleSourceOfTruth(compliance_items)         // Property 1  (2.1)
    AND consistentStatusValues(X)                     // Property 2  (2.2)
    AND singleCanonicalRoute(compliance_items)        // Property 3  (2.3, 2.9)
    AND writesOnlyExistingColumns(X)                  // Property 4  (2.4)
    AND enforcesViewPermission(X)                     // Property 5  (2.5)
    AND (X.op = 'getById' AND NOT exists(X.id) ⇒ httpStatus(result) = 404)  // Property 6 (2.6)
    AND definedEntityId(result)                       // Property 7  (2.8)
    AND safeSoftDelete(result)                        // Property 8  (2.11)
    AND supportsPagination(result)                    // Property 9  (2.12)
    AND escapesLikeWildcards(X)                        // Property 10 (2.13)
    AND consistentJunctionDefinition()                // Property 11 (2.10)
    AND testReflectsRealBehavior(X)                   // Property 11 (2.7)
END FOR
```

### Preservation Checking

**Goal**: التحقق من أن F' يُنتِج النتيجة نفسها التي يُنتجها F لكل مدخل لا يحقّق شرط الخطأ.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

**Testing Approach**: يُوصى بالاختبار القائم على الخصائص (Property-Based Testing) لفحص الحفظ لأنه:
- يولّد عدداً كبيراً من الحالات تلقائياً عبر فضاء المدخلات.
- يلتقط الحالات الحدّية التي قد تفوتها اختبارات الوحدة اليدوية.
- يوفّر ضماناً قوياً بأن السلوك لم يتغيّر لكل المدخلات غير المعيبة.

**Test Plan**: رصد سلوك الكود **غير المُصلَح** أولاً للمدخلات غير المعيبة (قيم حالة صالحة، إنشاء صالح، تصفية، صلاحيات)، ثم كتابة اختبارات تلتقط هذا السلوك وتتحقق من بقائه بعد الإصلاح.

**Test Cases**:
1. **حفظ القيم الصالحة (3.1)**: رصد قبول `compliant`/`non_compliant`/`under_review` على الكود الحالي ثم التحقق من استمراره.
2. **حفظ الإنشاء الصالح (3.2)**: `POST /api/v1/compliance` بـ `source_type` صحيح → 201 + مُعرّف، قبل الإصلاح وبعده.
3. **حفظ القراءة المُجمّعة (3.3)**: `getById` لعنصر موجود يُرجِع `responsible_person_name`/`department_name`.
4. **حفظ التصفية (3.4)**: مرشحات `source_type`/`compliance_status`/`search` (بلا أحرف بدل) تُنتج النتائج نفسها.
5. **حفظ الرفض 403 (3.5)**: مستخدم بلا `Create`/`Edit`/`Delete` يُرفض كما هو الآن.
6. **حفظ شكل الملخّص (3.6)**: `getSummary` يُرجِع `{counts, overdueReview, dueSoon}` بالقيم نفسها.
7. **حفظ BaseService لبقية الجداول (3.7)**: إنشاء/تحديث/حذف جداول أخرى دون تغيير، مع منع الإسناد الجماعي.

### Unit Tests

- اختبار `ComplianceService.getById` يرمي `NotFoundError` للعنصر المفقود (404).
- اختبار `getAll` يطبّق `LIMIT/OFFSET` ويهرّب `%`/`_` في `LIKE`.
- اختبار `softDelete` يقيّد بـ `deleted_at IS NULL` ويضبط `deleted_by`، ولا يؤثّر في عنصر محذوف مسبقاً.
- اختبار `BaseService.create` يُرجِع `id` معرّفاً عبر `RETURNING` تحت PGlite.
- اختبار توحيد قيم `compliance_status` في مُتحقق Zod ومسار PATCH.

### Property-Based Tests

- توليد قيم `compliance_status` عشوائية والتحقق من أن مجموعة المقبول/المرفوض موحّدة عبر الطبقات (Property 2).
- توليد نصوص بحث تحتوي `%`/`_` بمواضع عشوائية والتحقق من المعاملة الحرفية (Property 10).
- توليد مدخلات لا تحقّق شرط الخطأ والتحقق من تطابق F(X) = F'(X) (Property 12 — الحفظ)، خاصة عمليات `BaseService` لبقية الجداول.

### Integration Tests

- التدفق الكامل عبر `/api/v1/compliance`: إنشاء → قراءة (مع `View`) → تحديث حالة → حذف ناعم.
- التحقق من وجود مسار واحد فقط (عدم تسجيل `/api/compliance-items` بعد إدراجه في `CRUD_EXCLUDED_ROUTES`).
- التحقق من 401 بلا مصادقة و403 بلا صلاحية `View`/`Create`/`Edit`/`Delete`.
- التحقق من أن `getSummary` يُرجِع `{counts, overdueReview, dueSoon}` وأن العنصر المفقود يُرجِع 404 (تصحيح الاختبار المُضلِّل).

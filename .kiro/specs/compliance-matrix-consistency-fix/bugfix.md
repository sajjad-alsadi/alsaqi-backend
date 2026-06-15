# وثيقة متطلبات إصلاح الأخطاء (Bugfix Requirements)

## Introduction

تتناول هذه الوثيقة إصلاح مجموعة من العيوب والتناقضات في وحدة «مصفوفة الامتثال»
(Compliance Matrix) ضمن مشروع alsaqi-backend. كشف تحليل شامل عن وجود مصدرين
متعارضين لتعريف جدول `compliance_items` (ملف `database/schema.sql` مقابل ترحيل
وقت التشغيل في `src/db/migrations.ts`)، ومسارين متوازيين للكتابة على الجدول
نفسه بمعالجة حقول مختلفة، وعدم اتساق في قيم حالة الامتثال، وفجوات في التحقق من
الصلاحيات، إضافة إلى أخطاء في طبقة الخدمة (إرجاع 500 بدل 404، غياب الترقيم،
عدم تهريب أحرف البحث) وفي طبقة الأساس `BaseService` (مُعرّف سجل غير صحيح تحت
PostgreSQL/PGlite)، فضلاً عن اختبار تكامل مُضلِّل لا يعكس السلوك الفعلي.

هذه العيوب تؤدي إلى فشل إعادة إنشاء قاعدة البيانات من المخطط المرجعي، وإلى أخطاء
عند الكتابة عبر المسار العام، وإلى كشف بيانات الامتثال عبر مسار غير محمي، وإلى
سلوك غير متوقع للواجهة البرمجية. الهدف هو توحيد مصدر الحقيقة، وإصلاح السلوك
الخاطئ، مع الحفاظ على السلوك السليم الحالي دون أي تراجع (Regression).

تُعرَّف الدالة الأصلية قبل الإصلاح بـ **F**، والدالة بعد الإصلاح بـ **F'**.

---

## Bug Analysis

### Current Behavior (Defect)

يصف هذا القسم ما يحدث فعلياً عند تشغيل الكود الحالي.

**حرجة (Critical):**

1.1 حين تُعاد إعادة إنشاء قاعدة البيانات من `database/schema.sql` ثم يُشغَّل الكود الحي، يفشل النظام لأن `schema.sql` يُعرّف الأعمدة `type` و`notes` وتواريخ من نوع `DATE`، بينما يعتمد الكود الحي (`ComplianceService` و`routes/compliance.ts`) على أعمدة الترحيل: `source_type` و`gap_notes` و`category` و`review_date` و`maturity_score` و`department_id` و`keywords` و`version` ذات النوع `TEXT`؛ فيوجد مصدران متعارضان للحقيقة لجدول `compliance_items`.

1.2 حين تُرسل قيمة حالة امتثال `partial` (المقبولة من مُتحقق Zod ومن مسار PATCH) إلى قاعدة بيانات أُنشئت من `schema.sql`، ينتهك النظام قيد `CHECK` لأن المخطط يسمح فقط بـ `partially_compliant`؛ بينما ترحيل وقت التشغيل لا يفرض أي قيد `CHECK` على `compliance_status` إطلاقاً، فتُقبل قيم غير صالحة.

1.3 حين يُسجَّل المساران معاً، يُنشئ النظام نقطتي وصول مختلفتين على الجدول نفسه: المسار المخصص `createComplianceRoutes` على `/api/v1/compliance` والمسار العام `createCrudRoutes` على `/api/compliance-items` (لأن `compliance-items` غير مُدرج في `CRUD_EXCLUDED_ROUTES`)، بمعالجة حقول مختلفة وسلوك مختلف لنفس البيانات.

1.4 حين تُرسل عملية POST أو PUT عبر المسار العام `/api/compliance-items`، يحاول النظام الكتابة عبر `BaseService` باستخدام قائمة الحقول القديمة في `columnWhitelist.ts` (`type` و`notes`) التي لا توجد في المخطط الحي، ولا يوفّر العمود الإلزامي `source_type` (NOT NULL)، فينتج عنه خطأ قاعدة بيانات، ويتعذّر كتابة الأعمدة الجديدة.

1.5 حين يطلب مستخدم بيانات الامتثال عبر مسارات GET في `/api/v1/compliance` (القائمة، الملخّص، عنصر بالمعرّف)، يكتفي النظام باستدعاء `authenticate` دون `checkPermission('ComplianceMatrix','View')`، بينما يفرض المسار `/api/compliance-items` صلاحية `View`؛ فتكون البيانات نفسها محميّة على مسار ومكشوفة على آخر.

**عالية (High):**

1.6 حين يُطلب عنصر امتثال غير موجود عبر `ComplianceService.getById`، يرمي النظام `new Error('NOT_FOUND')` الخام، فتُرجَع الاستجابة برمز HTTP 500 بدل 404.

1.7 حين يُشغَّل اختبار التكامل `compliance.integration.test.ts`, يموّه النظام `ComplianceService` بالكامل ويُرجِع `getSummary` بشكل خاطئ `{compliant, partial, non_compliant, under_review}` مخالفاً للشكل الفعلي `{counts, overdueReview, dueSoon}`، ولا يختبر المخطط الحقيقي ولا المسار المكرر ولا خطأ 500/404.

1.8 حين تُنشأ سجلات عبر `BaseService.create` تحت PGlite/Postgres دون عبارة `RETURNING`، يُرجِع النظام `{ id: info.lastInsertRowid }` (مفهوم خاص بـ SQLite)، فتكون `id` غير معرّفة (`undefined`)، وتحمل إشعارات إنشاء السجل `entityId` مفقوداً.

**متوسطة (Medium):**

1.9 حين يُوصَل إلى الجدول نفسه عبر مسارات مستقلة إضافية، يطبّق النظام منطق حقول خاصاً بكل منها: `GET /api/v1/compliance-items/lookup` في `lookups.ts` و`BulkOperationsService` الذي يربط `compliance-items → compliance_items`؛ فتتعدد نقاط الوصول دون توحيد.

1.10 حين تُحذف ملاحظة تدقيق مرتبطة، يتصرف جدول `finding_compliance` بشكل غير متسق: في `schema.sql` يحمل `ON DELETE CASCADE` على `finding_id` ويشير `compliance_id` إلى `central_bank_instructions`، بينما يُنشئه الترحيل دون `CASCADE` ويشير `compliance_id` إلى `compliance_items`؛ فالجدول المرجعي والسلوك عند الحذف غير متطابقين.

1.11 حين يُحذف عنصر امتثال عبر `softDelete`, لا يضبط النظام `deleted_by` (العمود موجود في `schema.sql` وغير موجود في الترحيل)، ولا يقيّد التحديث بـ `WHERE deleted_at IS NULL` (فيسمح بإعادة الحذف)، كما يمنع نمط `COALESCE` في `update` تصفير حقل عمداً إلى `null`.

1.12 حين تُطلب القائمة عبر `ComplianceService.getAll`, يُرجِع النظام كل الصفوف دون ترقيم (Pagination).

1.13 حين يتضمن نص البحث في `getAll` أحرف البدل `%` أو `_`, لا يهرّبها النظام في عبارة `LIKE`، فتُعامل كأحرف بدل بدل البحث الحرفي.

### Expected Behavior (Correct)

يصف هذا القسم ما ينبغي أن يحدث بعد الإصلاح (F') لكل حالة من حالات العيب أعلاه.

**حرجة (Critical):**

2.1 حين تُعاد إنشاء قاعدة البيانات، يجب أن يكون لجدول `compliance_items` مصدر حقيقة واحد متوافق مع الكود الحي، بحيث يطابق `database/schema.sql` تعريف الترحيل: أعمدة `source_type` و`gap_notes` و`category` و`review_date` و`maturity_score` و`department_id` و`keywords` و`version` بالأنواع نفسها، ولا يفشل إنشاء القاعدة ولا تشغيل الكود الحي.

2.2 حين تُرسل قيمة `compliance_status`, يجب أن تكون مجموعة القيم المسموح بها موحّدة عبر المُتحقق ومسار PATCH وقيد قاعدة البيانات (إن وُجد)، بحيث تُقبل القيمة نفسها في كل الطبقات ولا تنتهك أي قيد `CHECK`، أو تُرفض بصورة متّسقة في كل الطبقات.

2.3 حين يُسجَّل مسار مصفوفة الامتثال، يجب أن يُوجد مسار واحد معتمد للكتابة على `compliance_items`؛ بإضافة `compliance-items` إلى `CRUD_EXCLUDED_ROUTES` بحيث لا يُولّد المسار العام نقطة وصول مكررة، ويبقى المسار المخصص `/api/v1/compliance` هو المعتمد.

2.4 حين تُرسل عملية POST أو PUT على مسار مصفوفة الامتثال المعتمد، يجب أن يكتب النظام إلى الأعمدة الفعلية الموجودة، وأن يوفّر العمود الإلزامي `source_type`, ولا يحاول الكتابة إلى أعمدة غير موجودة (`type` أو `notes`)؛ وإن أُبقي المسار العام، يجب تحديث `columnWhitelist.ts` ليطابق المخطط الحي.

2.5 حين يطلب مستخدم بيانات الامتثال عبر أي مسار GET (القائمة، الملخّص، عنصر بالمعرّف)، يجب أن يفرض النظام `checkPermission('ComplianceMatrix','View')` بصورة متّسقة على كل مسارات القراءة.

**عالية (High):**

2.6 حين يُطلب عنصر امتثال غير موجود، يجب أن يرمي النظام `NotFoundError`، فتُرجَع الاستجابة برمز HTTP 404.

2.7 حين يُشغَّل اختبار التكامل، يجب أن يعكس الشكل الفعلي لـ `getSummary` وهو `{counts, overdueReview, dueSoon}`، وأن يختبر سلوك 404 للعنصر المفقود ووجود مسار واحد فقط، بحيث يكشف العيوب الحقيقية بدل تمويهها.

2.8 حين تُنشأ سجلات عبر `BaseService.create` تحت PGlite/Postgres، يجب أن يُرجِع النظام المُعرّف الحقيقي للسجل المُنشأ (عبر `RETURNING id` أو ما يكافئه)، بحيث تحمل الإشعارات `entityId` صحيحاً وغير مفقود.

**متوسطة (Medium):**

2.9 حين يُوصَل إلى الجدول عبر مسارات مستقلة (`lookup`، العمليات المجمّعة)، يجب أن تعتمد جميعها أسماء الأعمدة الفعلية الموحّدة نفسها وتبقى متّسقة مع المخطط الحي.

2.10 حين يُنشأ جدول `finding_compliance`, يجب أن يكون تعريفه موحّداً بين `schema.sql` والترحيل: نفس سلوك `ON DELETE` ونفس الجدول المرجعي لـ `compliance_id`.

2.11 حين يُحذف عنصر امتثال عبر `softDelete`, يجب أن يضبط النظام `deleted_by` (بعد توحيد وجود العمود)، وأن يقيّد التحديث بـ `WHERE deleted_at IS NULL` لمنع إعادة الحذف، وأن يتيح تصفير الحقول المقصود تصفيرها.

2.12 حين تُطلب القائمة عبر `getAll`, يجب أن يدعم النظام الترقيم (الصفحة وحجم الصفحة) بدل إرجاع كل الصفوف.

2.13 حين يتضمن نص البحث أحرف `%` أو `_`, يجب أن يهرّبها النظام في عبارة `LIKE` بحيث تُعامل كنص حرفي.

### Unchanged Behavior (Regression Prevention)

يصف هذا القسم السلوك السليم الحالي الذي يجب الحفاظ عليه: لكل مدخل لا يحقّق شرط
الخطأ، يجب أن يبقى سلوك F' مطابقاً لسلوك F.

3.1 حين تُرسل قيمة `compliance_status` صالحة وموحّدة (`compliant`, `non_compliant`, `under_review`)، يجب أن يستمر النظام في قبولها وحفظها كما هو الآن.

3.2 حين تُرسل عملية POST صالحة على المسار المخصص `/api/v1/compliance` مع `source_type` صحيح، يجب أن يستمر النظام في إنشاء العنصر بنجاح وإرجاع رمز 201 ومُعرّف العنصر كما هو الآن.

3.3 حين يُطلب عنصر امتثال موجود عبر `getById`, يجب أن يستمر النظام في إرجاعه بحقوله المُجمّعة (اسم المسؤول، اسم القسم) كما هو الآن.

3.4 حين تُطبَّق مرشحات `source_type` أو `compliance_status` أو `search` في `getAll`, يجب أن يستمر النظام في تصفية النتائج بصورة صحيحة كما هو الآن.

3.5 حين يحاول مستخدم بلا صلاحية `Create` أو `Edit` أو `Delete` تنفيذ عملية كتابة على مصفوفة الامتثال، يجب أن يستمر النظام في رفض الطلب برمز 403 كما هو الآن.

3.6 حين تُحسب أرقام الملخّص (التعدادات، المتأخّرة عن المراجعة، المستحقة قريباً)، يجب أن يستمر النظام في إرجاعها بالشكل والقيم نفسها (`{counts, overdueReview, dueSoon}`) كما هو الآن.

3.7 حين تُنشأ أو تُحدّث سجلات لجداول أخرى عبر `BaseService` (غير `compliance_items`)، يجب أن يستمر النظام في العمل دون تغيير، بما في ذلك منع الإسناد الجماعي (Mass-Assignment) عبر قائمة الأعمدة المسموح بها.

---

## اشتقاق شرط الخطأ (Bug Condition Derivation)

### دالة شرط الخطأ (Bug Condition Function)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type ComplianceRequestOrSchemaState
  OUTPUT: boolean

  RETURN
       // انجراف المخطط: تعريف schema.sql لا يطابق الترحيل/الكود الحي
       (X.source = 'schema_recreate' AND X.schemaDefn ≠ X.migrationDefn)
    OR // قيمة حالة غير متّسقة عبر الطبقات
       (X.field = 'compliance_status' AND NOT consistentAcrossLayers(X.value))
    OR // وصول عبر المسار العام المكرر /compliance-items
       (X.route = '/api/compliance-items')
    OR // كتابة عبر BaseService بأعمدة قديمة (type/notes) أو بلا source_type
       (X.path = 'BaseService.write' AND (usesLegacyColumns(X) OR missing(X.source_type)))
    OR // قراءة عبر مسار غير محمي بصلاحية View
       (X.method = 'GET' AND X.route STARTS WITH '/api/v1/compliance' AND NOT X.checksViewPermission)
    OR // طلب عنصر غير موجود
       (X.op = 'getById' AND NOT exists(X.id))
    OR // إنشاء عبر BaseService تحت Postgres/PGlite دون RETURNING
       (X.path = 'BaseService.create' AND X.engine ∈ {Postgres, PGlite})
    OR // حذف ناعم لعنصر محذوف مسبقاً أو دون ضبط deleted_by
       (X.op = 'softDelete' AND (X.alreadyDeleted OR NOT X.setsDeletedBy))
    OR // قائمة دون ترقيم
       (X.op = 'getAll' AND X.expectsPagination)
    OR // بحث يحتوي أحرف بدل غير مهرّبة
       (X.op = 'getAll' AND containsWildcard(X.search))
END FUNCTION
```

### مواصفة الخاصية — فحص الإصلاح (Fix Checking)

```pascal
// Property: Fix Checking
FOR ALL X WHERE isBugCondition(X) DO
  result ← F'(X)
  ASSERT
       singleSourceOfTruth(compliance_items)         // 2.1
    AND consistentStatusValues(X)                     // 2.2
    AND singleCanonicalRoute(compliance_items)        // 2.3, 2.9
    AND writesOnlyExistingColumns(X)                  // 2.4
    AND enforcesViewPermission(X)                     // 2.5
    AND (X.op = 'getById' AND NOT exists(X.id) ⇒ httpStatus(result) = 404)  // 2.6
    AND testReflectsRealBehavior(X)                   // 2.7
    AND definedEntityId(result)                       // 2.8
    AND consistentJunctionDefinition()                // 2.10
    AND safeSoftDelete(result)                        // 2.11
    AND supportsPagination(result)                    // 2.12
    AND escapesLikeWildcards(X)                        // 2.13
END FOR
```

### هدف الحفظ — فحص الحفاظ (Preservation Checking)

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

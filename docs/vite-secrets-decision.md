# قرار موثّق: بقاء `VITE_NETWORK_SECRET` و`VITE_STORAGE_SECRET` قيد الاستخدام

- **المواصفة:** `production-launch-readiness`
- **المتطلب:** 11.9 — "THE program SHALL تسجيل قرار موثّق يحسم ما إذا كان `VITE_NETWORK_SECRET` و`VITE_STORAGE_SECRET` سيبقيان قيد الاستخدام، وSHALL أن يعكس Env_Template ذلك القرار."
- **بند الخطة:** 11.3
- **الحالة:** **القرار — يبقى المتغيران قيد الاستخدام (KEEP)، وموسومان `[REQUIRED]` في `.env.production.example`.**

---

## القرار

يَبقى كلٌّ من `VITE_NETWORK_SECRET` و`VITE_STORAGE_SECRET` **سرّين إنتاجيين إلزاميين (`[REQUIRED]`)** ويُحتفظ بهما في `.env.production.example`. لا يُزالان ولا يُحوَّلان إلى `[OPTIONAL]`.

## المبرّر (مستند إلى مسح الشيفرة)

تُظهر نتائج مسح شجرة `src/` أن المتغيرين مُستهلَكان فعلياً في الخلفية، وليسا متغيّرين معطَّلين (dead):

| المستهلِك (Consumer) | الملف | الدور |
|----------------------|-------|-------|
| **Environment_Validator** | `src/config/envValidator.ts` — `ENV_VAR_DEFINITIONS` | كلاهما معرّف بـ `required: true`؛ `VITE_STORAGE_SECRET` بحدّ أدنى `minLength: 32`، و`VITE_NETWORK_SECRET` موصوف بأنه "HMAC secret for network request signing". كما أنهما مُدرَجان في `sensitiveVars` لتعقيم القيم في رسائل التحقق. |
| **Secrets_Validator** | `src/utils/secretsValidator.ts` — `validateProductionSecrets` / `runSecretsValidation` | يُقيَّمان وفق قواعد قوة Audit_Spec: رفض القيم الافتراضية الضعيفة (`WEAK_DEFAULTS`)، و`VITE_STORAGE_SECRET` بحدّ أدنى 32 حرفاً، و`VITE_NETWORK_SECRET` بلا حدّ أدنى لكن يُرفض إن كان فارغاً أو قيمة افتراضية ضعيفة. |
| **Startup_Sequence** | `src/main.ts` | يُعدّ ضعف/غياب/قِصَر أيٍّ منهما خطأً FATAL في الإنتاج يُنهي العملية برمز خروج غير صفري قبل قبول الاتصالات. |
| **Key_Rotation_Procedure** | `docs/key-rotation-procedure.md` | كلاهما مُدرَج ضمن "أسرار التشفير" الخاضعة لإجراء التدوير المجدول/بعد حادث. |

### ملاحظة عن طبيعة المتغيرين

المتغيران مسبوقان بـ `VITE_` لأنهما **سرّان مشتركان عبر الحدّ بين الواجهة والخلفية** (الواجهة تستخدمهما زمن البناء):
- `VITE_STORAGE_SECRET`: سرّ تشفير التخزين من جهة العميل (client-side storage encryption).
- `VITE_NETWORK_SECRET`: سرّ HMAC لتوقيع طلبات الشبكة بين الواجهة والخلفية.

دور الخلفية تحديداً هو **إنفاذ وجودهما وقوّتهما** كجزء من عقد المصافحة عبر HTTPS (المتطلب 11)، بحيث لا يقدّم النظام حركة مرور إنتاجية بإعداد ناقص أو ضعيف. لذلك يجب أن يبقيا إلزاميين في الخلفية ما دامت الواجهة الإنتاجية تعتمد عليهما.

> **حدّ المسح:** لم يُعثر في خلفية هذا المستودع على مستهلِك تشفير/HMAC **زمن تشغيل** يستخدم هاتين القيمتين مباشرةً لعملية توقيع (توقيع روابط الملفات يستخدم `FILE_ACCESS_SECRET` لا `VITE_NETWORK_SECRET`). ومع ذلك فالمتغيران مُستهلَكان فعلياً عبر طبقتي التحقق (Environment_Validator وSecrets_Validator) وبوابة الإقلاع، ويشكّلان عقداً مع مستودع الواجهة الذي يقوم بالتوقيع/التشفير الفعلي. وعليه فالقرار المنطقي المدعوم بالأدلة هو إبقاؤهما إلزاميين.

## أثر القرار على Env_Template

`.env.production.example` **متوافق مسبقاً** مع هذا القرار ولا يتطلب تغييراً:

```dotenv
# [REQUIRED] Storage encryption secret for client-side encrypted data (minimum 32 characters)
# Type: string (min 32 chars)
VITE_STORAGE_SECRET=replace-with-32-or-more-random-characters-here

# [REQUIRED] HMAC secret for network request signing between frontend and backend
# Type: string
VITE_NETWORK_SECRET=replace-with-strong-hmac-secret-value
```

كلا المتغيرين حاضران وموسومان `[REQUIRED]`، بما يطابق `required: true` في `ENV_VAR_DEFINITIONS` ويجتاز `checkEnvTemplateConsistency` (المتطلب 2). أي تغيير مستقبلي لهذا القرار يجب أن يُحدَّث في ثلاثة مواضع متزامنة: `ENV_VAR_DEFINITIONS`، و`SECRET_RULES` في `secretsValidator.ts`، وهذا القالب.

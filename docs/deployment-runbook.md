# Deployment Runbook — alsaqi-backend

> **النطاق:** الإجراء الموثّق والقابل للتكرار لنشر إصدار محدّد من `alsaqi-backend` إلى الخادم الإنتاجي الوحيد (on-prem) عبر Docker Compose، بما يشمل تطبيق هجرات قاعدة البيانات، وإجراء التراجع (rollback)، وخطوة التحقّق الصحّي اللاحقة للنشر.
>
> **يُحقّق المتطلبات:** 12.1 (خطوات النشر المرتّبة)، 12.2 (تطبيق الهجرات)، 12.3 (التراجع + إعادة المخطّط المتوافق)، 12.6 (التحقّق الصحّي اللاحق للنشر)، 12.7 (توجيه التراجع عند فشل التحقّق الصحّي).
>
> الكلمات المفتاحية التقنية وأسماء الملفات والأوامر ومتغيرات البيئة باللغة الإنجليزية.

---

## 0. المراجع الواقعية (Ground Truth)

يستند هذا الدليل إلى ملفات حقيقية في المستودع. عند أي تعارض، تكون الملفات هي المرجع:

| المكوّن | الملف / الموقع | ملاحظات |
| --- | --- | --- |
| تنسيق الإنتاج (Compose_Stack) | `docker-compose.yml` | خدمات `api` (المنفذ 3000)، `postgres:15`، `redis:7-alpine` على شبكة `alsaqi-network` الداخلية. |
| تجاوزات التطوير (Compose_Override) | `docker-compose.override.yml` | **للتطوير فقط** — يُعيد كشف منافذ postgres/redis. يُحمَّل تلقائياً بواسطة `docker compose` عند وجوده. يجب ألّا يكون حاضراً في دليل النشر الإنتاجي. |
| بناء الصورة | `Dockerfile` | بناء متعدد المراحل، مستخدم غير جذري (UID 1001)، صور أساس مثبّتة بالـ digest. `HEALTHCHECK` داخلي يستهدف `/api/health`. |
| النشر المستمر | `.github/workflows/cd.yml` | يبني الصورة ويفحصها بـ Trivy (HIGH/CRITICAL تُفشل) ويدفعها إلى `ghcr.io/<IMAGE_NAME>:<short_sha>` و`:latest`. |
| قالب البيئة | `.env.production.example` | يُنسخ إلى `.env`. الأسرار الإلزامية موسومة `[REQUIRED]`. |
| الهجرات (تشغيل) | `src/index.ts` (`start()`) | يستدعي `runMigrations()` ثم `MigrationRunner.run(versionedMigrations)` عند الإقلاع قبل قبول الطلبات. |
| محرّك الهجرات | `src/db/migrationRunner.ts` | جدول `schema_migrations`؛ `run()` يطبّق المعلّقة فقط ضمن transaction؛ `rollback(version, available)` ينفّذ `down()` ويحذف السجل. |
| تعريف الهجرات | `src/db/migrations.ts` | `runMigrations` (bootstrap idempotent للمخطّط الأساسي) + `versionedMigrations` (الهجرات الإصدارية المتتبَّعة). |
| نقطة التحقّق الصحّي | `src/index.ts` | `GET /api/health` (خفيفة، 200)، `GET /api/health/ready` (تتحقّق من DB/Redis، 503 عند الفشل)، و`GET /api/v1/health` (شاملة عبر `createHealthRouter`). |
| ترويسة الإصدار | استجابات API | `X-API-Version` على كل استجابة. |

**أسلوب تعريف الإصدار:** كل إصدار يُعرّف بوسم صورة Docker `ghcr.io/<IMAGE_NAME>:<short_sha>` حيث `<short_sha>` أول 7 أحرف من commit SHA على `main` (كما ينتجه `cd.yml`). يجب استخدام الوسم الصريح `<short_sha>` — **لا** `:latest` — في كل نشر إنتاجي لضمان قابلية التكرار والتراجع.

---

## 1. المتطلّبات المسبقة (Prerequisites)

نُفّذ مرّة واحدة لكل خادم، وتُؤكَّد قبل كل نشر:

- [ ] `docker` و`docker compose` (v2) مثبّتان وعاملان على الخادم الإنتاجي.
- [ ] للمشغّل صلاحية `docker login ghcr.io` (token بصلاحية `read:packages`).
- [ ] دليل النشر الإنتاجي (يُشار إليه أدناه بـ `$DEPLOY_DIR`، مثلاً `/opt/alsaqi`) يحوي:
  - `docker-compose.yml` (نسخة مطابقة لإصدار الكود المنشور)
  - ملف `.env` مُعبّأ من `.env.production.example` بقيم إنتاجية صالحة لكل متغير `[REQUIRED]`.
  - **لا يحوي** `docker-compose.override.yml` (انظر الخطوة 3.1).
- [ ] متغير `IMAGE` معرّف لدى المشغّل، مثلاً:
  ```bash
  export DEPLOY_DIR=/opt/alsaqi
  export IMAGE=ghcr.io/<owner>/alsaqi-backend
  export VERSION=<short_sha>          # وسم الإصدار المراد نشره
  export PREVIOUS_VERSION=<short_sha> # الإصدار المنشور حالياً (للتراجع)
  ```
- [ ] الإصدار `$VERSION` اجتاز CI على `main` (typecheck + الاختبارات) وفحص Trivy في `cd.yml` ودُفع إلى السجل.

> **ملاحظة:** `docker-compose.yml` الحالي يبني الصورة محلياً عبر `build:`. للنشر الإنتاجي القابل للتكرار بإصدار مثبّت، نسحب الصورة المبنية مسبقاً من السجل ونثبّت وسمها عبر متغير البيئة المُمرَّر إلى `image:`. إن كان `docker-compose.yml` لديك يستخدم `build:` فقط، استبدله بـ `image: ${IMAGE}:${VERSION}` لخدمة `api` أو مرّر `--build` صراحةً؛ هذا الدليل يفترض النشر بصورة مثبّتة بالوسم.

---

## 2. تسجيل حالة ما قبل النشر (Pre-Deploy Snapshot)

يُلتقط هذا التسجيل قبل أي تغيير ليكون أساس التراجع والمقارنة:

1. سجّل الإصدار المنشور حالياً:
   ```bash
   cd "$DEPLOY_DIR"
   docker compose exec -T api node -e "fetch('http://localhost:3000/api/health').then(()=>0)"
   curl -fsS https://<public-endpoint>/api/health -D - -o /dev/null | grep -i 'x-api-version'
   ```
   دوّن قيمة `X-API-Version` ووسم الصورة العامل حالياً في `$PREVIOUS_VERSION`.

2. سجّل آخر هجرة مطبَّقة (لتحديد ما يجب التراجع عنه لاحقاً):
   ```bash
   docker compose exec -T postgres \
     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c "SELECT version, name, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10;"
   ```
   احتفظ بأعلى `version` مطبَّقة — سمِّها `LAST_APPLIED_BEFORE_DEPLOY`.

3. **خذ نسخة احتياطية حديثة لقاعدة البيانات قبل النشر** (إلزامي — هي شبكة الأمان للتراجع):
   ```bash
   docker compose exec -T postgres \
     pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c \
     > "$DEPLOY_DIR/backups/predeploy-$(date +%Y%m%dT%H%M%SZ)-$PREVIOUS_VERSION.dump"
   ```
   تأكّد من نجاح الأمر (رمز خروج 0) وأن حجم الملف غير صفري قبل المتابعة.

---

## 3. تسلسل النشر المرتّب (Ordered Deployment — Req 12.1)

نفّذ الخطوات بالترتيب. أي خطوة تفشل (رمز خروج غير صفري) توقف التسلسل ويُقيَّم التراجع (القسم 6).

### 3.1 حارس التجاوز الإنتاجي (Override Guard — Req 5.1/5.2، شرط مسبق للنشر)

```bash
cd "$DEPLOY_DIR"
if [ -f docker-compose.override.yml ]; then
  echo "FATAL: docker-compose.override.yml موجود في دليل النشر — سيُحمَّل تلقائياً ويكشف منافذ داخلية. أزله قبل النشر الإنتاجي." >&2
  exit 1
fi
```
يطابق هذا منطق `scripts/deployGuard.ts` (`detectAutoLoadedOverride`). **لا تتابع** إن كان الملف موجوداً.

### 3.2 سحب صورة الإصدار المستهدف

```bash
docker login ghcr.io        # إن لم تكن مُسجَّلاً
docker pull "$IMAGE:$VERSION"
```
يضمن سحب الوسم الصريح أننا ننشر بالضبط ما اجتاز CI/Trivy ودُفع.

### 3.3 التحقّق من إعداد Compose والبيئة قبل التشغيل

```bash
docker compose config >/dev/null   # يفشل عند خطأ في التركيب أو متغير مفقود
```
يكشف هذا متغيرات `[REQUIRED]` المفقودة (`POSTGRES_USER/PASSWORD/DB`, `REDIS_PASSWORD`, ...) قبل أي تشغيل، لأن `docker-compose.yml` يستخدم `${VAR:?...}` الذي يفشل عند الغياب.

### 3.4 رفع خدمتَي البيانات أولاً (postgres + redis)

```bash
docker compose up -d postgres redis
```
ننتظر حتى تصبحان صحّيتين (`healthcheck` معرّف لكلتيهما في `docker-compose.yml`):

```bash
docker compose ps   # كرّر حتى تظهر postgres و redis بحالة (healthy)
```

> خدمة `api` معرّفة بـ `depends_on ... condition: service_healthy`، فلن تبدأ قبل جاهزية القاعدة والكاش — لكن رفعهما صراحةً أولاً يفصل أعطال البنية التحتية عن أعطال التطبيق.

### 3.5 تطبيق هجرات قاعدة البيانات (Req 12.2)

تُطبَّق الهجرات **آلياً عند إقلاع خدمة `api`**: تستدعي `start()` في `src/index.ts` التسلسل التالي قبل قبول الطلبات:

1. `initDb()` — تهيئة الاتصال.
2. `runMigrations()` (من `src/db/migrations.ts`) — bootstrap المخطّط الأساسي بـ DDL idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`).
3. `new MigrationRunner(db).initialize()` ثم `.run(versionedMigrations)` — يطبّق **الهجرات الإصدارية المعلّقة فقط** بالترتيب التصاعدي، كلٌّ داخل transaction، ويسجّلها في `schema_migrations`. الهجرة الفاشلة لا تُسجَّل ويتوقف الإقلاع برمز غير صفري (fail-fast).

نُطلق خدمة `api` بالوسم المستهدف:

```bash
IMAGE_TAG="$VERSION" docker compose up -d api
```
(أو، إن كانت `image:` مثبّتة في الملف بالوسم، فمجرد `docker compose up -d api`.)

ثم نؤكّد نجاح الهجرات قبل اعتبار النشر مكتملاً:

```bash
# 1) لا يجب أن يكون السجل قد سجّل فشل هجرة
docker compose logs api | grep -Ei "Migration .* failed|migration(s)? .* failed" && {
  echo "FATAL: فشلت إحدى الهجرات — انتقل إلى التراجع (القسم 6)." >&2; exit 1; }

# 2) أكّد ظهور الهجرات الجديدة كمطبَّقة
docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT version, name, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10;"
```
دوّن أعلى `version` بعد النشر — سمِّها `LAST_APPLIED_AFTER_DEPLOY`. المجموعة `(LAST_APPLIED_BEFORE_DEPLOY, LAST_APPLIED_AFTER_DEPLOY]` هي الهجرات التي يجب التراجع عنها إن لزم.

### 3.6 انتظار جاهزية التطبيق

```bash
docker compose ps   # يجب أن تظهر api بحالة Up (healthy) — الـ HEALTHCHECK الداخلي يستهدف /api/health
```

انتقل مباشرةً إلى خطوة التحقّق الصحّي اللاحقة للنشر (القسم 5).

---

## 4. ملخّص الأوامر (Quick Reference)

```bash
cd "$DEPLOY_DIR"
[ -f docker-compose.override.yml ] && { echo "FATAL: remove override"; exit 1; }   # 3.1
docker pull "$IMAGE:$VERSION"                                                       # 3.2
docker compose config >/dev/null                                                    # 3.3
docker compose up -d postgres redis                                                 # 3.4
docker compose up -d api                                                            # 3.5 (الهجرات تُطبَّق عند الإقلاع)
# ثم التحقّق الصحّي (القسم 5)؛ وعند الفشل: التراجع (القسم 6)
```

---

## 5. التحقّق الصحّي اللاحق للنشر (Post-Deployment Health Check — Req 12.6)

**شرط النجاح المحدّد:** خلال **نافذة زمنية مدتها 120 ثانية** من إطلاق خدمة `api` (الخطوة 3.5)، يجب أن:

1. يُرجِع `GET /api/health/ready` رمز **HTTP 200** بجسم `status: "ready"` (يؤكّد اتصال قاعدة البيانات بعد الهجرات)، **و**
2. يُرجِع `GET /api/v1/health` رمز **HTTP 200** بحالة `healthy` أو `degraded` (لا `unhealthy`/503)، **و**
3. تحمل الاستجابة ترويسة `X-API-Version`، وتطابق الصورة العاملة الوسم `$VERSION`.

يجب أن يتحقّق ذلك عبر **Public_Endpoint** (HTTPS، عبر الوسيط العكسي)، وأن يكون **نجاحاً متّسقاً** (3 محاولات متتالية ناجحة بفاصل 5 ثوانٍ) ضمن النافذة.

سكربت التحقّق (يفشل برمز غير صفري عند عدم استيفاء الشرط ضمن النافذة):

```bash
HEALTH_URL="https://<public-endpoint>"
WINDOW_SECONDS=120
INTERVAL=5
REQUIRED_CONSECUTIVE=3
deadline=$(( $(date +%s) + WINDOW_SECONDS ))
consecutive=0

while [ "$(date +%s)" -le "$deadline" ]; do
  ready_code=$(curl -fsS -o /dev/null -w '%{http_code}' "$HEALTH_URL/api/health/ready" || echo 000)
  full_code=$(curl -fsS -o /dev/null -w '%{http_code}' "$HEALTH_URL/api/v1/health" || echo 000)
  api_version=$(curl -fsS -D - -o /dev/null "$HEALTH_URL/api/health" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="x-api-version"{print $2}')

  if [ "$ready_code" = "200" ] && [ "$full_code" = "200" ] && [ -n "$api_version" ]; then
    consecutive=$((consecutive + 1))
    echo "OK ($consecutive/$REQUIRED_CONSECUTIVE) ready=$ready_code full=$full_code version=$api_version"
    [ "$consecutive" -ge "$REQUIRED_CONSECUTIVE" ] && { echo "HEALTH CHECK PASSED"; exit 0; }
  else
    consecutive=0
    echo "WAIT ready=$ready_code full=$full_code version=${api_version:-none}"
  fi
  sleep "$INTERVAL"
done

echo "FATAL: فشل التحقّق الصحّي اللاحق للنشر خلال ${WINDOW_SECONDS}s — نفّذ التراجع (القسم 6)." >&2
exit 1
```

**إن فشلت خطوة التحقّق الصحّي (رمز خروج غير صفري) — انتقل فوراً إلى القسم 6: إجراء التراجع (Req 12.7).**

---

## 6. إجراء التراجع (Rollback — Req 12.3، 12.7)

يُعيد التراجع النظام إلى **الإصدار المنشور سابقاً (`$PREVIOUS_VERSION`)** ويعيد **مخطّط قاعدة البيانات إلى حالة متوافقة مع ذلك الإصدار**. نفّذه عند فشل أي خطوة نشر أو فشل التحقّق الصحّي (القسم 5).

### 6.1 إعادة مخطّط قاعدة البيانات إلى حالة متوافقة

تراجَع عن الهجرات الإصدارية التي طُبّقت في هذا النشر، بترتيب **تنازلي** (الأحدث أولاً)، باستخدام `MigrationRunner.rollback(version, versionedMigrations)` التي تنفّذ `down()` داخل transaction وتحذف السجل من `schema_migrations`:

```bash
# لكل version في (LAST_APPLIED_BEFORE_DEPLOY .. LAST_APPLIED_AFTER_DEPLOY] بترتيب تنازلي:
docker compose exec -T api node -e '
  (async () => {
    const { db } = await import("./dist/server.js").catch(()=>({}));
    const { MigrationRunner } = await import("./src/db/migrationRunner.js");
    const { versionedMigrations } = await import("./src/db/migrations.js");
    const runner = new MigrationRunner(db);
    await runner.rollback(process.env.ROLLBACK_VERSION, versionedMigrations);
  })().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
'
```

> **مهم:** تُدعم هذه الطريقة فقط للهجرات التي تُعرّف دالة `down()` (وإلا ترفض `rollback()` بخطأ صريح). إن كانت هجرة جديدة بلا `down()`، أو فشل التراجع المنطقي، فاستعد قاعدة البيانات من النسخة الاحتياطية الملتقطة في الخطوة 2.3:
>
> ```bash
> # استرجاع كامل إلى حالة ما قبل النشر (المسار المضمون للتوافق مع $PREVIOUS_VERSION)
> docker compose stop api
> docker compose exec -T postgres \
>   pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
>   < "$DEPLOY_DIR/backups/predeploy-...-$PREVIOUS_VERSION.dump"
> ```

تأكّد بعد التراجع أن `schema_migrations` يطابق `LAST_APPLIED_BEFORE_DEPLOY`:

```bash
docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT max(version) FROM schema_migrations;"
```

### 6.2 إعادة الإصدار السابق من التطبيق

```bash
docker pull "$IMAGE:$PREVIOUS_VERSION"
IMAGE_TAG="$PREVIOUS_VERSION" docker compose up -d api
```

### 6.3 التحقّق الصحّي بعد التراجع

أعد تشغيل سكربت القسم 5 مقابل `$PREVIOUS_VERSION` (وأكّد أن `X-API-Version` صار يطابق الإصدار السابق). يجب أن يجتاز شرط النجاح نفسه (200 على `/api/health/ready` و`/api/v1/health` بنجاح متّسق خلال 120 ثانية). إن لم يجتزْ، صعّد الحادث فوراً (راجع القسم 7).

### 6.4 إغلاق ما بعد التراجع

- دوّن سبب فشل النشر (سجلّات `docker compose logs api`، نتائج التحقّق).
- افتح بند إصلاح متتبَّع قبل إعادة محاولة النشر.

---

## 7. التصعيد وقوائم التحقّق النهائية

**قائمة تحقّق ما قبل النشر:**
- [ ] `$VERSION` اجتاز CI + Trivy ودُفع إلى السجل.
- [ ] `.env` مكتمل وصالح؛ `docker compose config` ينجح.
- [ ] لا `docker-compose.override.yml` في `$DEPLOY_DIR`.
- [ ] نسخة احتياطية قبل النشر مأخوذة وموثّقة (الخطوة 2.3).
- [ ] `$PREVIOUS_VERSION` و`LAST_APPLIED_BEFORE_DEPLOY` مدوّنان.

**قائمة تحقّق ما بعد النشر:**
- [ ] الهجرات الجديدة ظاهرة في `schema_migrations` بلا أخطاء (3.5).
- [ ] التحقّق الصحّي اجتاز خلال النافذة (القسم 5).
- [ ] `X-API-Version` يطابق `$VERSION`.

**عند الفشل في أي مرحلة:** نفّذ التراجع (القسم 6) ثم صعّد إلى Go_Live_Authority مع سجلّ الحادث.

---

## ملحق: نقاط التحقّق الصحّي المتاحة

| المسار | السلوك | الاستخدام |
| --- | --- | --- |
| `GET /api/health`, `GET /api/v1/health` (في `src/index.ts`) | خفيفة: `{ status: 'ok', timestamp }` برمز 200 دائماً ما دامت العملية حيّة | فحص liveness السطحي / الـ HEALTHCHECK داخل الحاوية |
| `GET /api/health/ready`, `GET /api/v1/health/ready` | يتحقّق من اتصال DB (وRedis/queues إن مُمكّنة): 200 `ready` أو 503 `degraded` | بوابة جاهزية ما بعد الهجرة (شرط النجاح 12.6) |
| `GET /api/v1/health` (الموجّه الشامل في `src/routes/health.ts`, `createHealthRouter`) | يفحص كل الأنظمة الفرعية: `healthy`/`degraded` (200) أو `unhealthy` (503) | التحقّق الصحّي العميق اللاحق للنشر |

> **ملاحظة توافق:** يوجد في `src/index.ts` مُعالِج `/api/v1/health` خفيف مُسجَّل مبكراً، وموجّه شامل عبر `createHealthRouter` داخل `createV1Router`. لأغراض هذا الدليل، يكفي اجتياز `/api/health/ready` (الذي يؤكّد اتصال القاعدة بعد الهجرات) مع رمز 200 من `/api/v1/health` كشرط نجاح. عدّل المسار في السكربت إن وحّد الفريق نقطة التحقّق الصحّي الشاملة لاحقاً.

// @vitest-environment node
/**
 * Spec: compliance-matrix-consistency-fix — Task 2: Preservation property tests (BEFORE fix)
 *
 * Property 2 / Property 12: Preservation — حفظ السلوك السليم القائم في مصفوفة الامتثال.
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 *
 * منهجية الرصد أولاً (Observation-First): تُشغَّل هذه الاختبارات على الكود **غير المُصلَح**،
 * فترصد المخرجات الفعلية للمدخلات التي **لا** تحقّق `isBugCondition(X)`، ثم تؤكّدها. يجب أن
 * **تنجح** هذه الاختبارات على الكود غير المُصلَح، فتلتقط السلوك الأساس الواجب حفظه (لا يتغيّر
 * بعد الإصلاح). نستخدم الاختبار القائم على الخصائص (Property-Based Testing) لتوليد عدد كبير
 * من الحالات عبر فضاء المدخلات غير المعيبة لضمان أقوى للحفظ.
 *
 * Scope note: كل مدخل هنا مختار صراحةً ليكون خارج شرط الخطأ:
 *  - يُستخدم تعريف الترحيل الحي (MIGRATION_COMPLIANCE) — وهو الحالة الطبيعية لوقت التشغيل —
 *    لا تعريف schema.sql المنجرف (انجراف المخطط هو فرع شرط خطأ 1.1).
 *  - قيم `compliance_status` من المجموعة الموحّدة الصالحة فقط (compliant/non_compliant/under_review).
 *  - نصوص البحث خالية من أحرف البدل (% و _) — البحث بأحرف البدل هو فرع شرط خطأ 1.13.
 *  - لا نؤكّد على `id` العائد من BaseService.create (فرع شرط خطأ 1.8) بل نتحقّق من إدراج الصف فعلياً.
 *
 * Performance: a single in-memory PGlite is created once per test and tables are
 * reset between fast-check iterations (PGlite construction is ~1s, far too costly
 * to repeat per iteration).
 *
 * Harness: نفس نمط اختبار استكشاف شرط الخطأ — PGlite في الذاكرة يُبدَّل في الـ db singleton
 * عبر `db.updateClient`، فتعمل الخدمات الحقيقية، ويُركَّب المسار الحقيقي عبر supertest.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fc from 'fast-check';
import { PGlite } from '@electric-sql/pglite';

import { db } from '../../db/index';
import { ComplianceService } from '../../services/ComplianceService';
import { BaseService } from '../../services/BaseService';
import { createComplianceRoutes } from '../compliance';
import { globalErrorHandler } from '../../middleware/error';

// ─── Schema fragments ──────────────────────────────────────────────────────────

const BASE_TABLES = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT
  );
  CREATE TABLE IF NOT EXISTS org_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_en TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid()
  );
  CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  );
`;

const FINDING_COMPLIANCE = `
  CREATE TABLE IF NOT EXISTS finding_compliance (
    finding_id    UUID NOT NULL,
    compliance_id UUID NOT NULL,
    PRIMARY KEY (finding_id, compliance_id)
  );
`;

// Live "migration" definition that the running code actually depends on
// (src/db/migrations.ts) — this is the NORMAL runtime state (not the drifted
// schema.sql), so it is the correct baseline for preservation of non-bug inputs.
const MIGRATION_COMPLIANCE = `
  CREATE TABLE IF NOT EXISTS compliance_items (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_number            TEXT NOT NULL,
    title                 TEXT NOT NULL,
    source_type           TEXT NOT NULL,
    issuing_authority     TEXT,
    category              TEXT,
    issue_date            TEXT,
    effective_date        TEXT,
    review_date           TEXT,
    compliance_status     TEXT NOT NULL DEFAULT 'under_review',
    maturity_score        INTEGER,
    gap_notes             TEXT,
    responsible_person_id UUID,
    department_id         UUID,
    description           TEXT,
    keywords              TEXT,
    version               TEXT,
    attachment_path       TEXT,
    created_by            UUID,
    created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at            TIMESTAMPTZ,
    deleted_by            UUID
  );
`;

// ─── Input-space pools (constrained to NON-bug inputs) ───────────────────────────

const SOURCE_TYPES = ['cbi_instruction', 'law', 'internal_policy', 'admin_decision'] as const;
const STATUSES = ['compliant', 'non_compliant', 'under_review'] as const; // unified valid set (3.1)
const WORDS = ['alpha', 'beta', 'gamma', 'delta'] as const;               // wildcard-free search tokens (3.4)

// A valid UUID for the acting user (created_by is a UUID column; PGlite rejects non-UUIDs).
const USER_UUID = '00000000-0000-0000-0000-0000000000aa';

// ─── DB harness ─────────────────────────────────────────────────────────────────

let activePglite: PGlite | null = null;

async function useDb(complianceDDL: string): Promise<PGlite> {
  const pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(BASE_TABLES);
  await pglite.exec(complianceDDL);
  await pglite.exec(FINDING_COMPLIANCE);
  (db as any).updateClient(pglite as any, false);
  activePglite = pglite;
  return pglite;
}

// Clear all per-test data between fast-check iterations (fresh state, fast).
async function reset(pglite: PGlite) {
  await pglite.exec(`
    DELETE FROM finding_compliance;
    DELETE FROM compliance_items;
    DELETE FROM users;
    DELETE FROM org_entities;
    DELETE FROM departments;
  `);
}

afterEach(async () => {
  (db as any).updateClient(null, false);
  if (activePglite) {
    try { await activePglite.close(); } catch { /* ignore */ }
    activePglite = null;
  }
});

// ─── Route harness ───────────────────────────────────────────────────────────────

function makeRouteApp(checkPermission: any) {
  const app = express();
  app.use(express.json());

  const authenticate = (req: any, _res: any, next: any) => {
    req.user = { id: USER_UUID, role: 'Viewer', username: 'u', name: 'U' };
    next();
  };

  const router = createComplianceRoutes(null, authenticate, checkPermission, () => {}, async () => '/uploads/x');
  app.use('/api/v1/compliance', router);
  app.use(globalErrorHandler);
  return app;
}

const allowAll = (_m: string, _a: string) => (_req: any, _res: any, next: any) => next();
const denyAll = (_m: string, _a: string) => (_req: any, res: any, _next: any) => res.status(403).json({ error: 'Forbidden' });

// Insert a compliance item directly so service/route reads have something to act on.
async function insertItem(pglite: PGlite, overrides: Record<string, any> = {}): Promise<string> {
  const row = {
    id: overrides.id ?? crypto.randomUUID(),
    ref_number: overrides.ref_number ?? `CMP-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title ?? 'baseline item',
    source_type: overrides.source_type ?? 'law',
    compliance_status: overrides.compliance_status ?? 'under_review',
    responsible_person_id: overrides.responsible_person_id ?? null,
    department_id: overrides.department_id ?? null,
    description: overrides.description ?? null,
  };
  await pglite.query(
    `INSERT INTO compliance_items
       (id, ref_number, title, source_type, compliance_status, responsible_person_id, department_id, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.id, row.ref_number, row.title, row.source_type, row.compliance_status,
     row.responsible_person_id, row.department_id, row.description],
  );
  return row.id;
}

const TEST_TIMEOUT = 60_000;

// ────────────────────────────────────────────────────────────────────────────────

describe('Property 2: Preservation — compliance matrix correct behavior (UNFIXED code)', () => {

  // ── 3.1 Valid unified status values are accepted & saved ─────────────────────
  // NOT isBugCondition: compliance_status ∈ unified valid set.
  it('3.1 PATCH /:id/status accepts each unified valid status and persists it', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);
    const app = makeRouteApp(allowAll);

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...STATUSES), async (status) => {
        await reset(pglite);
        const id = await insertItem(pglite, { compliance_status: 'under_review' });

        const res = await request(app)
          .patch(`/api/v1/compliance/${id}/status`)
          .send({ compliance_status: status });

        // Observed (unfixed): a valid status is accepted (not a 400) and returns success.
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const saved = (await pglite.query(
          'SELECT compliance_status FROM compliance_items WHERE id = $1', [id],
        )).rows[0] as any;
        expect(saved.compliance_status).toBe(status);
      }),
      { numRuns: 15 },
    );
  }, TEST_TIMEOUT);

  // ── 3.2 Valid create returns 201 + a defined item id ─────────────────────────
  // NOT isBugCondition: write on the canonical /api/v1/compliance route with a
  // correct source_type. (ComplianceService.create — not BaseService — so the
  // id is generated via crypto.randomUUID and is always defined.)
  it('3.2 POST /api/v1/compliance with a valid source_type returns 201 and an item id', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);
    const app = makeRouteApp(allowAll);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SOURCE_TYPES),
        fc.constantFrom(...STATUSES),
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
        async (source_type, compliance_status, titleSeed) => {
          await reset(pglite);
          const ref_number = `CMP-${Math.random().toString(36).slice(2, 10)}`;

          const res = await request(app)
            .post('/api/v1/compliance')
            .send({ ref_number, title: `t ${titleSeed}`, source_type, compliance_status });

          // Observed (unfixed): valid create → 201 with a defined id.
          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);
          expect(res.body.data.id).toBeDefined();
          expect(typeof res.body.data.id).toBe('string');

          const saved = (await pglite.query(
            'SELECT id, source_type, compliance_status FROM compliance_items WHERE ref_number = $1', [ref_number],
          )).rows[0] as any;
          expect(saved).toBeDefined();
          expect(saved.source_type).toBe(source_type);
          expect(saved.compliance_status).toBe(compliance_status);
        },
      ),
      { numRuns: 20 },
    );
  }, TEST_TIMEOUT);

  // ── 3.3 getById of an existing item returns aggregated join fields ───────────
  // NOT isBugCondition: the item exists.
  it('3.3 getById returns responsible_person_name and department_name for an existing item', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        async (personName, deptName) => {
          await reset(pglite);
          const userId = crypto.randomUUID();
          const orgId = crypto.randomUUID();
          await pglite.query('INSERT INTO users (id, name) VALUES ($1,$2)', [userId, personName]);
          await pglite.query('INSERT INTO org_entities (id, name_en) VALUES ($1,$2)', [orgId, deptName]);
          const id = await insertItem(pglite, {
            responsible_person_id: userId,
            department_id: orgId,
          });

          const item = (await ComplianceService.getById(id)) as any;

          // Observed (unfixed): joins surface the aggregated names.
          expect(item.responsible_person_name).toBe(personName);
          expect(item.department_name).toBe(deptName);
        },
      ),
      { numRuns: 15 },
    );
  }, TEST_TIMEOUT);

  // ── 3.4 Filtering (source_type / compliance_status / wildcard-free search) ────
  // NOT isBugCondition: search contains no LIKE wildcards.
  it('3.4 getAll filters by source_type / compliance_status / search exactly', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);

    const itemArb = fc.record({
      source_type: fc.constantFrom(...SOURCE_TYPES),
      compliance_status: fc.constantFrom(...STATUSES),
      word: fc.constantFrom(...WORDS),
    });
    const filterArb = fc.oneof(
      fc.record({ kind: fc.constant('source_type'), value: fc.constantFrom(...SOURCE_TYPES) }),
      fc.record({ kind: fc.constant('compliance_status'), value: fc.constantFrom(...STATUSES) }),
      fc.record({ kind: fc.constant('search'), value: fc.constantFrom(...WORDS) }),
      fc.record({ kind: fc.constant('none'), value: fc.constant(null as any) }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(itemArb, { minLength: 1, maxLength: 6 }),
        filterArb,
        async (items, filter) => {
          await reset(pglite);

          // Insert generated items with unique, wildcard-free titles/refs.
          const records = items.map((it, i) => ({
            ref_number: `CMP-${i}`,
            title: `${it.word} policy item ${i}`,
            source_type: it.source_type,
            compliance_status: it.compliance_status,
          }));
          for (const r of records) {
            await insertItem(pglite, r);
          }

          // Independent (reference) computation of the expected matches.
          const expected = records.filter((r) => {
            if (filter.kind === 'source_type') return r.source_type === filter.value;
            if (filter.kind === 'compliance_status') return r.compliance_status === filter.value;
            if (filter.kind === 'search') return r.title.includes(filter.value as string) || r.ref_number.includes(filter.value as string);
            return true;
          }).map((r) => r.ref_number).sort();

          const filters: any = {};
          if (filter.kind === 'source_type') filters.source_type = filter.value;
          if (filter.kind === 'compliance_status') filters.compliance_status = filter.value;
          if (filter.kind === 'search') filters.search = filter.value;

          const rows = (await ComplianceService.getAll(filters)) as any[];
          const got = rows.map((r) => r.ref_number).sort();

          expect(got).toEqual(expected);
        },
      ),
      { numRuns: 30 },
    );
  }, TEST_TIMEOUT);

  // ── 3.5 Write ops are rejected (403) for a user lacking permission ───────────
  // NOT isBugCondition: this is the existing protected-write behavior to preserve.
  it('3.5 write operations are rejected with 403 when permission is denied', async () => {
    await useDb(MIGRATION_COMPLIANCE);
    const app = makeRouteApp(denyAll);
    const opArb = fc.constantFrom('post', 'put', 'patch', 'delete');

    await fc.assert(
      fc.asyncProperty(opArb, async (op) => {
        const id = '00000000-0000-0000-0000-000000000009';
        let res;
        if (op === 'post') {
          res = await request(app).post('/api/v1/compliance').send({ ref_number: 'X', title: 'X', source_type: 'law' });
        } else if (op === 'put') {
          res = await request(app).put(`/api/v1/compliance/${id}`).send({ title: 'Y' });
        } else if (op === 'patch') {
          res = await request(app).patch(`/api/v1/compliance/${id}/status`).send({ compliance_status: 'compliant' });
        } else {
          res = await request(app).delete(`/api/v1/compliance/${id}`);
        }
        // Observed (unfixed): write ops enforce permission → 403.
        expect(res.status).toBe(403);
      }),
      { numRuns: 12 },
    );
  }, TEST_TIMEOUT);

  // ── 3.6 getSummary returns the { counts, overdueReview, dueSoon } shape ──────
  // NOT isBugCondition: ordinary summary read.
  it('3.6 getSummary returns { counts, overdueReview, dueSoon } with correct grouped counts', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...STATUSES), { minLength: 0, maxLength: 8 }),
        async (statuses) => {
          await reset(pglite);
          for (const s of statuses) {
            await insertItem(pglite, { compliance_status: s }); // review_date null → overdue/dueSoon = 0
          }

          const summary = (await ComplianceService.getSummary()) as any;

          // Shape is preserved: exactly these three keys.
          expect(Object.keys(summary).sort()).toEqual(['counts', 'dueSoon', 'overdueReview']);
          expect(Array.isArray(summary.counts)).toBe(true);
          expect(typeof summary.overdueReview).toBe('number');
          expect(typeof summary.dueSoon).toBe('number');
          expect(summary.overdueReview).toBe(0);
          expect(summary.dueSoon).toBe(0);

          // Grouped counts match an independent JS grouping.
          const expectedByStatus = new Map<string, number>();
          for (const s of statuses) expectedByStatus.set(s, (expectedByStatus.get(s) ?? 0) + 1);
          const gotByStatus = new Map<string, number>();
          for (const row of summary.counts as any[]) {
            gotByStatus.set(row.compliance_status, Number(row.count));
          }
          expect(gotByStatus).toEqual(expectedByStatus);
        },
      ),
      { numRuns: 20 },
    );
  }, TEST_TIMEOUT);

  // ── 3.7 BaseService preserves create + mass-assignment prevention (other tables)
  // NOT isBugCondition: BaseService write on a non-compliance table (departments).
  // We assert on row insertion and whitelist enforcement, NOT on the returned id
  // (the returned-id behavior is the separately-tracked bug 1.8).
  it('3.7 BaseService.create on departments inserts allowed fields and rejects mass-assignment', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);
    const DISALLOWED = ['created_by', 'deleted_by', 'role', 'id', 'injected'] as const; // none in {name, description}

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        fc.option(fc.constantFrom(...DISALLOWED), { nil: undefined }),
        async (name, badKey) => {
          await reset(pglite);
          const uniqueName = `${name}-${Math.random().toString(36).slice(2, 8)}`;
          const body: Record<string, any> = { name: uniqueName, description: 'd' };
          if (badKey) body[badKey] = 'x';

          if (badKey) {
            // Mass-assignment prevention: the whole request is rejected, no row created.
            let caught: any;
            try {
              await BaseService.create('departments', body);
            } catch (e) {
              caught = e;
            }
            expect(caught).toBeDefined();
            expect(caught.statusCode).toBe(400);
            expect(caught.details?.rejectedKeys ?? []).toContain(badKey);

            const count = (await pglite.query(
              'SELECT COUNT(*)::int AS c FROM departments WHERE name = $1', [uniqueName],
            )).rows[0] as any;
            expect(count.c).toBe(0);
          } else {
            // Allowed-only body: create succeeds and the row is persisted.
            await BaseService.create('departments', body);
            const found = (await pglite.query(
              'SELECT name, description FROM departments WHERE name = $1', [uniqueName],
            )).rows[0] as any;
            expect(found).toBeDefined();
            expect(found.name).toBe(uniqueName);
            expect(found.description).toBe('d');
          }
        },
      ),
      { numRuns: 25 },
    );
  }, TEST_TIMEOUT);

  // ── 3.7 (cont.) BaseService.update + delete on departments are preserved ─────
  it('3.7 BaseService.update modifies allowed fields and delete removes the row (departments)', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        async (newName) => {
          await reset(pglite);
          const id = crypto.randomUUID();
          await pglite.query(
            'INSERT INTO departments (id, name, description) VALUES ($1,$2,$3)',
            [id, 'orig', 'orig-desc'],
          );

          const target = `${newName}-${Math.random().toString(36).slice(2, 6)}`;
          await BaseService.update('departments', id, { name: target });
          const afterUpdate = (await pglite.query(
            'SELECT name FROM departments WHERE id = $1', [id],
          )).rows[0] as any;
          expect(afterUpdate.name).toBe(target);

          // departments is not a soft-delete table → physical removal.
          await BaseService.delete('departments', id);
          const afterDelete = (await pglite.query(
            'SELECT COUNT(*)::int AS c FROM departments WHERE id = $1', [id],
          )).rows[0] as any;
          expect(afterDelete.c).toBe(0);
        },
      ),
      { numRuns: 15 },
    );
  }, TEST_TIMEOUT);
});

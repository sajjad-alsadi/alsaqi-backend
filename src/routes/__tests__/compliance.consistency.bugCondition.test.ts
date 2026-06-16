// @vitest-environment node
/**
 * Spec: compliance-matrix-consistency-fix — Task 1: Bug Condition Exploration Test (BEFORE fix)
 *
 * Property 1: Bug Condition — إظهار عيوب التناقض في مصفوفة الامتثال.
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.11, 2.13
 *
 * هذا اختبار استكشافي لشرط الخطأ (Exploratory Bug Condition Checking). كل حالة هنا
 * تُرمّز السلوك المتوقّع (Expected Behavior) من قسم Correctness Properties في التصميم،
 * وهي **مصمّمة لتفشل على الكود غير المُصلَح** — والفشل يؤكّد وجود العيوب ويكشف أمثلة
 * مضادّة (Counterexamples). لا تُصلَح هذه الاختبارات الآن؛ ستتحوّل لاحقاً (المهمة 3.9)
 * إلى أداة تحقّق من الإصلاح (Fix Checking) حين تنجح.
 *
 * نهج مُوجَّه (Scoped/Directed): العيوب حتمية، فتُوجَّه كل حالة إلى الفرع المحدّد من
 * `isBugCondition(X)` لضمان قابلية إعادة الإنتاج.
 *
 * Strategy: defects span two layers, so the test exercises both:
 *  - DB/service layer: a fresh in-memory PGlite instance is swapped into the shared
 *    `db` singleton (via `db.updateClient`) so the REAL ComplianceService / BaseService
 *    run against a controlled schema (the legacy `database/schema.sql` definition for the
 *    schema-drift case, or the live migration definition otherwise).
 *  - Route layer: the REAL `createComplianceRoutes` router is mounted with supertest and
 *    stub auth/permission middleware so each route's own logic (permission enforcement,
 *    status-value acceptance) is what is exercised.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';

import { db } from '../../db/index';
import { ComplianceService } from '../../services/ComplianceService';
import { BaseService } from '../../services/BaseService';
import { createComplianceRoutes } from '../compliance';
import { CRUD_EXCLUDED_ROUTES } from '../../utils/crudGenerator';

// Each test builds a fresh in-memory PGlite database from a full schema before
// exercising the real service/route code. That DB build is inherently slow
// (~3s) and, under parallel suite load, can exceed the default 5000ms per-test
// timeout — a test-harness limitation, not a product/schema regression (the
// schema loads cleanly in isolation). Raise the timeout for this file so the
// DB-backed tests are not flaky under load.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

import { globalErrorHandler } from '../../middleware/error';

// ─── Schema fragments ──────────────────────────────────────────────────────────

// Dependency tables referenced by ComplianceService joins / subqueries.
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
// (src/db/migrations.ts). `deleted_by` is included to reflect the post-fix unified
// schema (design change-set 3.1/3.2), so the soft-delete property can be expressed.
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

// Reference definition from database/schema.sql AFTER unification (design change-set 3.1):
// schema.sql is now the single source of truth and matches the live migration —
// it carries `source_type`/`department_id`/`gap_notes`/etc and a CHECK constraint
// limited to the unified value set ('compliant','non_compliant','under_review').
// A DB built from this definition must let the live ComplianceService code run.
const SCHEMA_SQL_COMPLIANCE = `
  CREATE TABLE IF NOT EXISTS compliance_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_number TEXT NOT NULL,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    issuing_authority TEXT,
    category TEXT,
    issue_date TEXT,
    effective_date TEXT,
    review_date TEXT,
    compliance_status TEXT NOT NULL DEFAULT 'under_review'
      CHECK (compliance_status IN ('compliant', 'non_compliant', 'under_review')),
    maturity_score INTEGER CHECK (maturity_score BETWEEN 0 AND 100),
    gap_notes TEXT,
    responsible_person_id UUID REFERENCES users(id),
    department_id UUID REFERENCES org_entities(id),
    description TEXT,
    keywords TEXT,
    version TEXT,
    attachment_path TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
  );
`;

const VALID_ABSENT_UUID = '00000000-0000-0000-0000-000000000001';
// A valid UUID for the acting user. `deleted_by` is a UUID column, so the acting
// user id passed to softDelete must be a well-formed UUID (not a placeholder string).
const ACTING_USER_UUID = '00000000-0000-0000-0000-0000000000aa';

// ─── DB harness ─────────────────────────────────────────────────────────────────

let activePglite: PGlite | null = null;

/**
 * Spins up a fresh in-memory PGlite, applies the base tables + the supplied
 * compliance_items definition + finding_compliance, and swaps it into the shared
 * `db` singleton so the real services run against it.
 */
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
    req.user = { id: 'user-1', role: 'Viewer', username: 'u', name: 'U' };
    next();
  };

  const router = createComplianceRoutes(null, authenticate, checkPermission, () => {}, async () => '/uploads/x');
  app.use('/api/v1/compliance', router);
  app.use(globalErrorHandler);
  return app;
}

// ────────────────────────────────────────────────────────────────────────────────

describe('Property 1: Bug Condition exploration — compliance matrix consistency (BEFORE fix)', () => {

  // ── 1.1 Schema drift (Req 2.1) ──────────────────────────────────────────────
  // isBugCondition: X.source = 'schema_recreate' AND X.schemaDefn ≠ X.migrationDefn
  // Property 1: singleSourceOfTruth(compliance_items)
  it('1.1 ComplianceService.getAll succeeds against a DB created from database/schema.sql', async () => {
    await useDb(SCHEMA_SQL_COMPLIANCE);
    // Expected (correct, post-fix): a single unified schema lets the live code run.
    await expect(ComplianceService.getAll()).resolves.toBeDefined();
  });

  // ── 1.13 Wildcard search not escaped (Req 2.13) ─────────────────────────────
  // isBugCondition: X.op = 'getAll' AND containsWildcard(X.search)
  // Property 10: escapesLikeWildcards(X)
  it('1.13 getAll({ search: "50%" }) treats % literally, not as a LIKE wildcard', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);
    await pglite.exec(`
      INSERT INTO compliance_items (id, ref_number, title, source_type, compliance_status)
      VALUES (gen_random_uuid(), 'CMP-A', 'value is 50% complete', 'law', 'under_review');
      INSERT INTO compliance_items (id, ref_number, title, source_type, compliance_status)
      VALUES (gen_random_uuid(), 'CMP-B', 'value is 500 dollars', 'law', 'under_review');
    `);
    const rows = (await ComplianceService.getAll({ search: '50%' })) as any[];
    // Expected (correct): only the row literally containing "50%" matches.
    expect(rows).toHaveLength(1);
    expect(rows[0].ref_number).toBe('CMP-A');
  });

  // ── 1.11 Unsafe soft delete (Req 2.11) ──────────────────────────────────────
  // isBugCondition: X.op = 'softDelete' AND (X.alreadyDeleted OR NOT X.setsDeletedBy)
  // Property 8: safeSoftDelete(result)
  it('1.11 softDelete sets deleted_by and guards against re-deleting an already-deleted item', async () => {
    const pglite = await useDb(MIGRATION_COMPLIANCE);
    await pglite.exec(`
      INSERT INTO compliance_items (id, ref_number, title, source_type, compliance_status)
      VALUES ('${VALID_ABSENT_UUID}', 'CMP-D', 'deletable', 'law', 'under_review');
    `);

    // Expected (correct): softDelete records who deleted the row (deleted_by).
    await (ComplianceService as any).softDelete(VALID_ABSENT_UUID, ACTING_USER_UUID);

    const row = (await pglite.query(
      'SELECT deleted_at, deleted_by FROM compliance_items WHERE id = $1',
      [VALID_ABSENT_UUID],
    )).rows[0] as any;

    expect(row.deleted_at).not.toBeNull();
    // Expected (correct): deleted_by is populated with the acting user's id.
    expect(row.deleted_by).toBe(ACTING_USER_UUID);
  });

  // ── 1.6 Not-found returns 500 instead of 404 (Req 2.6) ──────────────────────
  // isBugCondition: X.op = 'getById' AND NOT exists(X.id)
  // Property 6: 404 for a missing item
  it('1.6 getById of a non-existent item throws a 404-mapped (NotFoundError) error', async () => {
    await useDb(MIGRATION_COMPLIANCE);
    let caught: any;
    try {
      await ComplianceService.getById(VALID_ABSENT_UUID);
    } catch (e) {
      caught = e;
    }
    expect(caught, 'getById should throw for a missing item').toBeDefined();
    // Expected (correct): a NotFoundError (statusCode 404), not a raw Error -> 500.
    expect(caught.statusCode).toBe(404);
  });

  // ── 1.8 BaseService.create returns the real generated id (Req 2.8) ───────────
  // isBugCondition: X.path = 'BaseService.create' AND X.engine ∈ {Postgres, PGlite}
  // Property 7: definedEntityId(result)
  it('1.8 BaseService.create under PGlite returns a defined id (not undefined)', async () => {
    await useDb(MIGRATION_COMPLIANCE);
    const result = (await BaseService.create('departments', { name: 'Compliance Dept' })) as any;
    // Expected (correct): the created record carries its real, defined id.
    expect(result.id).toBeDefined();
    expect(result.id).not.toBeNull();
  });

  // ── 1.3 Duplicate route (Req 2.3) ───────────────────────────────────────────
  // isBugCondition: X.route = '/api/compliance-items'
  // Property 3: singleCanonicalRoute(compliance_items)
  it('1.3 compliance-items is removed from generic CRUD routes (single canonical route)', () => {
    // Expected (correct): the generateRoutes call for compliance-items was
    // removed entirely from crudGenerator.ts, leaving /api/v1/compliance as
    // the sole canonical write path. CRUD_EXCLUDED_ROUTES is now empty since
    // dead calls were removed rather than just excluded.
    expect(CRUD_EXCLUDED_ROUTES).not.toContain('compliance-items');
    expect(CRUD_EXCLUDED_ROUTES).toHaveLength(0);
  });

  // ── 1.5 Unprotected read (Req 2.5) ──────────────────────────────────────────
  // isBugCondition: X.method = 'GET' AND route starts with /api/v1/compliance AND NOT checksViewPermission
  // Property 5: enforcesViewPermission(X)
  it('1.5 GET /api/v1/compliance enforces ComplianceMatrix/View permission', async () => {
    await useDb(MIGRATION_COMPLIANCE);
    const denyView = (_module: string, _action: string) =>
      (_req: any, res: any, _next: any) => res.status(403).json({ error: 'Forbidden' });

    const app = makeRouteApp(denyView);
    const res = await request(app).get('/api/v1/compliance');
    // Expected (correct): a user without View permission is rejected with 403.
    expect(res.status).toBe(403);
  });

  // ── 1.2 Inconsistent status value across layers (Req 2.2) ────────────────────
  // isBugCondition: X.field = 'compliance_status' AND NOT consistentAcrossLayers(X.value)
  // Property 2: consistentStatusValues(X)
  it('1.2 PATCH /:id/status rejects the inconsistent value "partial" with 400', async () => {
    await useDb(MIGRATION_COMPLIANCE);
    const allow = (_module: string, _action: string) =>
      (_req: any, _res: any, next: any) => next();

    const app = makeRouteApp(allow);
    const res = await request(app)
      .patch(`/api/v1/compliance/${VALID_ABSENT_UUID}/status`)
      .send({ compliance_status: 'partial' });
    // Expected (correct): "partial" is not part of the unified value set and is rejected
    // consistently at the route layer (matching the DB constraint and the validator).
    expect(res.status).toBe(400);
  });
});

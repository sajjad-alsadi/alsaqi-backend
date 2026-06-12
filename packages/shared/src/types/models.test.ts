/**
 * Tests for the synchronized shared Models_File (FIX-BE-1).
 *
 * Covers Requirement 1.11: the Backend `models.ts` must contain the 8 new
 * interfaces and be byte-for-byte identical to the Frontend copy (comments,
 * declaration ordering, and whitespace included).
 *
 * Spec: .kiro/specs/backend-consistency-fixes (task 1.2)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Type-level imports — these are erased at runtime, so the assignments below
// act as a compile-time assertion that every interface is exported from the
// package root. If any export is missing or its shape changes, `tsc` fails.
import type {
  DashboardStats,
  AuditProgressByType,
  RiskLevelBreakdown,
  Role,
  Permission,
  UserSession,
  JobTitle,
  UserManagementSettings,
} from '../index';

// Runtime import of the package entry point. This confirms the module graph
// (index -> types/models, validators, constants, ...) loads and compiles.
import * as shared from '../index';

const here = dirname(fileURLToPath(import.meta.url)); // packages/shared/src/types
const repoRoot = resolve(here, '..', '..', '..', '..'); // <repo>/alsaqi-backend
const backendModelsPath = resolve(here, 'models.ts');
const docsPath = join(repoRoot, 'docs', 'consistency-fixes-backend.md');

const NEW_INTERFACES = [
  'DashboardStats',
  'AuditProgressByType',
  'RiskLevelBreakdown',
  'Role',
  'Permission',
  'UserSession',
  'JobTitle',
  'UserManagementSettings',
] as const;

/** Resolve a reachable Frontend copy of models.ts, or null if not available. */
function resolveFrontendModelsPath(): string | null {
  const candidates = [
    process.env.FRONTEND_MODELS_PATH,
    join(repoRoot, '..', 'alsaqi-frontend', 'packages', 'shared', 'src', 'types', 'models.ts'),
    join(repoRoot, '..', '..', 'alsaqi-frontend', 'packages', 'shared', 'src', 'types', 'models.ts'),
    join(repoRoot, '..', 'alsaqi-frontend', 'src', 'types', 'models.ts'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extract the documented FIX-BE-1 canonical interface block from the docs. */
function extractDocumentedBlock(): string {
  const docs = readFileSync(docsPath, 'utf8');
  const fence = docs.match(/```ts\r?\n([\s\S]*?)```/);
  if (!fence) throw new Error('Could not locate the FIX-BE-1 ```ts code block in ' + docsPath);
  return fence[1].replace(/\r?\n$/, '');
}

describe('FIX-BE-1: synchronized Models_File exports (Requirement 1.11)', () => {
  it('compiles and loads the package root module without throwing', () => {
    // The runtime import above succeeded if we reach here.
    expect(shared).toBeTypeOf('object');
  });

  it('exports all 8 new interfaces from the package root (type-level)', () => {
    // Compile-time assertions: each variable is typed by an interface imported
    // from the package root. If the export were missing, `tsc` would not type-check.
    const dashboardStats: DashboardStats = {
      audits: { total: 0, completed: 0, progress_by_type: [] },
      findings: { summary: { open: 0, high_risk_open: 0 } },
      recommendations: { open: 0, overdue: 0 },
      risks: { summary: { total: 0, high: 0 } },
      correspondence: { incoming_total: 0, outgoing_total: 0, pending_responses: 0 },
      compliance: { total: 0 },
      activity: [],
    };
    const progress: AuditProgressByType = { type: 'Financial', planned: 1, completed: 0 };
    const breakdown: RiskLevelBreakdown = { level: 'High', count: 2 };
    const role: Role = { id: 1, name: 'Admin' };
    const permission: Permission = { id: 'p1', module: 'users', action: 'read' };
    const session: UserSession = { id: 1, user_id: 2 };
    const jobTitle: JobTitle = { id: 1, name: 'Auditor' };
    const settings: UserManagementSettings = { password_min_length: 8 };

    // Runtime touch so the values are not elided and the test asserts something.
    expect([
      dashboardStats,
      progress,
      breakdown,
      role,
      permission,
      session,
      jobTitle,
      settings,
    ]).toHaveLength(8);
  });

  it('declares and exports each of the 8 interfaces in models.ts', () => {
    const source = readFileSync(backendModelsPath, 'utf8');
    for (const name of NEW_INTERFACES) {
      expect(
        source.includes(`export interface ${name}`),
        `Expected "export interface ${name}" to be present in models.ts`,
      ).toBe(true);
    }
  });

  it('re-exports the Models_File from the package root index', () => {
    const indexSource = readFileSync(resolve(here, '..', 'index.ts'), 'utf8');
    expect(indexSource).toMatch(/export \* from ['"]\.\/types\/models['"]/);
  });
});

describe('FIX-BE-1: Models_File byte-for-byte identity (Requirement 1.11)', () => {
  it('is byte-for-byte identical to the Frontend copy, or matches the documented reference', () => {
    const backendBytes = readFileSync(backendModelsPath);
    const frontendPath = resolveFrontendModelsPath();

    if (frontendPath) {
      // Preferred path: a real Frontend copy is reachable — full-file byte compare.
      const frontendBytes = readFileSync(frontendPath);
      expect(
        Buffer.compare(backendBytes, frontendBytes),
        `Backend models.ts (${backendModelsPath}) differs from Frontend copy (${frontendPath}). ` +
          'They must be byte-for-byte identical (comments, ordering, whitespace included).',
      ).toBe(0);
      return;
    }

    // Fallback: the Frontend repo is not reachable in this workspace. Validate the
    // appended FIX-BE-1 interface block against the documented canonical reference
    // (which mirrors the Frontend copy) byte-for-byte, rather than failing.
    // eslint-disable-next-line no-console
    console.warn(
      '[models.test] Frontend models.ts not reachable; falling back to the documented ' +
        'canonical FIX-BE-1 block in docs/consistency-fixes-backend.md for byte comparison. ' +
        'Set FRONTEND_MODELS_PATH to enable full-file comparison.',
    );

    const documentedBlock = extractDocumentedBlock();
    const backendText = backendBytes.toString('utf8');
    expect(
      backendText.includes(documentedBlock),
      'The appended FIX-BE-1 interface block in models.ts must match the documented ' +
        'canonical reference (docs/consistency-fixes-backend.md) byte-for-byte.',
    ).toBe(true);
  });
});

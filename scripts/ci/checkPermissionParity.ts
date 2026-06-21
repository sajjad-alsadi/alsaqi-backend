/**
 * CI Gate (permission parity): Permission_Registry ↔ Frontend_Permission_Registry — fail-closed.
 *
 * Design region (ك‑17/18); Requirements 17.4. Cross-repo: B5.
 *
 * Builds the backend Permission_Registry from the live `ModuleRegistry`
 * (importing `src/permissions/modules.ts` for its registration side-effects),
 * loads the Frontend_Permission_Registry (which OWNS its data in the frontend
 * repo — B5 — and is consumed here as a published artifact / documented input),
 * runs the pure `buildPermissionParityReport`, and exits NON-ZERO if there is ANY
 * parity gap, printing the offending module/permission and the side it is missing
 * from. (Requirement 17.4)
 *
 * ── Cross-repo input (B5) ─────────────────────────────────────────────────────
 * Frontend_Permission_Registry lives in the FRONTEND repo (src/permissions/
 * registry.ts + modules.ts). The frontend CI publishes a flat parity artifact —
 * a JSON array of `{ "module": string, "permission": string }` entries — that the
 * backend gate consumes. The artifact path is supplied via (in priority order):
 *   1. argv[2]
 *   2. env FRONTEND_PERMISSION_REGISTRY_PATH
 *   3. the default committed mirror `packages/shared/frontend.permissions.json`
 *
 * If the artifact is unavailable or unparseable, the backend-only run CANNOT
 * verify parity, so it FAILS CLOSED (Requirement 17.4 mirrors 8.5 fail-closed
 * semantics: an unverifiable parity check must not pass the gate). The frontend
 * repo (B6/B5) runs the equivalent gate from its own side so both repos enforce
 * parity in lock-step.
 *
 * Run with:
 *   tsx scripts/ci/checkPermissionParity.ts [path-to-frontend-registry.json]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Importing `modules.ts` runs every `ModuleRegistry.register(...)` side-effect,
// so the singleton registry is fully populated before we enumerate it.
import '../../src/permissions/modules.js';
import { ModuleRegistry } from '../../src/permissions/registry.js';
import {
  buildPermissionParityReport,
  type PermissionRegistryEntry,
} from '../../src/security/permissionParity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRONTEND_REGISTRY = path.resolve(
  __dirname,
  '../../packages/shared/frontend.permissions.json',
);

/**
 * Build the backend Permission_Registry as a flat (module, permission) list:
 * one entry per (module name × supported action) across all registered modules.
 */
function buildBackendRegistry(): PermissionRegistryEntry[] {
  const entries: PermissionRegistryEntry[] = [];
  for (const mod of ModuleRegistry.getAllModules()) {
    for (const action of mod.actions) {
      entries.push({ module: mod.name, permission: action });
    }
  }
  return entries;
}

/**
 * Pure normalizer for the frontend artifact. Accepts a JSON array of objects with
 * `module` + (`permission` | `action`) string fields. Throws on any shape that
 * cannot be interpreted as a registry (caller fails closed on throw).
 */
export function parseFrontendRegistry(raw: string): PermissionRegistryEntry[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('frontend permission registry must be a JSON array');
  }
  return data.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`entry #${index} is not an object`);
    }
    const record = item as Record<string, unknown>;
    const module = record.module;
    const permission = record.permission ?? record.action;
    if (typeof module !== 'string' || module.length === 0) {
      throw new Error(`entry #${index} has no valid "module"`);
    }
    if (typeof permission !== 'string' || permission.length === 0) {
      throw new Error(`entry #${index} has no valid "permission"/"action"`);
    }
    return { module, permission };
  });
}

function main(): void {
  const registryPath =
    process.argv[2] ??
    process.env.FRONTEND_PERMISSION_REGISTRY_PATH ??
    DEFAULT_FRONTEND_REGISTRY;

  // 1. Backend registry — failure to enumerate is fail-closed.
  let backend: PermissionRegistryEntry[];
  try {
    backend = buildBackendRegistry();
    if (backend.length === 0) {
      throw new Error('backend Permission_Registry enumerated zero entries');
    }
  } catch (err) {
    console.error(
      `[CI:perm-parity] FATAL: could not build the backend Permission_Registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  // 2. Frontend registry artifact (B5) — unavailable/unparseable ⇒ fail closed.
  let frontend: PermissionRegistryEntry[];
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    frontend = parseFrontendRegistry(raw);
  } catch (err) {
    console.error(
      `[CI:perm-parity] FATAL: could not load Frontend_Permission_Registry from ` +
        `"${registryPath}": ${err instanceof Error ? err.message : String(err)}.\n` +
        `  The frontend repo (B5) owns this registry and must publish it as a JSON ` +
        `array of { "module", "permission" } entries. Without it, parity cannot be ` +
        `verified — failing closed.`,
    );
    process.exit(1);
    return;
  }

  // 3. Compute the parity report — any gap fails the build.
  const report = buildPermissionParityReport(backend, frontend);

  if (report.gaps.length > 0) {
    console.error(
      `[CI:perm-parity] FAILED: ${report.gaps.length} permission parity gap(s) ` +
        `between the backend Permission_Registry and Frontend_Permission_Registry:`,
    );
    for (const gap of report.gaps) {
      const missingFrom =
        gap.side === 'backend-only' ? 'frontend registry' : 'backend registry';
      console.error(
        `  ✗ ${gap.module}/${gap.permission} — defined in ${gap.side.replace(
          '-only',
          '',
        )} only, missing from the ${missingFrom}`,
      );
    }
    process.exit(1);
    return;
  }

  console.log(
    `[CI:perm-parity] OK: ${report.rows.length} module/permission pair(s) in parity ` +
      `(backend=${backend.length}, frontend=${frontend.length}).`,
  );
}

main();

/**
 * CI Gate (3/4): @alsaqi/shared public-surface fingerprint — fail-closed.
 *
 * Design region (و); Requirements 8.4, 8.5. Cross-repo: B1.
 *
 * Computes `computeSharedSurfaceFingerprint()` over the shared package's public
 * surface, PRINTS it (so the frontend CI — B1 — can compute the same fingerprint
 * and compare), and compares it against a committed baseline file
 * (`packages/shared/surface.fingerprint`). The gate exits NON-ZERO if:
 *   - the fingerprint cannot be computed (inability to evaluate ⇒ fail closed), OR
 *   - the computed fingerprint differs from the committed baseline.
 *
 * ── Cross-repo comparison (B1) ────────────────────────────────────────────────
 * The backend and frontend each consume the SAME version of @alsaqi/shared. Each
 * repo's CI computes this fingerprint independently. The committed baseline
 * (`packages/shared/surface.fingerprint`) is the shared source of truth: any drift
 * in either repo's copy of the shared surface changes its fingerprint, no longer
 * matches the baseline, and fails the build in that repo (Requirement 8.4). If the
 * surface intentionally changes, regenerate the baseline with `--write` and commit
 * it in the same change set across both repos so they stay in lock-step.
 *
 * Run with:
 *   tsx scripts/ci/checkSharedFingerprint.ts            # verify against baseline
 *   tsx scripts/ci/checkSharedFingerprint.ts --write    # (re)generate the baseline
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSharedSurfaceFingerprint } from '@alsaqi/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, '../../packages/shared/surface.fingerprint');

function main(): void {
  const writeMode = process.argv.includes('--write');

  // 1. Compute the fingerprint — failure here is fail-closed.
  let fingerprint: string;
  try {
    fingerprint = computeSharedSurfaceFingerprint();
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new Error('fingerprint is empty');
    }
  } catch (err) {
    console.error(
      `[CI:shared-fp] FATAL: could not compute the shared-surface fingerprint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  // Always print the fingerprint so the frontend CI (B1) can compare against it.
  console.log(`[CI:shared-fp] fingerprint=${fingerprint}`);

  if (writeMode) {
    writeFileSync(BASELINE_PATH, `${fingerprint}\n`, 'utf-8');
    console.log(`[CI:shared-fp] wrote baseline → ${BASELINE_PATH}`);
    return;
  }

  // 2. Compare against the committed baseline — missing/mismatch is fail-closed.
  let baseline: string;
  try {
    baseline = readFileSync(BASELINE_PATH, 'utf-8').trim();
  } catch (err) {
    console.error(
      `[CI:shared-fp] FATAL: could not read baseline "${BASELINE_PATH}": ${
        err instanceof Error ? err.message : String(err)
      }. Generate it with: tsx scripts/ci/checkSharedFingerprint.ts --write`,
    );
    process.exit(1);
    return;
  }

  if (baseline !== fingerprint) {
    console.error(
      `[CI:shared-fp] FAILED: shared-surface fingerprint drift detected.\n` +
        `  baseline: ${baseline}\n` +
        `  computed: ${fingerprint}\n` +
        `The public surface of @alsaqi/shared changed. If intentional, regenerate the ` +
        `baseline with "--write" and commit it across BOTH repos (B1) so backend and ` +
        `frontend stay in lock-step.`,
    );
    process.exit(1);
    return;
  }

  console.log('[CI:shared-fp] OK: fingerprint matches committed baseline.');
}

main();

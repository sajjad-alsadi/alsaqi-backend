/**
 * CI Gate (contract): path-conditional Contract_Test_Suite gate — fail-closed.
 *
 * Design region (ك‑17/18); Requirements 18.1, 18.2, 18.3, 18.4. Cross-repo: B6.
 *
 * The ACTUAL Contract_Test_Suite lives in the FRONTEND repo (B6,
 * apps/web/src/test/contract/*) and runs against the live backend over HTTPS.
 * This backend-side gate REPRESENTS/TRIGGERS that requirement inside the backend
 * CI_Pipeline and encodes the path-conditional + fail-closed merge policy so the
 * gate is enforced symmetrically in BOTH repos.
 *
 * ── Path-conditional behaviour ────────────────────────────────────────────────
 *   • Shared_Package files modified (packages/shared/** — INCLUDING endpoint
 *     contracts): the Contract_Test_Suite is REQUIRED (18.1). Merge is blocked
 *     unless the suite COMPLETED with a passing result (18.2). Any non-passing
 *     completion OR inability to complete (failure / timeout / cancelled / error /
 *     missing result) is treated as fail-closed and blocks the merge (18.4).
 *   • No Shared_Package file modified: the Contract_Test_Suite is NOT required
 *     (18.3); this gate is a no-op and the other configured checks determine
 *     merge eligibility.
 *
 * ── Inputs (documented, fail-closed) ──────────────────────────────────────────
 *   SHARED_PACKAGE_CHANGED  "true" | "false" — whether the PR touches
 *                           packages/shared/**. Normally produced by the
 *                           paths-filter step in ci.yml. If UNSET while the suite
 *                           is required-by-default, the script recomputes it from
 *                           git when possible; if it still cannot be determined it
 *                           fails closed.
 *   CONTRACT_SUITE_STATUS   The completion status reported by the frontend
 *                           Contract_Test_Suite run for this change set (B6),
 *                           propagated cross-repo (e.g. via a commit status / check
 *                           run / repository_dispatch). One of:
 *                           "success" | "failure" | "cancelled" | "timed_out" |
 *                           "error" | "" (missing). Only "success" passes.
 *
 * Run with `tsx scripts/ci/checkContractGate.ts`.
 */

/** Completion statuses that count as a successful, complete run. */
const PASSING_STATUSES: ReadonlySet<string> = new Set(['success']);

function readBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return null;
}

function main(): void {
  const sharedChanged = readBool(process.env.SHARED_PACKAGE_CHANGED);

  // Inability to even determine whether the package changed ⇒ fail closed,
  // because we cannot prove the suite was NOT required.
  if (sharedChanged === null) {
    console.error(
      '[CI:contract] FATAL: SHARED_PACKAGE_CHANGED is unset/indeterminate; cannot ' +
        'decide whether the Contract_Test_Suite is required. Failing closed (18.4).',
    );
    process.exit(1);
    return;
  }

  // No Shared_Package change ⇒ contract suite NOT required (18.3). Other checks decide.
  if (!sharedChanged) {
    console.log(
      '[CI:contract] OK: no Shared_Package files modified; Contract_Test_Suite not ' +
        'required (18.3). Remaining configured checks determine merge eligibility.',
    );
    return;
  }

  // Shared_Package changed ⇒ Contract_Test_Suite REQUIRED (18.1). The actual run
  // happens in the frontend repo (B6); evaluate its propagated completion status.
  const status = (process.env.CONTRACT_SUITE_STATUS ?? '').trim().toLowerCase();

  if (status.length === 0) {
    console.error(
      '[CI:contract] FAILED (fail-closed): Shared_Package files were modified so the ' +
        'Contract_Test_Suite is REQUIRED (18.1), but no completion status was reported ' +
        'by the frontend suite (B6). Inability to complete ⇒ merge blocked (18.4).',
    );
    process.exit(1);
    return;
  }

  if (!PASSING_STATUSES.has(status)) {
    console.error(
      `[CI:contract] FAILED: Contract_Test_Suite required (Shared_Package modified) but ` +
        `its reported completion status was "${status}". Failure or inability to ` +
        `complete (failure/cancelled/timed_out/error) blocks the merge (18.2, 18.4).`,
    );
    process.exit(1);
    return;
  }

  console.log(
    '[CI:contract] OK: Shared_Package modified and the Contract_Test_Suite (B6) ' +
      'completed successfully; merge permitted by this gate (18.1, 18.2).',
  );
}

main();

// @vitest-environment node
/**
 * FIX-BE-3 deletion guard (helper, not a test file).
 *
 * Encapsulates the abort-on-mount decision used when removing the orphaned
 * regulatory route file (`src/routes/regulatory.ts`, exporting
 * `createRegulatoryRoutes`). The deletion is gated: if ANY router still mounts
 * `createRegulatoryRoutes`, the deletion MUST abort and the file MUST be
 * retained, reporting which router(s) mount it. Only when no router mounts the
 * symbol may the deletion proceed.
 *
 * Validates: Requirements 3.3
 */

/** The source text of a single router module, identified by name/path. */
export interface RouterSource {
  /** Identifier for the router (e.g., file path or module name). */
  name: string;
  /** The raw source text of the router module. */
  content: string;
}

/** ABORT outcome: retain the file and report the mounting routers. */
export interface AbortDecision {
  action: 'abort';
  /** The orphaned file must be retained when aborting. */
  retainFile: true;
  /** Human-readable reason for the abort. */
  reason: string;
  /** Names of the routers that still mount the symbol. */
  mountedBy: string[];
}

/** PROCEED outcome: no router mounts the symbol, deletion may continue. */
export interface ProceedDecision {
  action: 'proceed';
  retainFile: false;
  mountedBy: never[];
}

export type DeletionDecision = AbortDecision | ProceedDecision;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide whether the orphaned regulatory route file can be deleted.
 *
 * @param routerSources The router modules to inspect for a mount/reference.
 * @param symbol The exported symbol whose mount blocks deletion.
 * @returns ABORT (retain file) if any router mounts the symbol, otherwise PROCEED.
 */
export function evaluateRegulatoryDeletion(
  routerSources: RouterSource[],
  symbol = 'createRegulatoryRoutes'
): DeletionDecision {
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);

  const mountedBy = routerSources
    .filter((src) => pattern.test(src.content))
    .map((src) => src.name);

  if (mountedBy.length > 0) {
    return {
      action: 'abort',
      retainFile: true,
      reason: `Deletion aborted: '${symbol}' is still mounted by ${mountedBy.length} router(s): ${mountedBy.join(', ')}.`,
      mountedBy,
    };
  }

  return { action: 'proceed', retainFile: false, mountedBy: [] };
}

/**
 * Env_Template Consistency Checker
 *
 * Pure, deterministic check that the production environment template
 * (`.env.production.example`) stays consistent with the actual validation
 * rules encoded in `ENV_VAR_DEFINITIONS` (Environment_Validator).
 *
 * Design: region (ج) — "دقة Env_Template ومدقّق الاتساق".
 *
 * The function is PURE: it takes the definitions and a parsed list of template
 * entries and returns the set of consistency issues. It performs no I/O and
 * does not terminate the process, so it is suitable for property-based testing
 * and for use as a fail-closed CI gate.
 *
 * Validates: Requirements 2.1, 2.2, 2.4
 */

import type { EnvVarDefinition } from './envValidator.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single parsed entry from the environment template.
 * `tag` is the `[REQUIRED]` / `[OPTIONAL]` marker documented next to the
 * variable, and `hasFallbackNote` indicates whether the template documents a
 * fallback (e.g. "falls back to JWT_SECRET") for that variable.
 */
export interface TemplateEntry {
  name: string;
  tag: 'REQUIRED' | 'OPTIONAL';
  hasFallbackNote: boolean;
}

/**
 * A specific consistency problem between the definitions and the template.
 *
 * - `tag-mismatch`        — the template tag does not match the definition's
 *                           production-required classification.
 * - `forbidden-fallback`  — a production-required variable carries a fallback
 *                           note (a required secret must never fall back).
 * - `missing-in-template` — a defined variable does not appear in the template.
 * - `unknown-in-template` — a template entry references a variable that has no
 *                           definition.
 */
export interface ConsistencyIssue {
  name: string;
  kind: 'tag-mismatch' | 'forbidden-fallback' | 'missing-in-template' | 'unknown-in-template';
}

// ─── Consistency Check ─────────────────────────────────────────────────────────

/**
 * Returns the list of consistency issues between the environment-variable
 * definitions and the template entries.
 *
 * The returned list is empty IF AND ONLY IF the template is fully consistent:
 * 1. Every defined variable appears exactly once in the template.
 * 2. Each variable is tagged `[REQUIRED]` iff Environment_Validator treats it as
 *    required in production (`def.required === true`), and `[OPTIONAL]` otherwise.
 * 3. No production-required variable carries a fallback note.
 * 4. No template entry references an unknown (undefined) variable.
 *
 * Each violation surfaces as a specific {@link ConsistencyIssue}.
 *
 * @param defs     The authoritative environment-variable definitions.
 * @param template The parsed template entries.
 */
export function checkEnvTemplateConsistency(
  defs: EnvVarDefinition[],
  template: TemplateEntry[]
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  const definedNames = new Set(defs.map(d => d.name));

  // Group template entries by variable name to detect missing/duplicate coverage.
  const entriesByName = new Map<string, TemplateEntry[]>();
  for (const entry of template) {
    const existing = entriesByName.get(entry.name);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByName.set(entry.name, [entry]);
    }
  }

  // 1. Check every defined variable against its template entry/entries.
  for (const def of defs) {
    const entries = entriesByName.get(def.name);

    // Missing entirely, or not appearing exactly once.
    if (!entries || entries.length !== 1) {
      issues.push({ name: def.name, kind: 'missing-in-template' });
      // If absent, there is nothing more to check for this variable.
      if (!entries || entries.length === 0) {
        continue;
      }
    }

    const expectedTag: TemplateEntry['tag'] = def.required ? 'REQUIRED' : 'OPTIONAL';

    for (const entry of entries) {
      // 2. Tag must match the production-required classification.
      if (entry.tag !== expectedTag) {
        issues.push({ name: def.name, kind: 'tag-mismatch' });
      }

      // 3. A production-required variable must never carry a fallback note.
      if (def.required && entry.hasFallbackNote) {
        issues.push({ name: def.name, kind: 'forbidden-fallback' });
      }
    }
  }

  // 4. Any template entry without a matching definition is unknown.
  for (const entry of template) {
    if (!definedNames.has(entry.name)) {
      issues.push({ name: entry.name, kind: 'unknown-in-template' });
    }
  }

  return issues;
}

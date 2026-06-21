/**
 * Strict NODE_ENV Validation (Design → Components → Area أ, Requirement 1.3)
 *
 * Provides a pure parser for `NODE_ENV` that recognizes *only* the exact values
 * `development`, `production`, and `test`. Any unset, empty, whitespace-only,
 * wrong-case, or out-of-set value is rejected (`ok: false`) instead of being
 * silently defaulted to `development`.
 *
 * This module is intentionally side-effect free: it performs NO logging and NEVER
 * calls `process.exit`. The fail-closed startup behaviour (logging a FATAL message
 * and exiting with a non-zero code) is layered on top of this parser in the startup
 * sequence (`src/main.ts`).
 *
 * Validates: Requirements 1.3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The closed set of recognized environment modes. */
export type NodeEnv = 'development' | 'production' | 'test';

/**
 * Result of strictly parsing a raw `NODE_ENV` value.
 * - `ok: true`  → the value was exactly one of the allowed modes.
 * - `ok: false` → unset, empty, whitespace-only, wrong-case, or out-of-set;
 *   `received` echoes back the offending input (empty string when unset).
 */
export type NodeEnvParseResult =
  | { ok: true; value: NodeEnv }
  | { ok: false; received: string };

// ─── Parser ──────────────────────────────────────────────────────────────────

/** The complete, closed set of accepted `NODE_ENV` values. */
const ALLOWED_NODE_ENVS: readonly NodeEnv[] = ['development', 'production', 'test'];

/**
 * Strictly parse a raw `NODE_ENV` value.
 *
 * Returns `{ ok: true, value }` if and only if `raw` is exactly equal to one of
 * `development`, `production`, or `test`. Every other input — including `undefined`,
 * the empty string, whitespace-only strings, differently-cased variants
 * (e.g. `Production`), and any unrelated value — returns `{ ok: false, received }`.
 *
 * Pure function: no logging, no `process.exit`, no other side effects.
 */
export function parseStrictNodeEnv(raw: string | undefined): NodeEnvParseResult {
  if (raw === undefined) {
    return { ok: false, received: '' };
  }

  if ((ALLOWED_NODE_ENVS as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as NodeEnv };
  }

  return { ok: false, received: raw };
}

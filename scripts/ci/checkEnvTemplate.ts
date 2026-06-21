/**
 * CI Gate (1/4): Env_Template consistency — fail-closed.
 *
 * Design region (ج); Requirements 2.1, 2.4.
 *
 * Parses `.env.production.example` into `TemplateEntry[]` (REQUIRED/OPTIONAL tag +
 * fallback-note detection) and runs the pure `checkEnvTemplateConsistency` against
 * `ENV_VAR_DEFINITIONS`. The gate exits with a NON-ZERO code if:
 *   - any consistency issue is found (tag-mismatch / forbidden-fallback /
 *     missing-in-template / unknown-in-template), OR
 *   - the template cannot be read or parsed (inability to evaluate ⇒ fail closed).
 *
 * Run with `tsx scripts/ci/checkEnvTemplate.ts`. An optional path to the template
 * may be passed as argv[2]; defaults to `<repo>/.env.production.example`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkEnvTemplateConsistency,
  type TemplateEntry,
  type ConsistencyIssue,
} from '../../src/config/envTemplateConsistency.js';
import { ENV_VAR_DEFINITIONS } from '../../src/config/envValidator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Matches a `KEY=value` assignment line (env var name = uppercase/underscore/digits). */
const ASSIGNMENT_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=/;
/** Matches the `[REQUIRED]` / `[OPTIONAL]` tag inside a comment line. */
const TAG_RE = /\[(REQUIRED|OPTIONAL)\]/;
/** Detects a fallback note (e.g. "falls back to JWT_SECRET", "fallback"). */
const FALLBACK_RE = /falls?\s*back|fallback/i;

/**
 * Pure parser: turns the raw template text into `TemplateEntry[]`.
 *
 * Each variable assignment (`KEY=...`) becomes one entry. Its tag and
 * fallback-note flag are derived from the contiguous block of comment lines that
 * precede the assignment (since the previous assignment). A variable whose
 * preceding block carries no explicit tag defaults to OPTIONAL, which the
 * consistency check then flags as a tag-mismatch if the definition is required.
 */
export function parseEnvTemplate(raw: string): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  let pendingTag: TemplateEntry['tag'] | null = null;
  let pendingFallback = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      const tagMatch = TAG_RE.exec(trimmed);
      if (tagMatch) {
        pendingTag = tagMatch[1] as TemplateEntry['tag'];
      }
      if (FALLBACK_RE.test(trimmed)) {
        pendingFallback = true;
      }
      continue;
    }

    const assignMatch = ASSIGNMENT_RE.exec(line);
    if (assignMatch) {
      entries.push({
        name: assignMatch[1],
        tag: pendingTag ?? 'OPTIONAL',
        hasFallbackNote: pendingFallback,
      });
      // Reset the comment accumulator for the next variable's block.
      pendingTag = null;
      pendingFallback = false;
    }
    // Blank lines and anything else: keep accumulating until the next assignment.
  }

  return entries;
}

function describeIssue(issue: ConsistencyIssue): string {
  switch (issue.kind) {
    case 'tag-mismatch':
      return `${issue.name}: template tag does not match the production-required classification in ENV_VAR_DEFINITIONS`;
    case 'forbidden-fallback':
      return `${issue.name}: a production-required secret must not carry a fallback note`;
    case 'missing-in-template':
      return `${issue.name}: defined variable is missing from (or duplicated in) the template`;
    case 'unknown-in-template':
      return `${issue.name}: template references a variable with no definition in ENV_VAR_DEFINITIONS`;
    default:
      return `${issue.name}: ${issue.kind}`;
  }
}

function main(): void {
  const templatePath =
    process.argv[2] ?? path.resolve(__dirname, '../../.env.production.example');

  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf-8');
  } catch (err) {
    // Inability to read the template ⇒ fail closed.
    console.error(
      `[CI:env-template] FATAL: could not read template "${templatePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  let entries: TemplateEntry[];
  try {
    entries = parseEnvTemplate(raw);
  } catch (err) {
    // Inability to parse ⇒ fail closed.
    console.error(
      `[CI:env-template] FATAL: could not parse template: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
    return;
  }

  const issues = checkEnvTemplateConsistency(ENV_VAR_DEFINITIONS, entries);

  if (issues.length > 0) {
    console.error(
      `[CI:env-template] FAILED: ${issues.length} consistency issue(s) between ` +
        `.env.production.example and ENV_VAR_DEFINITIONS:`,
    );
    for (const issue of issues) {
      console.error(`  ✗ [${issue.kind}] ${describeIssue(issue)}`);
    }
    process.exit(1);
    return;
  }

  console.log(
    `[CI:env-template] OK: ${entries.length} template entries consistent with ` +
      `${ENV_VAR_DEFINITIONS.length} definitions.`,
  );
}

main();

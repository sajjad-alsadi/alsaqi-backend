// @vitest-environment node
// Feature: production-launch-readiness, Property 9
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  checkEnvTemplateConsistency,
  type TemplateEntry,
  type ConsistencyIssue,
} from '../envTemplateConsistency';
import type { EnvVarDefinition } from '../envValidator';

/**
 * Property Test: Env_Template Consistency with Environment_Validator (Property 9)
 *
 * Feature: production-launch-readiness
 * Property 9: اتساق Env_Template مع Environment_Validator
 *
 * **Validates: Requirements 2.1, 2.2, 2.4**
 *
 * For ANY set of environment-variable definitions and ANY parsed template, the
 * issues list returned by `checkEnvTemplateConsistency` is EMPTY IF AND ONLY IF
 * the template is fully consistent:
 *   1. Every defined variable appears exactly once in the template.
 *   2. Each variable is tagged `[REQUIRED]` iff `def.required === true`, else `[OPTIONAL]`.
 *   3. No production-required variable carries a fallback note.
 *   4. No template entry references an unknown (undefined) variable.
 *
 * When the template is deliberately corrupted (tag mismatch, forbidden fallback
 * on a required var, missing var, unknown var), the specific
 * {@link ConsistencyIssue} kind for that corruption surfaces.
 */

// ─── Reference oracle ──────────────────────────────────────────────────────────

/**
 * Independent re-implementation of the consistency contract, used purely as a
 * boolean oracle: returns true IFF the template is fully consistent with defs.
 */
function isConsistent(defs: EnvVarDefinition[], template: TemplateEntry[]): boolean {
  const definedNames = new Set(defs.map((d) => d.name));

  // 4. No unknown entries.
  for (const entry of template) {
    if (!definedNames.has(entry.name)) return false;
  }

  for (const def of defs) {
    const entries = template.filter((e) => e.name === def.name);
    // 1. Exactly once.
    if (entries.length !== 1) return false;

    const entry = entries[0];
    const expectedTag: TemplateEntry['tag'] = def.required ? 'REQUIRED' : 'OPTIONAL';
    // 2. Tag matches classification.
    if (entry.tag !== expectedTag) return false;
    // 3. No forbidden fallback on required.
    if (def.required && entry.hasFallbackNote) return false;
  }

  return true;
}

// ─── Generators ────────────────────────────────────────────────────────────────

/** SQL/identifier-safe, distinct variable names. */
const nameArb = fc
  .tuple(
    fc.constantFrom('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'),
    fc.integer({ min: 0, max: 50 }),
  )
  .map(([prefix, n]) => `VAR_${prefix}_${n}`);

const categoryArb = fc.constantFrom(
  'server',
  'database',
  'auth',
  'encryption',
  'backup',
  'integrations',
  'cache',
) as fc.Arbitrary<EnvVarDefinition['category']>;

/** A minimal but well-formed EnvVarDefinition. */
const defArb = (name: string): fc.Arbitrary<EnvVarDefinition> =>
  fc.record({
    name: fc.constant(name),
    required: fc.boolean(),
    type: fc.constantFrom('string', 'numeric', 'url', 'boolean', 'path') as fc.Arbitrary<
      EnvVarDefinition['type']
    >,
    description: fc.constant('test variable'),
    category: categoryArb,
  });

/** A set of definitions with distinct names (1..8 vars). */
const defsArb: fc.Arbitrary<EnvVarDefinition[]> = fc
  .uniqueArray(nameArb, { minLength: 1, maxLength: 8 })
  .chain((names) => fc.tuple(...names.map((nm) => defArb(nm))));

/** Build the canonical, fully-consistent template for a set of definitions. */
function consistentTemplate(defs: EnvVarDefinition[]): TemplateEntry[] {
  return defs.map((d) => ({
    name: d.name,
    tag: d.required ? 'REQUIRED' : 'OPTIONAL',
    hasFallbackNote: false,
  }));
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 9: Env_Template consistency with Environment_Validator', () => {
  it('returns an EMPTY issue list for any fully-consistent template', () => {
    fc.assert(
      fc.property(defsArb, (defs) => {
        const template = consistentTemplate(defs);
        const issues = checkEnvTemplateConsistency(defs, template);
        expect(issues).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('emptiness of the issue list agrees exactly with the consistency oracle', () => {
    // Generate possibly-corrupted templates from the definitions and assert the
    // function reports zero issues IFF the oracle says the template is consistent.
    const scenarioArb = defsArb.chain((defs) => {
      const definedNames = defs.map((d) => d.name);
      const entryArb: fc.Arbitrary<TemplateEntry> = fc.record({
        name: fc.oneof(fc.constantFrom(...definedNames), nameArb),
        tag: fc.constantFrom('REQUIRED', 'OPTIONAL') as fc.Arbitrary<TemplateEntry['tag']>,
        hasFallbackNote: fc.boolean(),
      });
      return fc.tuple(
        fc.constant(defs),
        fc.array(entryArb, { minLength: 0, maxLength: 12 }),
      );
    });

    fc.assert(
      fc.property(scenarioArb, ([defs, template]) => {
        const issues = checkEnvTemplateConsistency(defs, template);
        expect(issues.length === 0).toBe(isConsistent(defs, template));
      }),
      { numRuns: 300 },
    );
  });

  it('surfaces a tag-mismatch issue when a variable carries the wrong tag', () => {
    fc.assert(
      fc.property(
        defsArb,
        fc.nat(),
        (defs, pick) => {
          const idx = pick % defs.length;
          const target = defs[idx];
          const template = consistentTemplate(defs).map((entry, i) =>
            i === idx
              ? { ...entry, tag: (entry.tag === 'REQUIRED' ? 'OPTIONAL' : 'REQUIRED') as TemplateEntry['tag'] }
              : entry,
          );
          const issues = checkEnvTemplateConsistency(defs, template);
          expect(
            issues.some((iss) => iss.name === target.name && iss.kind === 'tag-mismatch'),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('surfaces a forbidden-fallback issue when a required variable has a fallback note', () => {
    fc.assert(
      fc.property(
        defsArb,
        fc.nat(),
        (defs, pick) => {
          // Force the target definition to be required, then add a fallback note.
          const idx = pick % defs.length;
          const patchedDefs = defs.map((d, i) => (i === idx ? { ...d, required: true } : d));
          const target = patchedDefs[idx];
          const template = consistentTemplate(patchedDefs).map((entry, i) =>
            i === idx ? { ...entry, hasFallbackNote: true } : entry,
          );
          const issues = checkEnvTemplateConsistency(patchedDefs, template);
          expect(
            issues.some((iss) => iss.name === target.name && iss.kind === 'forbidden-fallback'),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('surfaces a missing-in-template issue when a defined variable is absent', () => {
    fc.assert(
      fc.property(
        defsArb,
        fc.nat(),
        (defs, pick) => {
          const idx = pick % defs.length;
          const target = defs[idx];
          const template = consistentTemplate(defs).filter((_, i) => i !== idx);
          const issues = checkEnvTemplateConsistency(defs, template);
          expect(
            issues.some((iss) => iss.name === target.name && iss.kind === 'missing-in-template'),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('surfaces an unknown-in-template issue when the template references an undefined variable', () => {
    fc.assert(
      fc.property(
        defsArb,
        (defs) => {
          const definedNames = new Set(defs.map((d) => d.name));
          // A name guaranteed not to collide with any defined name.
          let unknownName = 'UNKNOWN_VAR_X';
          let suffix = 0;
          while (definedNames.has(unknownName)) {
            unknownName = `UNKNOWN_VAR_X_${suffix++}`;
          }
          const template: TemplateEntry[] = [
            ...consistentTemplate(defs),
            { name: unknownName, tag: 'OPTIONAL', hasFallbackNote: false },
          ];
          const issues = checkEnvTemplateConsistency(defs, template);
          expect(
            issues.some((iss) => iss.name === unknownName && iss.kind === 'unknown-in-template'),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

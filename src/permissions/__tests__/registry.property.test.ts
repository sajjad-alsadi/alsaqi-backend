/**
 * Property-based tests for ModuleRegistry.
 *
 * Uses fast-check to verify that registration validation and retrieval
 * methods behave correctly across all valid/invalid inputs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { ModuleRegistryImpl } from '../registry';
import { ModuleDefinition, PermissionAction } from '../types';
import { UserRole } from '../../constants';

/** Valid PermissionAction values */
const VALID_ACTIONS: PermissionAction[] = ['View', 'Create', 'Edit', 'Delete', 'Approve'];

/** Valid built-in role names */
const VALID_ROLES: string[] = Object.values(UserRole);

const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const LOWER_CHARS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const SPECIAL_CHARS = '_-!@#$%^&*() '.split('');
const ARABIC_CHARS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي '.split('');
const EN_LABEL_CHARS = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generates a valid PascalCase name (1-50 chars, starts with uppercase, alphanumeric) */
const validPascalCaseName = fc
  .tuple(
    fc.constantFrom(...UPPER_CHARS),
    fc.string({ unit: fc.constantFrom(...ALNUM_CHARS), minLength: 0, maxLength: 49 })
  )
  .map(([first, rest]) => first + rest);

/** Generates an invalid module name (empty, lowercase start, special chars, or >50 chars) */
const invalidModuleName = fc.oneof(
  // Empty string
  fc.constant(''),
  // Starts with lowercase
  fc
    .tuple(
      fc.constantFrom(...LOWER_CHARS),
      fc.string({ unit: fc.constantFrom(...ALNUM_CHARS), minLength: 0, maxLength: 10 })
    )
    .map(([first, rest]) => first + rest),
  // Contains special characters
  fc
    .tuple(
      fc.constantFrom(...UPPER_CHARS),
      fc.string({ unit: fc.constantFrom(...SPECIAL_CHARS), minLength: 1, maxLength: 10 })
    )
    .map(([first, rest]) => first + rest),
  // Exceeds 50 characters
  fc.string({ unit: fc.constantFrom(...UPPER_CHARS), minLength: 51, maxLength: 60 })
);

/** Generates a valid non-empty actions array (subset of VALID_ACTIONS) */
const validActionsArray = fc
  .subarray(VALID_ACTIONS, { minLength: 1, maxLength: 5 })
  .map((arr) => [...new Set(arr)] as PermissionAction[]);

/** Generates an invalid actions array (empty or containing invalid values) */
const invalidActionsArray = fc.oneof(
  // Empty array
  fc.constant([] as string[]),
  // Array with at least one invalid action
  fc
    .tuple(
      fc.subarray(VALID_ACTIONS, { minLength: 0, maxLength: 3 }),
      fc.array(
        fc.string({ unit: fc.constantFrom(...LOWER_CHARS), minLength: 1, maxLength: 10 })
          .filter((s) => !VALID_ACTIONS.includes(s as PermissionAction)),
        { minLength: 1, maxLength: 2 }
      )
    )
    .map(([valid, invalid]) => [...valid, ...invalid])
);

/** Generates valid defaults (keys are valid roles, values are valid actions) */
const validDefaults = fc
  .subarray(VALID_ROLES, { minLength: 0, maxLength: 6 })
  .chain((roles) =>
    fc.tuple(
      fc.constant(roles),
      fc.array(
        fc.subarray(VALID_ACTIONS, { minLength: 1, maxLength: 5 }),
        { minLength: roles.length, maxLength: roles.length }
      )
    )
  )
  .map(([roles, actionArrays]) => {
    const defaults: Record<string, PermissionAction[]> = {};
    roles.forEach((role, i) => {
      defaults[role] = actionArrays[i] as PermissionAction[];
    });
    return defaults;
  });

/** Generates invalid defaults (at least one key is not a valid role) */
const invalidDefaults = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...LOWER_CHARS), minLength: 1, maxLength: 15 })
      .filter((s) => !VALID_ROLES.includes(s)),
    fc.subarray(VALID_ACTIONS, { minLength: 1, maxLength: 3 })
  )
  .map(([invalidRole, actions]) => ({ [invalidRole]: actions as PermissionAction[] }));

/** Generates a valid bilingual label */
const validLabel = fc.record({
  en: fc.string({ unit: fc.constantFrom(...EN_LABEL_CHARS), minLength: 1, maxLength: 100 }),
  ar: fc.string({ unit: fc.constantFrom(...ARABIC_CHARS), minLength: 1, maxLength: 100 }),
});

/** Generates a valid navigation config */
const validNavigation = fc.record({
  icon: fc.string({ unit: fc.constantFrom(...ALNUM_CHARS), minLength: 1, maxLength: 20 }),
  path: fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz/-'.split('')), minLength: 1, maxLength: 30 }).map((p) => '/' + p),
  order: fc.integer({ min: 0, max: 100 }),
});

/** Generates a complete valid ModuleDefinition */
const validModuleDefinition = fc
  .tuple(validPascalCaseName, validLabel, validActionsArray, validDefaults, fc.option(validNavigation, { nil: undefined }))
  .map(([name, label, actions, defaults, navigation]): ModuleDefinition => ({
    name,
    label,
    actions,
    defaults,
    navigation,
  }));

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('ModuleRegistry Property Tests', () => {
  let registry: ModuleRegistryImpl;

  beforeEach(() => {
    registry = new ModuleRegistryImpl();
  });

  /**
   * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7**
   *
   * Property 1: Registration Validation
   * Registration succeeds iff name is unique PascalCase (1-50 chars),
   * actions non-empty and valid, defaults reference valid roles.
   */
  describe('Property 1: Registration Validation', () => {
    it('valid module definitions always register successfully', () => {
      fc.assert(
        fc.property(validModuleDefinition, (definition) => {
          const reg = new ModuleRegistryImpl();
          // Should not throw
          reg.register(definition);
          // Module should be retrievable
          expect(reg.getModule(definition.name)).toEqual(definition);
        }),
        { numRuns: 200 }
      );
    });

    it('invalid module names always cause registration to fail', () => {
      fc.assert(
        fc.property(
          invalidModuleName,
          validLabel,
          validActionsArray,
          validDefaults,
          (name, label, actions, defaults) => {
            const reg = new ModuleRegistryImpl();
            const definition: ModuleDefinition = { name, label, actions, defaults };
            expect(() => reg.register(definition)).toThrow();
          }
        ),
        { numRuns: 200 }
      );
    });

    it('empty actions array always causes registration to fail', () => {
      fc.assert(
        fc.property(validPascalCaseName, validLabel, validDefaults, (name, label, defaults) => {
          const reg = new ModuleRegistryImpl();
          const definition: ModuleDefinition = { name, label, actions: [], defaults };
          expect(() => reg.register(definition)).toThrow(/at least one action/i);
        }),
        { numRuns: 100 }
      );
    });

    it('invalid actions always cause registration to fail', () => {
      fc.assert(
        fc.property(
          validPascalCaseName,
          validLabel,
          invalidActionsArray.filter((arr) => arr.length > 0),
          (name, label, actions) => {
            const reg = new ModuleRegistryImpl();
            const definition: ModuleDefinition = {
              name,
              label,
              actions: actions as PermissionAction[],
              defaults: {},
            };
            expect(() => reg.register(definition)).toThrow(/invalid action/i);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('invalid role references in defaults always cause registration to fail', () => {
      fc.assert(
        fc.property(
          validPascalCaseName,
          validLabel,
          validActionsArray,
          invalidDefaults,
          (name, label, actions, defaults) => {
            const reg = new ModuleRegistryImpl();
            const definition: ModuleDefinition = {
              name,
              label,
              actions,
              defaults: defaults as Record<string, PermissionAction[]>,
            };
            expect(() => reg.register(definition)).toThrow(/invalid role/i);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('duplicate module names always cause registration to fail', () => {
      fc.assert(
        fc.property(validModuleDefinition, (definition) => {
          const reg = new ModuleRegistryImpl();
          reg.register(definition);
          // Second registration with same name should throw
          const duplicate: ModuleDefinition = {
            ...definition,
            label: { en: 'Other', ar: 'آخر' },
          };
          expect(() => reg.register(duplicate)).toThrow(/already registered/i);
        }),
        { numRuns: 100 }
      );
    });

    it('navigation path not starting with / causes registration to fail', () => {
      fc.assert(
        fc.property(
          validPascalCaseName,
          validLabel,
          validActionsArray,
          validDefaults,
          fc.string({ unit: fc.constantFrom(...LOWER_CHARS), minLength: 1, maxLength: 20 }),
          (name, label, actions, defaults, badPath) => {
            const reg = new ModuleRegistryImpl();
            const definition: ModuleDefinition = {
              name,
              label,
              actions,
              defaults,
              navigation: { icon: 'Icon', path: badPath, order: 1 },
            };
            expect(() => reg.register(definition)).toThrow(/must start with/i);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * **Validates: Requirements 1.6**
   *
   * Property 2: Registry Retrieval Consistency
   * getAllModules returns exactly the registered set, getModule returns
   * matching or undefined, getModuleNames returns registered names.
   */
  describe('Property 2: Registry Retrieval Consistency', () => {
    it('getAllModules returns exactly the set of registered modules', () => {
      fc.assert(
        fc.property(
          fc.array(validModuleDefinition, { minLength: 0, maxLength: 10 }),
          (definitions) => {
            const reg = new ModuleRegistryImpl();
            const uniqueDefs = deduplicateByName(definitions);

            for (const def of uniqueDefs) {
              reg.register(def);
            }

            const allModules = reg.getAllModules();
            expect(allModules.length).toBe(uniqueDefs.length);

            for (const def of uniqueDefs) {
              expect(allModules).toContainEqual(def);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getModule returns the matching definition or undefined', () => {
      fc.assert(
        fc.property(
          fc.array(validModuleDefinition, { minLength: 1, maxLength: 10 }),
          validPascalCaseName,
          (definitions, queryName) => {
            const reg = new ModuleRegistryImpl();
            const uniqueDefs = deduplicateByName(definitions);

            for (const def of uniqueDefs) {
              reg.register(def);
            }

            const registeredNames = uniqueDefs.map((d) => d.name);
            const result = reg.getModule(queryName);

            if (registeredNames.includes(queryName)) {
              const expected = uniqueDefs.find((d) => d.name === queryName);
              expect(result).toEqual(expected);
            } else {
              expect(result).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getModuleNames returns exactly the set of registered names', () => {
      fc.assert(
        fc.property(
          fc.array(validModuleDefinition, { minLength: 0, maxLength: 10 }),
          (definitions) => {
            const reg = new ModuleRegistryImpl();
            const uniqueDefs = deduplicateByName(definitions);

            for (const def of uniqueDefs) {
              reg.register(def);
            }

            const names = reg.getModuleNames();
            const expectedNames = uniqueDefs.map((d) => d.name);

            expect(names.length).toBe(expectedNames.length);
            expect(new Set(names)).toEqual(new Set(expectedNames));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getDefaultPermissions returns empty object for unknown roles', () => {
      fc.assert(
        fc.property(
          fc.array(validModuleDefinition, { minLength: 1, maxLength: 5 }),
          fc.string({ unit: fc.constantFrom(...'xyz'.split('')), minLength: 5, maxLength: 15 }),
          (definitions, unknownRole) => {
            fc.pre(!VALID_ROLES.includes(unknownRole));

            const reg = new ModuleRegistryImpl();
            const uniqueDefs = deduplicateByName(definitions);

            for (const def of uniqueDefs) {
              reg.register(def);
            }

            const result = reg.getDefaultPermissions(unknownRole);
            expect(result).toEqual({});
          }
        ),
        { numRuns: 50 }
      );
    });

    it('getDefaultPermissions returns correct actions for known roles', () => {
      fc.assert(
        fc.property(
          fc.array(validModuleDefinition, { minLength: 1, maxLength: 5 }),
          fc.constantFrom(...VALID_ROLES),
          (definitions, role) => {
            const reg = new ModuleRegistryImpl();
            const uniqueDefs = deduplicateByName(definitions);

            for (const def of uniqueDefs) {
              reg.register(def);
            }

            const result = reg.getDefaultPermissions(role);

            for (const def of uniqueDefs) {
              const expectedActions = def.defaults[role];
              if (expectedActions && expectedActions.length > 0) {
                expect(result[def.name]).toEqual(expectedActions);
              } else {
                expect(result[def.name]).toBeUndefined();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Deduplicate module definitions by name, keeping the first occurrence */
function deduplicateByName(definitions: ModuleDefinition[]): ModuleDefinition[] {
  const seen = new Set<string>();
  return definitions.filter((def) => {
    if (seen.has(def.name)) return false;
    seen.add(def.name);
    return true;
  });
}

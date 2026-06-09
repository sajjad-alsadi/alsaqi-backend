/**
 * Property-based tests for DB Auto-Seeder.
 *
 * Uses fast-check to verify seeding idempotency and completeness
 * across arbitrary module definitions and initial DB states.
 *
 * Tests use an in-memory mock DB that simulates the permissions
 * and role_permissions tables.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { seedModules, SeederDB } from '../seeder';
import { ModuleDefinition, PermissionAction } from '../types';
import { UserRole } from '../../constants';

// ─── Constants ─────────────────────────────────────────────────────────────────

const VALID_ACTIONS: PermissionAction[] = ['View', 'Create', 'Edit', 'Delete', 'Approve'];
const VALID_ROLES: string[] = Object.values(UserRole);

const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

// ─── In-Memory Mock DB ─────────────────────────────────────────────────────────

interface PermissionRow {
  id: string;
  module: string;
  action: string;
  description: string;
}

interface RolePermissionRow {
  role_id: string;
  permission_id: string;
}

interface RoleRow {
  id: string;
  name: string;
}

/**
 * Creates an in-memory mock database that simulates the permissions,
 * role_permissions, and roles tables for testing the seeder.
 */
function createMockDB(options?: {
  initialPermissions?: PermissionRow[];
  initialRolePermissions?: RolePermissionRow[];
  roles?: RoleRow[];
}): SeederDB & {
  getPermissions(): PermissionRow[];
  getRolePermissions(): RolePermissionRow[];
} {
  let idCounter = 0;
  const permissions: PermissionRow[] = [...(options?.initialPermissions || [])];
  const rolePermissions: RolePermissionRow[] = [...(options?.initialRolePermissions || [])];
  const roles: RoleRow[] = options?.roles || VALID_ROLES.map((name, i) => ({
    id: `role-${i + 1}`,
    name,
  }));

  return {
    getPermissions: () => [...permissions],
    getRolePermissions: () => [...rolePermissions],

    prepare(sql: string) {
      return {
        async all(..._params: any[]): Promise<any[]> {
          if (sql.includes('SELECT module, action FROM permissions')) {
            return permissions.map((p) => ({ module: p.module, action: p.action }));
          }
          return [];
        },

        async get(...params: any[]): Promise<any> {
          if (sql.includes('INSERT INTO permissions')) {
            // Insert a new permission and return its id
            const newId = `perm-${++idCounter}`;
            const [module, action, description] = params;
            permissions.push({ id: newId, module, action, description });
            return { id: newId };
          }

          if (sql.includes('SELECT id FROM roles WHERE name')) {
            const [roleName] = params;
            const role = roles.find((r) => r.name === roleName);
            return role ? { id: role.id } : undefined;
          }

          return undefined;
        },

        async run(...params: any[]): Promise<{ lastInsertRowid: any; changes: number }> {
          if (sql.includes('INSERT INTO role_permissions')) {
            const [roleId, permissionId] = params;
            // ON CONFLICT DO NOTHING - check for duplicates
            const exists = rolePermissions.some(
              (rp) => rp.role_id === roleId && rp.permission_id === permissionId
            );
            if (!exists) {
              rolePermissions.push({ role_id: roleId, permission_id: permissionId });
              return { lastInsertRowid: 0, changes: 1 };
            }
            return { lastInsertRowid: 0, changes: 0 };
          }
          return { lastInsertRowid: 0, changes: 0 };
        },
      };
    },
  };
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generates a valid PascalCase name (1-20 chars for test efficiency) */
const validPascalCaseName = fc
  .tuple(
    fc.constantFrom(...UPPER_CHARS),
    fc.string({ unit: fc.constantFrom(...ALNUM_CHARS), minLength: 0, maxLength: 15 })
  )
  .map(([first, rest]) => first + rest);

/** Generates a valid non-empty actions array (subset of VALID_ACTIONS) */
const validActionsArray = fc
  .subarray(VALID_ACTIONS, { minLength: 1, maxLength: 5 })
  .map((arr) => [...new Set(arr)] as PermissionAction[]);

/** Generates valid defaults (keys are valid roles, values are subsets of provided actions) */
function validDefaultsFor(actions: PermissionAction[]) {
  return fc
    .subarray(VALID_ROLES, { minLength: 0, maxLength: 6 })
    .chain((roles) =>
      fc.tuple(
        fc.constant(roles),
        fc.array(
          fc.subarray(actions, { minLength: 1, maxLength: actions.length }),
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
}

/** Generates a valid ModuleDefinition */
const validModuleDefinition: fc.Arbitrary<ModuleDefinition> = validActionsArray.chain(
  (actions) =>
    fc
      .tuple(
        validPascalCaseName,
        fc.record({
          en: fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), minLength: 1, maxLength: 30 }),
          ar: fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), minLength: 1, maxLength: 30 }),
        }),
        fc.constant(actions),
        validDefaultsFor(actions)
      )
      .map(([name, label, acts, defaults]): ModuleDefinition => ({
        name,
        label,
        actions: acts,
        defaults,
      }))
);

/** Generates a list of unique module definitions (deduplicated by name) */
const uniqueModuleDefinitions = fc
  .array(validModuleDefinition, { minLength: 1, maxLength: 6 })
  .map(deduplicateByName);

/**
 * Generates an initial DB state: a subset of module-action pairs that already exist.
 * This simulates a DB that has been partially seeded before.
 */
function initialDBStateFor(modules: ModuleDefinition[]) {
  // Collect all possible (module, action) pairs
  const allPairs = modules.flatMap((m) =>
    m.actions.map((a) => ({ module: m.name, action: a }))
  );

  // Pick a random subset to already exist in DB
  return fc.subarray(allPairs, { minLength: 0, maxLength: allPairs.length });
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('DB Auto-Seeder Property Tests', () => {
  /**
   * **Validates: Requirements 2.4, 2.5, 2.6**
   *
   * Property 3: Seeding Idempotency
   * For any set of module definitions and any initial database state,
   * running seedModules() N times (N ≥ 1) produces the same database state
   * as running it once, and the sum of added + skipped in the result equals
   * the total number of module-action pairs.
   */
  describe('Property 3: Seeding Idempotency', () => {
    it('running seed N times produces same DB state as running once', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModuleDefinitions.chain((modules) =>
            fc.tuple(fc.constant(modules), initialDBStateFor(modules))
          ),
          fc.integer({ min: 2, max: 4 }),
          async ([modules, initialPairs], n) => {
            // Create initial DB state with some permissions already existing
            const initialPermissions: PermissionRow[] = initialPairs.map((p, i) => ({
              id: `existing-${i}`,
              module: p.module,
              action: p.action,
              description: `${p.action} existing`,
            }));

            // Run seed once and capture state S1
            const db1 = createMockDB({ initialPermissions: [...initialPermissions] });
            await seedModules(db1, modules);
            const stateS1Perms = db1.getPermissions();
            const stateS1RolePerms = db1.getRolePermissions();

            // Run seed N times starting from same initial state
            const dbN = createMockDB({ initialPermissions: [...initialPermissions] });
            for (let i = 0; i < n; i++) {
              await seedModules(dbN, modules);
            }
            const stateSNPerms = dbN.getPermissions();
            const stateSNRolePerms = dbN.getRolePermissions();

            // S1 === SN: same permissions (by module:action keys)
            const s1PermKeys = new Set(stateS1Perms.map((p) => `${p.module}:${p.action}`));
            const sNPermKeys = new Set(stateSNPerms.map((p) => `${p.module}:${p.action}`));
            expect(s1PermKeys).toEqual(sNPermKeys);

            // S1 === SN: same number of role_permissions
            expect(stateS1RolePerms.length).toBe(stateSNRolePerms.length);
          }
        ),
        { numRuns: 80 }
      );
    });

    it('added + skipped equals total module-action pairs', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModuleDefinitions.chain((modules) =>
            fc.tuple(fc.constant(modules), initialDBStateFor(modules))
          ),
          async ([modules, initialPairs]) => {
            const initialPermissions: PermissionRow[] = initialPairs.map((p, i) => ({
              id: `existing-${i}`,
              module: p.module,
              action: p.action,
              description: `${p.action} existing`,
            }));

            const mockDb = createMockDB({ initialPermissions });
            const result = await seedModules(mockDb, modules);

            // Total module-action pairs across all modules
            const totalPairs = modules.reduce(
              (sum, m) => sum + m.actions.length,
              0
            );

            // added + skipped must equal total pairs
            expect(result.added.length + result.skipped.length).toBe(totalPairs);
          }
        ),
        { numRuns: 120 }
      );
    });
  });

  /**
   * **Validates: Requirements 2.2, 2.3**
   *
   * Property 4: Seeding Completeness
   * For any module definition in the registry, after seeding completes,
   * the permissions table contains a record for every (module, action) pair,
   * and the role_permissions table contains entries matching the module's
   * defaults configuration for each new permission.
   */
  describe('Property 4: Seeding Completeness', () => {
    it('after seeding, all module-action pairs exist in permissions table', async () => {
      await fc.assert(
        fc.asyncProperty(uniqueModuleDefinitions, async (modules) => {
          const mockDb = createMockDB();
          await seedModules(mockDb, modules);

          const permissions = mockDb.getPermissions();
          const permKeys = new Set(
            permissions.map((p) => `${p.module}:${p.action}`)
          );

          // Every module-action pair from the definitions must exist
          for (const mod of modules) {
            for (const action of mod.actions) {
              const key = `${mod.name}:${action}`;
              expect(permKeys.has(key)).toBe(true);
            }
          }
        }),
        { numRuns: 120 }
      );
    });

    it('after seeding, role_permissions entries match module defaults for new permissions', async () => {
      await fc.assert(
        fc.asyncProperty(uniqueModuleDefinitions, async (modules) => {
          const roles = VALID_ROLES.map((name, i) => ({
            id: `role-${i + 1}`,
            name,
          }));

          const mockDb = createMockDB({ roles });
          await seedModules(mockDb, modules);

          const permissions = mockDb.getPermissions();
          const rolePerms = mockDb.getRolePermissions();

          // For each module and each role in its defaults
          for (const mod of modules) {
            for (const [roleName, roleActions] of Object.entries(mod.defaults)) {
              const role = roles.find((r) => r.name === roleName);
              if (!role) continue;

              for (const action of roleActions as PermissionAction[]) {
                // Find the permission record for this module:action
                const permRecord = permissions.find(
                  (p) => p.module === mod.name && p.action === action
                );
                expect(permRecord).toBeDefined();

                if (permRecord) {
                  // A role_permissions entry should exist for this role + permission
                  const hasRolePerm = rolePerms.some(
                    (rp) =>
                      rp.role_id === role.id &&
                      rp.permission_id === permRecord.id
                  );
                  expect(hasRolePerm).toBe(true);
                }
              }
            }
          }
        }),
        { numRuns: 80 }
      );
    });

    it('seeding with pre-existing permissions does not duplicate them', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModuleDefinitions.chain((modules) =>
            fc.tuple(fc.constant(modules), initialDBStateFor(modules))
          ),
          async ([modules, initialPairs]) => {
            const initialPermissions: PermissionRow[] = initialPairs.map((p, i) => ({
              id: `existing-${i}`,
              module: p.module,
              action: p.action,
              description: `${p.action} existing`,
            }));

            const mockDb = createMockDB({ initialPermissions });
            await seedModules(mockDb, modules);

            const permissions = mockDb.getPermissions();

            // Check no duplicate (module, action) pairs
            const permKeys = permissions.map((p) => `${p.module}:${p.action}`);
            const uniqueKeys = new Set(permKeys);
            expect(permKeys.length).toBe(uniqueKeys.size);
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

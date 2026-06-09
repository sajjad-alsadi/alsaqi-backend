/**
 * DB Auto-Seeder - Synchronizes ModuleRegistry definitions into the database.
 *
 * On application startup, compares registry definitions against existing DB
 * permission records and inserts any missing (module, action) pairs along with
 * their default role_permissions entries.
 *
 * Key behaviors:
 * - Idempotent: running multiple times produces the same DB state
 * - Existing permissions are never modified
 * - Missing roles referenced in defaults are logged as warnings (not errors)
 * - DB connection failures are caught and logged, allowing the app to start
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */

import { db } from '../db/index';
import { ModuleRegistry } from './registry';
import { ModuleDefinition, PermissionAction, SeedResult } from './types';

/**
 * Database abstraction interface for the seeder.
 * Allows injection of a mock DB for testing.
 */
export interface SeederDB {
  prepare(sql: string): {
    all(...params: any[]): Promise<any[]>;
    get(...params: any[]): Promise<any>;
    run(...params: any[]): Promise<{ lastInsertRowid: any; changes: number }>;
  };
}

/**
 * Seed modules into the database.
 *
 * Algorithm:
 * 1. Query all existing (module, action) pairs from the permissions table
 * 2. For each module in the provided definitions, for each action:
 *    a. If (module, action) already exists in DB → skip
 *    b. If not → INSERT into permissions table
 *    c. For each role in module.defaults that includes this action:
 *       - Look up role by name in roles table
 *       - If role exists → INSERT into role_permissions
 *       - If role doesn't exist → log warning
 * 3. Return SeedResult with added/skipped counts
 *
 * Preconditions:
 * - Database connection is active and permissions/roles tables exist
 *
 * Postconditions:
 * - Every (module, action) pair from the provided modules exists in permissions table
 * - Default role_permissions are created for new permissions only
 * - Existing permissions are unchanged (idempotent)
 *
 * @param database - Database instance (defaults to the app's db)
 * @param modules - Module definitions to seed (defaults to ModuleRegistry.getAllModules())
 */
export async function seedModules(
  database?: SeederDB,
  modules?: ModuleDefinition[]
): Promise<SeedResult> {
  const dbInstance = database || db;
  const registeredModules = modules || ModuleRegistry.getAllModules();

  try {
    const added: string[] = [];
    const skipped: string[] = [];

    // Step 1: Query all existing (module, action) pairs from DB (Req 2.1)
    const existingPermissions = (await dbInstance
      .prepare('SELECT module, action FROM permissions')
      .all()) as Array<{ module: string; action: string }>;

    const existingSet = new Set(
      existingPermissions.map((p) => `${p.module}:${p.action}`)
    );

    // Step 2: Process each module-action pair
    for (const moduleDef of registeredModules) {
      for (const action of moduleDef.actions) {
        const key = `${moduleDef.name}:${action}`;

        // Step 2a: Skip existing permissions (Req 2.4)
        if (existingSet.has(key)) {
          skipped.push(key);
          continue;
        }

        // Step 2b: Insert new permission record (Req 2.2)
        const description = `${action} ${moduleDef.label.en}`;
        const insertResult = await dbInstance
          .prepare(
            'INSERT INTO permissions (module, action, description) VALUES (?, ?, ?) RETURNING id'
          )
          .get(moduleDef.name, action, description);

        // If insert failed for any reason, treat as skipped
        if (!insertResult || !insertResult.id) {
          skipped.push(key);
          continue;
        }

        const permissionId = insertResult.id;

        // Step 2c: Create default role_permissions entries (Req 2.3)
        for (const [roleName, roleActions] of Object.entries(moduleDef.defaults)) {
          if (!(roleActions as PermissionAction[]).includes(action as PermissionAction)) {
            continue;
          }

          // Look up role by name
          const role = await dbInstance
            .prepare('SELECT id FROM roles WHERE name = ?')
            .get(roleName);

          if (!role) {
            // Req 2.8: Log warning if role doesn't exist
            console.warn(
              `[Seeder] Warning: Role '${roleName}' referenced in module '${moduleDef.name}' defaults does not exist in the database. Skipping role_permissions entry.`
            );
            continue;
          }

          // Insert role_permission entry
          await dbInstance
            .prepare(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
            )
            .run(role.id, permissionId);
        }

        added.push(key);
      }
    }

    // Step 3: Return result (Req 2.6)
    const result: SeedResult = {
      added,
      skipped,
      total: registeredModules.length,
    };

    console.log(
      `[Seeder] Seeding complete: ${added.length} added, ${skipped.length} skipped, ${registeredModules.length} modules processed.`
    );

    return result;
  } catch (error: any) {
    // Req 2.7: Handle DB connection failures gracefully
    console.error(
      `[Seeder] Error during permission seeding: ${error.message}. Application will continue with potentially incomplete permissions.`
    );

    // Return empty result to allow app to start
    return {
      added: [],
      skipped: [],
      total: 0,
    };
  }
}

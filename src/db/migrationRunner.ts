import { IDBWrapper } from './index';
import logger from '../utils/logger';

/**
 * Represents a single migration definition.
 */
export interface Migration {
  version: string;          // e.g., '001', '002'
  name: string;             // Human-readable description
  type: 'schema' | 'seed'; // DDL or data
  up: () => Promise<void>;  // Forward migration
  down?: () => Promise<void>; // Rollback migration (optional)
}

/**
 * Represents a recorded migration in the schema_migrations table.
 */
export interface MigrationRecord {
  version: string;
  name: string;
  type: string;
  applied_at: string;       // ISO timestamp
}

/**
 * MigrationRunner manages database schema versioning.
 * It tracks applied migrations in a `schema_migrations` table and ensures
 * each migration runs exactly once, in sequential version order.
 */
export class MigrationRunner {
  constructor(private db: IDBWrapper) {}

  /**
   * Creates the schema_migrations table if it does not already exist.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing migration system');
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'schema',
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    logger.info('schema_migrations table ready');
  }

  /**
   * Returns all previously applied migration records from the schema_migrations table.
   */
  async getApplied(): Promise<MigrationRecord[]> {
    const rows = await this.db.prepare(
      'SELECT version, name, type, applied_at FROM schema_migrations ORDER BY version ASC'
    ).all();
    return rows as MigrationRecord[];
  }

  /**
   * Filters available migrations to return only those not yet applied,
   * sorted in ascending version order.
   */
  async getPending(available: Migration[]): Promise<Migration[]> {
    const applied = await this.getApplied();
    const appliedVersions = new Set(applied.map(r => r.version));

    return available
      .filter(m => !appliedVersions.has(m.version))
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  /**
   * Executes all pending migrations in sequential version order.
   * Each migration runs within a transaction. On success, the version is recorded
   * in schema_migrations within the same transaction. On failure, execution halts
   * and the failing migration's version is NOT recorded.
   */
  async run(available: Migration[]): Promise<void> {
    const pending = await this.getPending(available);

    if (pending.length === 0) {
      logger.info('No pending migrations to run');
      return;
    }

    logger.info(`Found ${pending.length} pending migration(s) to execute`);

    for (const migration of pending) {
      logger.info(`Running migration ${migration.version}: ${migration.name} (${migration.type})`);

      try {
        await this.db.transaction(async () => {
          // Execute the migration's up function
          await migration.up();

          // Record the migration in schema_migrations
          await this.db.prepare(
            'INSERT INTO schema_migrations (version, name, type) VALUES (?, ?, ?)'
          ).run(migration.version, migration.name, migration.type);
        });
        logger.info(`Migration ${migration.version} applied successfully`);
      } catch (error: any) {
        logger.error(`Migration ${migration.version} failed: ${error.message}`, {
          version: migration.version,
          name: migration.name,
          error: error.message,
        });
        throw error;
      }
    }

    logger.info(`All ${pending.length} migration(s) applied successfully`);
  }

  /**
   * Rolls back a specific migration by version.
   *
   * - Finds the migration by version in the available list
   * - Rejects with clear error if no down() is defined (Requirement 3.7)
   * - Executes down() within a single transaction (Requirement 3.6)
   * - Removes the record from schema_migrations within the same transaction (Requirement 3.6)
   * - On failure, rolls back all changes automatically (Requirement 3.2)
   */
  async rollback(version: string, available: Migration[]): Promise<void> {
    const migration = available.find(m => m.version === version);

    if (!migration) {
      throw new Error(
        `Migration version "${version}" not found in available migrations`
      );
    }

    if (!migration.down) {
      const errorMessage =
        `Rollback is not supported for migration ${migration.version}: "${migration.name}" — no down() function defined`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    logger.info(`Rolling back migration ${migration.version}: ${migration.name} (${migration.type})`);

    try {
      await this.db.transaction(async () => {
        // Execute the migration's down function
        await migration.down!();

        // Remove the record from schema_migrations
        await this.db.prepare(
          'DELETE FROM schema_migrations WHERE version = ?'
        ).run(migration.version);
      });
      logger.info(`Migration ${migration.version} rolled back successfully`);
    } catch (error: any) {
      logger.error(`Rollback of migration ${migration.version} failed: ${error.message}`, {
        version: migration.version,
        name: migration.name,
        error: error.message,
      });
      throw error;
    }
  }
}

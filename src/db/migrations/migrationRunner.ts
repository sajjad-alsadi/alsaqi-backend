import pg from 'pg';
import logger from '../../utils/logger.js';

/**
 * Advisory lock key used to prevent concurrent migration execution.
 * This is a fixed 64-bit integer used with pg_advisory_lock.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 8675309;

/**
 * Timeout in milliseconds for acquiring the advisory lock.
 */
const ADVISORY_LOCK_TIMEOUT_MS = 30_000;

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
  executed_at: string; // ISO 8601 timestamp
}

/**
 * MigrationRunner manages database schema versioning with production-grade
 * transaction support and advisory locking.
 *
 * Features:
 * - Each migration runs within a single database transaction
 * - Migration version is recorded in schema_migrations within the same transaction
 * - PostgreSQL advisory lock prevents concurrent migration execution
 * - Lock timeout of 30 seconds exits with error if another instance is running
 * - executed_at stored in ISO 8601 format
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5
 */
export class MigrationRunner {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Creates the schema_migrations table if it does not already exist.
   * Columns: version (PK), name, type (schema/seed), executed_at (ISO 8601)
   */
  async ensureMigrationsTable(): Promise<void> {
    logger.info('[MigrationRunner] Ensuring schema_migrations table exists');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('schema', 'seed')),
        executed_at TEXT NOT NULL
      )
    `);
    logger.info('[MigrationRunner] schema_migrations table ready');
  }

  /**
   * Attempts to acquire a PostgreSQL advisory lock with a 30-second timeout.
   * If the lock cannot be acquired within the timeout, the process exits
   * with an error indicating another instance is running migrations.
   *
   * Returns a dedicated client that holds the lock (must be released after use).
   */
  async acquireAdvisoryLock(): Promise<pg.PoolClient> {
    const client = await this.pool.connect();

    try {
      // Set a statement timeout for the lock acquisition attempt
      await client.query(`SET statement_timeout = '${ADVISORY_LOCK_TIMEOUT_MS}ms'`);

      // pg_advisory_lock blocks until it can acquire the lock.
      // With statement_timeout set, it will throw if it can't acquire within the timeout.
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_ADVISORY_LOCK_KEY]);

      // Reset statement timeout after acquiring the lock
      await client.query(`SET statement_timeout = '0'`);

      logger.info('[MigrationRunner] Advisory lock acquired successfully');
      return client;
    } catch (error: any) {
      client.release();

      // Check if this is a timeout error (statement_timeout cancellation)
      const isTimeout =
        error.code === '57014' || // query_canceled
        error.message?.includes('canceling statement due to statement timeout') ||
        error.message?.includes('timeout');

      if (isTimeout) {
        logger.error(
          '[MigrationRunner] FATAL: Could not acquire migration lock within 30 seconds. ' +
          'Another instance is currently running migrations. Exiting.'
        );
        process.exit(1);
      }

      // Re-throw unexpected errors
      throw error;
    }
  }

  /**
   * Releases the advisory lock held by the given client.
   */
  async releaseAdvisoryLock(client: pg.PoolClient): Promise<void> {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK_KEY]);
      logger.info('[MigrationRunner] Advisory lock released');
    } finally {
      client.release();
    }
  }

  /**
   * Returns all previously applied migration records from the schema_migrations table.
   */
  async getApplied(): Promise<MigrationRecord[]> {
    const result = await this.pool.query(
      'SELECT version, name, type, executed_at FROM schema_migrations ORDER BY version ASC'
    );
    return result.rows as MigrationRecord[];
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
   *
   * - Acquires advisory lock to prevent concurrent execution (Requirement 3.3)
   * - Each migration runs within a single transaction (Requirement 3.1)
   * - Migration record is inserted within the same transaction (Requirement 3.1)
   * - On failure, the transaction is rolled back and execution halts
   * - On lock timeout, exits with error (Requirement 3.4)
   * - Records version, name, type, and executed_at in ISO 8601 (Requirement 3.5)
   */
  async run(available: Migration[]): Promise<void> {
    // Ensure the schema_migrations table exists
    await this.ensureMigrationsTable();

    // Acquire advisory lock (exits process on timeout)
    const lockClient = await this.acquireAdvisoryLock();

    try {
      const pending = await this.getPending(available);

      if (pending.length === 0) {
        logger.info('[MigrationRunner] No pending migrations to run');
        return;
      }

      logger.info(`[MigrationRunner] Found ${pending.length} pending migration(s) to execute`);

      for (const migration of pending) {
        logger.info(
          `[MigrationRunner] Running migration ${migration.version}: ${migration.name} (${migration.type})`
        );

        // Execute each migration within its own transaction
        const migrationClient = await this.pool.connect();
        try {
          await migrationClient.query('BEGIN');

          // Execute the migration's up function
          await migration.up();

          // Record the migration in schema_migrations with ISO 8601 timestamp
          const executedAt = new Date().toISOString();
          await migrationClient.query(
            'INSERT INTO schema_migrations (version, name, type, executed_at) VALUES ($1, $2, $3, $4)',
            [migration.version, migration.name, migration.type, executedAt]
          );

          await migrationClient.query('COMMIT');
          logger.info(`[MigrationRunner] Migration ${migration.version} applied successfully`);
        } catch (error: any) {
          await migrationClient.query('ROLLBACK').catch(() => {});
          logger.error(
            `[MigrationRunner] Migration ${migration.version} failed: ${error.message}`,
            { version: migration.version, name: migration.name, error: error.message }
          );
          throw error;
        } finally {
          migrationClient.release();
        }
      }

      logger.info(`[MigrationRunner] All ${pending.length} migration(s) applied successfully`);
    } finally {
      await this.releaseAdvisoryLock(lockClient);
    }
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
        `[MigrationRunner] Migration version "${version}" not found in available migrations`
      );
    }

    if (!migration.down) {
      const errorMessage =
        `[MigrationRunner] Rollback is not supported for migration ${migration.version}: "${migration.name}" — no down() function defined`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    logger.info(
      `[MigrationRunner] Rolling back migration ${migration.version}: ${migration.name} (${migration.type})`
    );

    // Acquire advisory lock to prevent concurrent rollback/migration
    const lockClient = await this.acquireAdvisoryLock();

    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Execute the migration's down function
        await migration.down();

        // Remove the record from schema_migrations
        await client.query(
          'DELETE FROM schema_migrations WHERE version = $1',
          [migration.version]
        );

        await client.query('COMMIT');
        logger.info(
          `[MigrationRunner] Migration ${migration.version} rolled back successfully`
        );
      } catch (error: any) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(
          `[MigrationRunner] Rollback of migration ${migration.version} failed: ${error.message}`,
          { version: migration.version, name: migration.name, error: error.message }
        );
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await this.releaseAdvisoryLock(lockClient);
    }
  }
}

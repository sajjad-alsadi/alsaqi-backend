import cron, { ScheduledTask } from 'node-cron';
import { db } from '../db/index.js';
import logger from '../utils/logger.js';

/**
 * Partition naming convention: audit_trail_yYYYYmMM
 * Example: audit_trail_y2024m01 for January 2024
 */

export interface PartitionInfo {
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface PartitionConfig {
  tableName: string;
  partitionColumn: string;
  retentionMonths: number;
  autoCreateFuture: number;
}

const DEFAULT_CONFIG: PartitionConfig = {
  tableName: 'audit_trail',
  partitionColumn: 'timestamp',
  retentionMonths: parseInt(process.env.AUDIT_TRAIL_RETENTION_MONTHS || '24', 10),
  autoCreateFuture: 3,
};

/**
 * Generates a partition name from a date.
 * Format: audit_trail_yYYYYmMM
 */
export function getPartitionName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `audit_trail_y${year}m${month}`;
}

/**
 * Calculates the start and end dates for a monthly partition given a date.
 * Start: 1st of the month at 00:00:00
 * End: 1st of the next month at 00:00:00
 */
export function getPartitionDateRange(date: Date): { startDate: Date; endDate: Date } {
  const startDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1));
  const endDate = new Date(Date.UTC(date.getFullYear(), date.getMonth() + 1, 1));
  return { startDate, endDate };
}

/**
 * Returns the list of partition names that are older than the retention period.
 * @param partitions - List of existing partitions
 * @param retentionMonths - Number of months to retain
 * @param referenceDate - The reference date (defaults to now)
 */
export function getPartitionsToDropByRetention(
  partitions: PartitionInfo[],
  retentionMonths: number,
  referenceDate: Date = new Date()
): PartitionInfo[] {
  const cutoffDate = new Date(
    Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth() - retentionMonths, 1)
  );

  return partitions.filter((p) => p.endDate <= cutoffDate);
}

/**
 * Parses a partition name back into a date.
 * Expected format: audit_trail_yYYYYmMM
 */
export function parsePartitionName(name: string): Date | null {
  const match = name.match(/^audit_trail_y(\d{4})m(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // 0-indexed
  return new Date(Date.UTC(year, month, 1));
}

export class PartitionManager {
  private config: PartitionConfig;
  private cronJob: ScheduledTask | null = null;

  constructor(config?: Partial<PartitionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initializes the partitioned table structure.
   * - Creates the partitioned parent table
   * - Migrates existing data
   * - Creates initial partitions (current month + 3 future months)
   *
   * Only runs on external PostgreSQL (not PGlite).
   */
  async initialize(): Promise<void> {
    if (!db.isExternal) {
      logger.info('[PartitionManager] Skipping — partitioning requires external PostgreSQL.');
      return;
    }

    logger.info('[PartitionManager] Initializing audit_trail partitioning...');

    // Check if already partitioned (parent table is partitioned)
    const isPartitioned = await this.isTablePartitioned();
    if (isPartitioned) {
      logger.info('[PartitionManager] audit_trail is already partitioned. Ensuring future partitions exist...');
      await this.ensureFuturePartitions();
      return;
    }

    // Step 1: Create partitioned parent table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audit_trail_partitioned (
        id UUID DEFAULT gen_random_uuid(),
        "user" TEXT NOT NULL,
        action TEXT NOT NULL,
        module TEXT NOT NULL,
        details TEXT,
        hash TEXT,
        previous_hash TEXT,
        seq BIGSERIAL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, timestamp)
      ) PARTITION BY RANGE (timestamp)
    `);

    // Step 2: Create partitions for previous month, current month, and 3 future months
    const now = new Date();
    for (let i = -1; i <= this.config.autoCreateFuture; i++) {
      const partDate = new Date(Date.UTC(now.getFullYear(), now.getMonth() + i, 1));
      const { startDate, endDate } = getPartitionDateRange(partDate);
      const partName = getPartitionName(partDate);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS ${partName}
        PARTITION OF audit_trail_partitioned
        FOR VALUES FROM ('${startDate.toISOString()}') TO ('${endDate.toISOString()}')
      `);
      logger.info(`[PartitionManager] Created partition: ${partName}`);
    }

    // Step 3: Migrate existing data
    const existingData = await db.prepare(
      `SELECT COUNT(*) as count FROM audit_trail`
    ).get<{ count: number }>();

    if (existingData && existingData.count > 0) {
      logger.info(`[PartitionManager] Migrating ${existingData.count} rows to partitioned table...`);

      // Create partitions for any historical data that might exist
      const oldestRow = await db.prepare(
        `SELECT MIN(timestamp) as min_ts FROM audit_trail`
      ).get<{ min_ts: string | Date | null }>();

      if (oldestRow?.min_ts) {
        const oldestDate = new Date(oldestRow.min_ts);
        const currentDate = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));

        // Create partitions for all months between oldest data and current
        let iterDate = new Date(Date.UTC(oldestDate.getFullYear(), oldestDate.getMonth(), 1));
        while (iterDate < currentDate) {
          const { startDate, endDate } = getPartitionDateRange(iterDate);
          const partName = getPartitionName(iterDate);

          await db.exec(`
            CREATE TABLE IF NOT EXISTS ${partName}
            PARTITION OF audit_trail_partitioned
            FOR VALUES FROM ('${startDate.toISOString()}') TO ('${endDate.toISOString()}')
          `);

          iterDate = new Date(Date.UTC(iterDate.getFullYear(), iterDate.getMonth() + 1, 1));
        }
      }

      // Insert data into partitioned table. The hash-chain columns
      // (hash/previous_hash/seq) are carried over verbatim so the rebuilt table
      // preserves the existing chain linkage and ordering.
      await db.exec(`
        INSERT INTO audit_trail_partitioned (id, "user", action, module, details, hash, previous_hash, seq, timestamp)
        SELECT id, "user", action, module, details, hash, previous_hash, seq, timestamp
        FROM audit_trail
      `);
    }

    // Step 4: Swap tables
    await db.exec(`ALTER TABLE audit_trail RENAME TO audit_trail_old`);
    await db.exec(`ALTER TABLE audit_trail_partitioned RENAME TO audit_trail`);

    logger.info('[PartitionManager] Partitioning complete. Old table preserved as audit_trail_old.');
  }

  /**
   * Creates a single monthly partition.
   */
  async createPartition(startDate: Date, endDate: Date): Promise<void> {
    if (!db.isExternal) return;

    const partName = getPartitionName(startDate);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${partName}
      PARTITION OF audit_trail
      FOR VALUES FROM ('${startDate.toISOString()}') TO ('${endDate.toISOString()}')
    `);

    logger.info(`[PartitionManager] Created partition: ${partName} [${startDate.toISOString()} - ${endDate.toISOString()})`);
  }

  /**
   * Drops partitions older than the specified retention period.
   * Returns the names of dropped partitions.
   */
  async dropOldPartitions(retentionMonths?: number): Promise<string[]> {
    if (!db.isExternal) return [];

    const retention = retentionMonths ?? this.config.retentionMonths;
    const partitions = await this.listPartitions();
    const toDrop = getPartitionsToDropByRetention(partitions, retention);

    const dropped: string[] = [];
    for (const partition of toDrop) {
      try {
        await db.exec(`DROP TABLE IF EXISTS ${partition.name}`);
        dropped.push(partition.name);
        logger.info(`[PartitionManager] Dropped old partition: ${partition.name}`);
      } catch (err) {
        logger.error(`[PartitionManager] Failed to drop partition ${partition.name}:`, err);
      }
    }

    return dropped;
  }

  /**
   * Lists all existing partitions for the audit_trail table.
   */
  async listPartitions(): Promise<PartitionInfo[]> {
    if (!db.isExternal) return [];

    const rows = await db.prepare(`
      SELECT inhrelid::regclass::text AS partition_name
      FROM pg_inherits
      WHERE inhparent = 'audit_trail'::regclass
      ORDER BY inhrelid::regclass::text
    `).all<{ partition_name: string }>();

    const partitions: PartitionInfo[] = [];
    for (const row of rows) {
      const name = row.partition_name;
      const date = parsePartitionName(name);
      if (date) {
        const { startDate, endDate } = getPartitionDateRange(date);
        partitions.push({ name, startDate, endDate });
      }
    }

    return partitions;
  }

  /**
   * Schedules a monthly cron job (1st of each month at midnight)
   * to create future partitions and drop old ones.
   */
  scheduleMaintenanceJob(): void {
    if (!db.isExternal) {
      logger.info('[PartitionManager] Skipping cron — partitioning requires external PostgreSQL.');
      return;
    }

    // Schedule: 1st of each month at midnight
    this.cronJob = cron.schedule('0 0 1 * *', async () => {
      logger.info('[PartitionManager] Running monthly partition maintenance...');
      try {
        await this.ensureFuturePartitions();
        await this.dropOldPartitions();
        logger.info('[PartitionManager] Monthly maintenance completed.');
      } catch (err) {
        logger.error('[PartitionManager] Monthly maintenance failed:', err);
      }
    });

    logger.info('[PartitionManager] Monthly maintenance job scheduled (1st of each month at midnight).');
  }

  /**
   * Stops the scheduled cron job.
   */
  stopMaintenanceJob(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * Ensures the next N future monthly partitions exist.
   */
  private async ensureFuturePartitions(): Promise<void> {
    const now = new Date();
    for (let i = 0; i <= this.config.autoCreateFuture; i++) {
      const partDate = new Date(Date.UTC(now.getFullYear(), now.getMonth() + i, 1));
      const { startDate, endDate } = getPartitionDateRange(partDate);
      await this.createPartition(startDate, endDate);
    }
  }

  /**
   * Checks if the audit_trail table is already partitioned.
   */
  private async isTablePartitioned(): Promise<boolean> {
    try {
      const result = await db.prepare(`
        SELECT relkind FROM pg_class WHERE relname = 'audit_trail'
      `).get<{ relkind: string }>();
      // 'p' means partitioned table
      return result?.relkind === 'p';
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const partitionManager = new PartitionManager();

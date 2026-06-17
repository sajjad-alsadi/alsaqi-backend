import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import cron, { ScheduledTask } from 'node-cron';
import { db } from '../db/index';
import logger from './logger';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '7', 10);

// --- Interfaces ---

export interface BackupConfig {
  schedule: string;          // cron expression (default: '0 2 * * *' = daily at 2 AM)
  retentionDays: number;     // days to keep backups (default: 30)
  backupDir: string;         // backup storage directory
  encryptBackups: boolean;   // whether to encrypt backup files
  notifyOnFailure: boolean;  // send notification on failure
}

export interface BackupResult {
  id: string;
  timestamp: string;
  size: number;
  duration: number;
  status: 'success' | 'partial' | 'failed';
  errors?: string[];
}

export interface BackupRecord {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'success' | 'partial' | 'failed';
  type: 'scheduled' | 'manual';
  size_bytes: number;
  tables_count: number;
  file_path: string;
  error_message: string | null;
  verified: boolean;
  verified_at: string | null;
}

// --- Default config ---

const DEFAULT_CONFIG: BackupConfig = {
  schedule: '0 2 * * *',
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
  backupDir: BACKUP_DIR,
  encryptBackups: process.env.ENCRYPT_BACKUPS === 'true',
  notifyOnFailure: true,
};

// --- BackupScheduler Class ---

export class BackupScheduler {
  private config: BackupConfig;
  private task: ScheduledTask | null = null;
  private running = false;

  constructor(config?: Partial<BackupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Starts the cron schedule for automated backups.
   */
  start(config?: Partial<BackupConfig>): void {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    if (this.task) {
      logger.warn('[BACKUP] Scheduler already running. Stopping previous schedule.');
      this.stop();
    }

    if (!cron.validate(this.config.schedule)) {
      logger.error(`[BACKUP] Invalid cron expression: ${this.config.schedule}`);
      return;
    }

    this.task = cron.schedule(this.config.schedule, async () => {
      logger.info('[BACKUP] Scheduled backup triggered.');
      try {
        await this.executeBackup('scheduled');
      } catch (error) {
        logger.error('[BACKUP] Scheduled backup failed:', error);
      }
    });

    this.running = true;
    logger.info(`[BACKUP] Scheduler started with schedule: ${this.config.schedule}`);
  }

  /**
   * Stops the cron schedule.
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    this.running = false;
    logger.info('[BACKUP] Scheduler stopped.');
  }

  /**
   * Triggers an immediate backup and returns the result.
   */
  async runNow(): Promise<BackupResult> {
    logger.info('[BACKUP] Manual backup triggered.');
    return this.executeBackup('manual');
  }

  /**
   * Queries the backup_history table and returns recent backup records.
   */
  async getHistory(limit = 20): Promise<BackupRecord[]> {
    try {
      const rows = await db.prepare(
        `SELECT id, started_at, completed_at, status, type, size_bytes, tables_count, file_path, error_message, verified, verified_at
         FROM backup_history
         ORDER BY started_at DESC
         LIMIT ?`
      ).all(limit);
      return rows as BackupRecord[];
    } catch (error) {
      logger.error('[BACKUP] Failed to fetch backup history:', error);
      return [];
    }
  }

  /**
   * Returns whether the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Core backup execution logic. Supports both PGlite (JSON) and external PostgreSQL (pg_dump).
   */
  private async executeBackup(type: 'scheduled' | 'manual'): Promise<BackupResult> {
    const startTime = Date.now();
    const backupId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const errors: string[] = [];

    // Record start in backup_history
    await this.saveRecord({
      id: backupId,
      started_at: timestamp,
      completed_at: null,
      status: 'running',
      type,
      size_bytes: 0,
      tables_count: 0,
      file_path: '',
      error_message: null,
      verified: false,
      verified_at: null,
    });

    let filePath = '';
    let sizeBytes = 0;
    let tablesCount = 0;
    let status: 'success' | 'partial' | 'failed' = 'success';

    try {
      // Ensure backup directory exists
      if (!fs.existsSync(this.config.backupDir)) {
        fs.mkdirSync(this.config.backupDir, { recursive: true });
      }

      if (db.isExternal) {
        // External PostgreSQL: use pg_dump with gzip compression
        const dumpFile = `backup_${backupId}.sql.gz`;
        filePath = path.join(this.config.backupDir, dumpFile);

        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is not set for external PostgreSQL backup');
        }

        await new Promise<void>((resolve, reject) => {
          const pgDump = spawn('pg_dump', [databaseUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
          const gzip = spawn('gzip', [], { stdio: ['pipe', 'pipe', 'pipe'] });
          const output = fs.createWriteStream(filePath);

          pgDump.stdout.pipe(gzip.stdin);
          gzip.stdout.pipe(output);

          let pgDumpStderr = '';
          let gzipStderr = '';
          pgDump.stderr.on('data', (data) => { pgDumpStderr += data.toString(); });
          gzip.stderr.on('data', (data) => { gzipStderr += data.toString(); });

          let exitCount = 0;
          const checkDone = () => {
            exitCount++;
            if (exitCount === 2) {
              output.end(() => resolve());
            }
          };

          pgDump.on('error', (err) => reject(new Error(`pg_dump spawn failed: ${err.message}`)));
          gzip.on('error', (err) => reject(new Error(`gzip spawn failed: ${err.message}`)));

          pgDump.on('close', (code) => {
            if (code !== 0) {
              gzip.kill();
              reject(new Error(`pg_dump exited with code ${code}: ${pgDumpStderr.trim()}`));
              return;
            }
            checkDone();
          });
          gzip.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`gzip exited with code ${code}: ${gzipStderr.trim()}`));
              return;
            }
            checkDone();
          });
        });

        const stat = fs.statSync(filePath);
        sizeBytes = stat.size;

        // Verify backup integrity (file size > 0)
        if (sizeBytes === 0) {
          throw new Error('pg_dump produced an empty backup file');
        }

        tablesCount = -1; // Unknown for pg_dump (full database)
      } else {
        // PGlite: use existing JSON backup logic
        const result = await createBackupInternal(this.config.backupDir, backupId);
        filePath = result.path;
        sizeBytes = result.size;
        tablesCount = result.tablesCount;

        if (result.errors.length > 0) {
          errors.push(...result.errors);
          status = result.tablesCount > 0 ? 'partial' : 'failed';
        }
      }
    } catch (error: any) {
      status = 'failed';
      errors.push(error.message || String(error));
      logger.error('[BACKUP] Backup execution failed:', error);
    }

    const duration = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    // Update backup_history record
    await this.updateRecord(backupId, {
      completed_at: completedAt,
      status,
      size_bytes: sizeBytes,
      tables_count: tablesCount,
      file_path: filePath,
      error_message: errors.length > 0 ? errors.join('; ') : null,
      verified: sizeBytes > 0,
      verified_at: sizeBytes > 0 ? completedAt : null,
    });

    // Apply retention policy
    await this.applyRetentionPolicy();

    // Notify admins on failure
    if (status === 'failed' && this.config.notifyOnFailure) {
      await this.notifyAdminsOnFailure(backupId, errors);
    }

    const result: BackupResult = {
      id: backupId,
      timestamp,
      size: sizeBytes,
      duration,
      status,
      ...(errors.length > 0 && { errors }),
    };

    logger.info(`[BACKUP] Backup ${backupId} completed with status: ${status} (${duration}ms, ${sizeBytes} bytes)`);
    return result;
  }

  /**
   * Saves a new backup record to the backup_history table.
   */
  private async saveRecord(record: BackupRecord): Promise<void> {
    try {
      await db.prepare(
        `INSERT INTO backup_history (id, started_at, completed_at, status, type, size_bytes, tables_count, file_path, error_message, verified, verified_at)
         VALUES (?::uuid, ?::timestamptz, ${record.completed_at ? '?::timestamptz' : 'NULL'}, ?::text, ?::text, ?, ?, ?::text, ${record.error_message ? '?::text' : 'NULL'}, ?, ${record.verified_at ? '?::timestamptz' : 'NULL'})`
      ).run(
        ...[
          record.id,
          record.started_at,
          ...(record.completed_at ? [record.completed_at] : []),
          record.status,
          record.type,
          record.size_bytes,
          record.tables_count,
          record.file_path,
          ...(record.error_message ? [record.error_message] : []),
          record.verified,
          ...(record.verified_at ? [record.verified_at] : []),
        ]
      );
    } catch (error) {
      logger.error('[BACKUP] Failed to save backup record:', error);
    }
  }

  /**
   * Updates an existing backup record in the backup_history table.
   */
  private async updateRecord(id: string, updates: Partial<BackupRecord>): Promise<void> {
    try {
      await db.prepare(
        `UPDATE backup_history
         SET completed_at = ?::timestamptz,
             status = ?::text,
             size_bytes = ?,
             tables_count = ?,
             file_path = ?::text,
             error_message = ${updates.error_message ? '?::text' : 'NULL'},
             verified = ?,
             verified_at = ${updates.verified_at ? '?::timestamptz' : 'NULL'}
         WHERE id = ?::uuid`
      ).run(
        ...[
          updates.completed_at || null,
          updates.status || 'failed',
          updates.size_bytes || 0,
          updates.tables_count || 0,
          updates.file_path || '',
          ...(updates.error_message ? [updates.error_message] : []),
          updates.verified || false,
          ...(updates.verified_at ? [updates.verified_at] : []),
          id,
        ]
      );
    } catch (error) {
      logger.error('[BACKUP] Failed to update backup record:', error);
    }
  }

  /**
   * Applies retention policy: deletes backups older than retentionDays.
   */
  private async applyRetentionPolicy(): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
      const cutoffStr = cutoffDate.toISOString();

      // Get old backup records
      const oldRecords = await db.prepare(
        `SELECT id, file_path FROM backup_history WHERE started_at < ? AND status != 'running'`
      ).all(cutoffStr) as BackupRecord[];

      for (const record of oldRecords) {
        // Delete backup file from disk
        if (record.file_path && fs.existsSync(record.file_path)) {
          try {
            const stat = fs.statSync(record.file_path);
            if (stat.isDirectory()) {
              fs.rmSync(record.file_path, { recursive: true, force: true });
            } else {
              fs.unlinkSync(record.file_path);
            }
          } catch (err) {
            logger.warn(`[BACKUP] Failed to delete old backup file: ${record.file_path}`, err);
          }
        }

        // Delete record from database
        await db.prepare(`DELETE FROM backup_history WHERE id = ?::uuid`).run(record.id);
      }

      if (oldRecords.length > 0) {
        logger.info(`[BACKUP] Retention policy applied: removed ${oldRecords.length} old backup(s)`);
      }
    } catch (error) {
      logger.warn('[BACKUP] Retention policy application failed:', error);
    }
  }

  /**
   * Notifies admin users when a backup fails.
   */
  private async notifyAdminsOnFailure(backupId: string, errors: string[]): Promise<void> {
    try {
      // Dynamically import to avoid circular dependencies
      const { NotificationService } = await import('../services/NotificationService');
      const { UserRole } = await import('@alsaqi/shared');

      const admins = await db.prepare(
        `SELECT id FROM users WHERE role = ?`
      ).all(UserRole.ADMIN) as Array<{ id: string }>;

      const adminIds = admins.map(a => a.id);
      if (adminIds.length === 0) return;

      await NotificationService.create(
        adminIds,
        'backup_failed',
        `Backup ${backupId} failed: ${errors.join('; ')}`,
        'system',
        '/admin/backups'
      );

      logger.info(`[BACKUP] Failure notification sent to ${adminIds.length} admin(s)`);
    } catch (error) {
      logger.error('[BACKUP] Failed to send failure notification:', error);
    }
  }
}

// --- Internal helper for PGlite JSON backup ---

interface InternalBackupResult {
  path: string;
  size: number;
  tablesCount: number;
  errors: string[];
}

async function createBackupInternal(
  backupDir: string,
  backupId: string
): Promise<InternalBackupResult> {
  const errors: string[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `backup_${backupId}_${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });

  // Critical tables to backup
  const tables = [
    'users',
    'audit_programs',
    'audit_plans',
    'audit_tasks',
    'audit_findings',
    'recommendations',
    'risk_register',
    'incoming_correspondence',
    'outgoing_correspondence',
    'notifications',
  ];

  let backedUp = 0;
  let totalSize = 0;

  for (const table of tables) {
    try {
      const rows = await db.prepare(`SELECT * FROM ${db.validateIdentifier(table)}`).all();
      const filePath = path.join(backupPath, `${table}.json`);
      const content = JSON.stringify(rows, null, 2);
      fs.writeFileSync(filePath, content);
      totalSize += Buffer.byteLength(content, 'utf8');
      backedUp++;
    } catch (err: any) {
      // Table might not exist yet
      if (!err.message?.includes('does not exist')) {
        errors.push(`Failed to backup table ${table}: ${err.message}`);
        logger.warn(`[BACKUP] Failed to backup table ${table}:`, err.message);
      }
    }
  }

  return {
    path: backupPath,
    size: totalSize,
    tablesCount: backedUp,
    errors,
  };
}

// --- Legacy createBackup function (preserved for backward compatibility) ---

/**
 * Creates a logical backup of critical database tables.
 * For PostgreSQL production: use pg_dump externally.
 * For PGlite development: exports table data as JSON files.
 *
 * @deprecated Use BackupScheduler.runNow() instead for new code.
 */
export async function createBackup(): Promise<string | null> {
  if (db.isExternal) {
    // For external PostgreSQL, log a reminder to use pg_dump
    logger.info('[BACKUP] External PostgreSQL detected. Use pg_dump for production backups.');
    return null;
  }

  try {
    // Ensure backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}`);
    fs.mkdirSync(backupPath, { recursive: true });

    // Critical tables to backup
    const tables = [
      'users',
      'audit_programs',
      'audit_plans',
      'audit_tasks',
      'audit_findings',
      'recommendations',
      'risk_register',
      'incoming_correspondence',
      'outgoing_correspondence',
      'notifications',
    ];

    let backedUp = 0;
    for (const table of tables) {
      try {
        const rows = await db.prepare(`SELECT * FROM ${db.validateIdentifier(table)}`).all();
        const filePath = path.join(backupPath, `${table}.json`);
        fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
        backedUp++;
      } catch (err: any) {
        // Table might not exist yet
        if (!err.message?.includes('does not exist')) {
          logger.warn(`[BACKUP] Failed to backup table ${table}:`, err.message);
        }
      }
    }

    logger.info(`[BACKUP] Created backup at ${backupPath} (${backedUp} tables)`);

    // Cleanup old backups
    await cleanupOldBackups();

    return backupPath;
  } catch (err) {
    logger.error('[BACKUP] Backup failed:', err);
    return null;
  }
}

async function cleanupOldBackups(): Promise<void> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const entries = fs.readdirSync(BACKUP_DIR)
      .filter(e => e.startsWith('backup_'))
      .sort()
      .reverse();

    // Keep only MAX_BACKUPS most recent
    for (let i = MAX_BACKUPS; i < entries.length; i++) {
      const dirPath = path.join(BACKUP_DIR, entries[i]);
      fs.rmSync(dirPath, { recursive: true, force: true });
      logger.info(`[BACKUP] Removed old backup: ${entries[i]}`);
    }
  } catch (err) {
    logger.warn('[BACKUP] Cleanup failed:', err);
  }
}

// Singleton instance for application-wide use
export const backupScheduler = new BackupScheduler();

export default { createBackup, BackupScheduler, backupScheduler };

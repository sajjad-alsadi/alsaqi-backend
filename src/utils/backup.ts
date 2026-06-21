import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import cron, { ScheduledTask } from 'node-cron';
import { db } from '../db/index';
import logger from './logger';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '7', 10);

// --- At-rest encryption constants (AES-256-GCM) ---
// Mirrors the format/derivation used by FileEncryptionService so backups follow
// the same cryptographic conventions as encrypted file uploads.
const BACKUP_ENC_ALGORITHM = 'aes-256-gcm';
const BACKUP_ENC_IV_LENGTH = 12;
const BACKUP_ENC_AUTH_TAG_LENGTH = 16;
const BACKUP_ENC_KEY_LENGTH = 32;
const BACKUP_HKDF_INFO = 'alsaqi-backup-encryption';
const BACKUP_HKDF_SALT = 'alsaqi-backup-enc-salt';
/** Suffix appended to the encrypted backup artifact. */
const BACKUP_ENC_SUFFIX = '.enc';

// --- Offsite store constants (Req 3.2, 3.7) ---
// The Offsite_Store is a destination that is physically/logically separate from
// the production host. Two transports are supported, in priority order:
//   1. An S3-compatible bucket (OFFSITE_S3_BUCKET) — AWS S3 or MinIO; the
//      @aws-sdk/client-s3 dependency is already used elsewhere in the project.
//   2. A separate filesystem directory/mount (OFFSITE_BACKUP_DIR).
// When neither is configured the offsite copy is skipped (development /
// backward-compatibility mode), mirroring the graceful degradation used for
// at-rest encryption when no key is configured.
function getOffsiteConfig(): { s3Bucket: string | null; dir: string | null } {
  return {
    s3Bucket: process.env.OFFSITE_S3_BUCKET || null,
    dir: process.env.OFFSITE_BACKUP_DIR || null,
  };
}

/**
 * Derives a 256-bit AES key for backup encryption from an existing configured
 * secret using HKDF-SHA256. Prefers FILE_ENCRYPTION_KEY and falls back to
 * FILE_ACCESS_SECRET (both are documented production secrets). Returns null when
 * no key material is configured, in which case backups are stored unencrypted
 * (backward-compatibility / development mode).
 */
function getBackupEncryptionKey(): Buffer | null {
  const rawKey = process.env.FILE_ENCRYPTION_KEY || process.env.FILE_ACCESS_SECRET;
  if (!rawKey) {
    return null;
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(rawKey, 'utf8'),
    Buffer.from(BACKUP_HKDF_SALT, 'utf8'),
    Buffer.from(BACKUP_HKDF_INFO, 'utf8'),
    BACKUP_ENC_KEY_LENGTH
  );
  return Buffer.from(derived);
}

/**
 * Encrypts a file at rest using AES-256-GCM, streaming the source so large
 * backups never need to be buffered entirely in memory.
 *
 * Output format: [IV (12 bytes)][Ciphertext...][AuthTag (16 bytes)]
 * (the auth tag is appended last because it is only available once the cipher
 * has consumed the entire input — this keeps the operation fully streaming).
 *
 * The destination file is created with 0o600 permissions (owner read/write).
 */
function encryptFileAtRest(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iv = crypto.randomBytes(BACKUP_ENC_IV_LENGTH);
    const cipher = crypto.createCipheriv(BACKUP_ENC_ALGORITHM, key, iv, {
      authTagLength: BACKUP_ENC_AUTH_TAG_LENGTH,
    });

    const input = fs.createReadStream(srcPath);
    const output = fs.createWriteStream(destPath, { mode: 0o600 });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      cipher.destroy();
      output.destroy();
      reject(err);
    };

    input.on('error', fail);
    cipher.on('error', fail);
    output.on('error', fail);

    // Prepend the IV, then stream the ciphertext (don't end the stream yet so we
    // can append the auth tag once the cipher has flushed all data).
    output.write(iv);
    input.pipe(cipher).pipe(output, { end: false });

    cipher.on('end', () => {
      if (settled) return;
      try {
        const authTag = cipher.getAuthTag();
        output.end(authTag, () => {
          if (settled) return;
          settled = true;
          resolve();
        });
      } catch (err) {
        fail(err as Error);
      }
    });
  });
}

/**
 * Bundles the database dump output together with the UPLOAD_DIR contents into a
 * single gzipped tar archive using the system `tar` binary (consistent with the
 * existing pg_dump/gzip usage). Accepts both a single dump file and a dump
 * directory (PGlite JSON export).
 */
function createCombinedArchive(
  archivePath: string,
  dumpPath: string,
  uploadDir: string | null
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-czf',
      archivePath,
      '-C',
      path.dirname(dumpPath),
      path.basename(dumpPath),
    ];

    if (uploadDir) {
      const resolvedUpload = path.resolve(uploadDir);
      args.push('-C', path.dirname(resolvedUpload), path.basename(resolvedUpload));
    }

    const tar = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    tar.stderr.on('data', (data) => { stderr += data.toString(); });
    tar.on('error', (err) => reject(new Error(`tar spawn failed: ${err.message}`)));
    tar.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Copies a finished backup artifact to an S3-compatible Offsite_Store
 * (AWS S3 or MinIO via the @aws-sdk/client-s3 dependency). The object key is
 * the artifact's file name. Configurable via:
 *   - OFFSITE_S3_BUCKET   (required to enable S3 transport)
 *   - OFFSITE_S3_PREFIX   (optional key prefix, e.g. "backups/")
 *   - OFFSITE_S3_ENDPOINT (optional, for MinIO / non-AWS endpoints)
 *   - OFFSITE_S3_REGION   (optional, defaults to AWS_REGION or "us-east-1")
 *
 * Streams the file so large backups are never buffered in memory. Rejects on
 * any failure so the caller marks the cycle failed (Req 3.7).
 */
async function copyToOffsiteS3(srcPath: string, bucket: string): Promise<string> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const region = process.env.OFFSITE_S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const endpoint = process.env.OFFSITE_S3_ENDPOINT || undefined;
  const prefix = process.env.OFFSITE_S3_PREFIX || '';
  const key = `${prefix}${path.basename(srcPath)}`;

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });

  try {
    const body = fs.createReadStream(srcPath);
    const contentLength = fs.statSync(srcPath).size;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: contentLength,
      })
    );
    return `s3://${bucket}/${key}`;
  } finally {
    client.destroy();
  }
}

/**
 * Copies a finished backup artifact to a filesystem Offsite_Store directory
 * (a separate disk/mount/NFS export). Streams the copy and fsyncs the
 * destination so the offsite copy is durable before the cycle is considered
 * complete. Rejects on any failure so the caller marks the cycle failed
 * (Req 3.7).
 */
function copyToOffsiteDir(srcPath: string, offsiteDir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    try {
      const resolvedDir = path.resolve(offsiteDir);
      if (!fs.existsSync(resolvedDir)) {
        fs.mkdirSync(resolvedDir, { recursive: true });
      }
      const destPath = path.join(resolvedDir, path.basename(srcPath));

      const input = fs.createReadStream(srcPath);
      const output = fs.createWriteStream(destPath, { mode: 0o600 });

      input.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve(destPath);
      });

      input.pipe(output);
    } catch (err) {
      fail(err as Error);
    }
  });
}

/**
 * Copies the retained backup artifact to the configured Offsite_Store within
 * the same backup cycle (Req 3.2). Prefers the S3-compatible transport, then
 * falls back to a filesystem directory. Returns the offsite location, or null
 * when no offsite destination is configured (development mode). Rejects on
 * failure so the cycle is marked failed and not verified (Req 3.7).
 */
async function copyToOffsiteStore(srcPath: string): Promise<string | null> {
  const { s3Bucket, dir } = getOffsiteConfig();

  if (s3Bucket) {
    return copyToOffsiteS3(srcPath, s3Bucket);
  }
  if (dir) {
    return copyToOffsiteDir(srcPath, dir);
  }
  return null;
}

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
  /** Whether the cycle's output was verified (never true for a failed cycle). */
  verified: boolean;
  /** Offsite_Store location of the artifact, or null when not copied offsite. */
  offsiteLocation: string | null;
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
    let offsiteLocation: string | null = null;
    // Tracks the actually-retained artifact path so that, even if a later step
    // in the storage pipeline (e.g. the offsite copy) throws, the backup_history
    // record still points at the real on-disk artifact and retention can reclaim
    // it (otherwise the encrypted file is orphaned — unbounded growth, I-5).
    let retainedArtifactPath: string | null = null;

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

      // Storage step (Req 3.1, 3.2, 3.3): bundle the dump together with the
      // UPLOAD_DIR contents, encrypt the result with AES-256, then copy it to
      // the Offsite_Store within the same cycle. Encryption failure (Req 3.4)
      // or offsite-copy failure (Req 3.7) throws below and marks the cycle
      // failed (and never verified). Skipped when the dump produced no output.
      if (status !== 'failed' && filePath) {
        const stored = await this.storeBackup(backupId, filePath, (retainedPath) => {
          // Record the retained artifact path as soon as it exists, BEFORE the
          // offsite copy that may throw, so a failed cycle still tracks the file
          // for retention/cleanup (I-5).
          retainedArtifactPath = retainedPath;
        });
        filePath = stored.path;
        sizeBytes = stored.size;
        offsiteLocation = stored.offsiteLocation;
      }
    } catch (error: any) {
      status = 'failed';
      errors.push(error.message || String(error));
      // If a retained artifact was produced before the failure (e.g. the offsite
      // copy threw after encryption), keep its path on the record so retention
      // can reclaim it rather than orphaning the file (I-5).
      if (retainedArtifactPath) {
        filePath = retainedArtifactPath;
        try {
          sizeBytes = fs.statSync(retainedArtifactPath).size;
        } catch {
          // Best-effort: leave sizeBytes as-is if the artifact can't be stat'd.
        }
      }
      logger.error('[BACKUP] Backup execution failed:', error);
    }

    const duration = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    // A cycle is only "verified" when it did not fail AND produced output.
    // Encryption (Req 3.4) or offsite-copy (Req 3.7) failures set status to
    // 'failed' above, which must never be recorded as verified — even though a
    // local artifact (sizeBytes > 0) may have been produced before the failure.
    const verified = status !== 'failed' && sizeBytes > 0;

    // Update backup_history record
    await this.updateRecord(backupId, {
      completed_at: completedAt,
      status,
      size_bytes: sizeBytes,
      tables_count: tablesCount,
      file_path: filePath,
      error_message: errors.length > 0 ? errors.join('; ') : null,
      verified,
      verified_at: verified ? completedAt : null,
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
      verified,
      offsiteLocation,
      ...(errors.length > 0 && { errors }),
    };

    logger.info(
      `[BACKUP] Backup ${backupId} completed with status: ${status} ` +
        `(${duration}ms, ${sizeBytes} bytes, verified=${verified}, offsite=${offsiteLocation ?? 'none'})`
    );
    return result;
  }

  /**
   * Storage step for a freshly produced backup (Req 3.1, 3.3).
   *
   * 1. Bundles the DB dump together with the contents of the directory named by
   *    `UPLOAD_DIR` into a single gzipped tar archive (so user-uploaded files
   *    are part of the backup set).
   * 2. Encrypts that archive at rest with AES-256-GCM before retention, using a
   *    key derived from an existing configured secret (FILE_ENCRYPTION_KEY, or
   *    FILE_ACCESS_SECRET as a fallback). The original (unencrypted) dump and
   *    intermediate archive are removed once encryption succeeds.
   *
   * If no encryption key is configured, the combined archive is retained
   * unencrypted (development / backward-compatibility mode), mirroring the
   * graceful-degradation behaviour used for file uploads.
   *
   * Once the retained artifact is finalized it is copied to the configured
   * Offsite_Store within the same backup cycle (Req 3.2).
   *
   * Throws if archiving, encryption, OR the offsite copy fails so the caller
   * marks the cycle as failed and never records it as verified (Req 3.4, 3.7).
   *
   * @returns the path/size of the retained artifact and the offsite location
   *          (null when no offsite destination is configured).
   */
  private async storeBackup(
    backupId: string,
    dumpPath: string,
    onRetained?: (retainedPath: string) => void
  ): Promise<{ path: string; size: number; offsiteLocation: string | null }> {
    const uploadDir = process.env.UPLOAD_DIR
      ? path.resolve(process.env.UPLOAD_DIR)
      : null;

    let includeUploads: string | null = null;
    if (uploadDir && fs.existsSync(uploadDir)) {
      includeUploads = uploadDir;
    } else if (uploadDir) {
      logger.warn(`[BACKUP] UPLOAD_DIR "${uploadDir}" does not exist; backing up database output only.`);
    }

    // 1. Combine the dump and uploads into a single gzipped tar archive.
    const archivePath = path.join(this.config.backupDir, `backup_${backupId}.tar.gz`);
    await createCombinedArchive(archivePath, dumpPath, includeUploads);

    // 2. Encrypt the archive at rest with AES-256 before retention.
    const key = getBackupEncryptionKey();
    let retainedPath: string;
    if (!key) {
      logger.warn(
        '[BACKUP] No encryption key configured (FILE_ENCRYPTION_KEY/FILE_ACCESS_SECRET). ' +
          'Backup archive will be stored unencrypted.'
      );
      // Remove the original dump now that it is bundled into the archive.
      this.removeArtifact(dumpPath);
      retainedPath = archivePath;
    } else {
      const encryptedPath = `${archivePath}${BACKUP_ENC_SUFFIX}`;
      await encryptFileAtRest(archivePath, encryptedPath, key);

      // Encryption succeeded: drop the plaintext dump and intermediate archive
      // so only the encrypted artifact is retained.
      this.removeArtifact(dumpPath);
      this.removeArtifact(archivePath);
      logger.info(`[BACKUP] Backup ${backupId} encrypted at rest (AES-256-GCM): ${encryptedPath}`);
      retainedPath = encryptedPath;
    }

    const stat = fs.statSync(retainedPath);

    // The retained artifact now exists on disk. Surface its path to the caller
    // BEFORE the offsite copy (which may throw) so a failed cycle still tracks
    // the real artifact for retention/cleanup (I-5).
    onRetained?.(retainedPath);

    // 3. Copy the retained (encrypted) artifact to the Offsite_Store within the
    //    same backup cycle (Req 3.2). A failure here throws so the cycle is
    //    marked failed and not verified (Req 3.7).
    const offsiteLocation = await copyToOffsiteStore(retainedPath);
    if (offsiteLocation) {
      logger.info(`[BACKUP] Backup ${backupId} copied to Offsite_Store: ${offsiteLocation}`);
    } else {
      logger.warn(
        `[BACKUP] No Offsite_Store configured (OFFSITE_S3_BUCKET/OFFSITE_BACKUP_DIR); ` +
          `backup ${backupId} retained locally only.`
      );
    }

    return { path: retainedPath, size: stat.size, offsiteLocation };
  }

  /**
   * Best-effort removal of an intermediate backup artifact (file or directory).
   */
  private removeArtifact(target: string): void {
    try {
      if (!target || !fs.existsSync(target)) return;
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
    } catch (err) {
      logger.warn(`[BACKUP] Failed to remove intermediate artifact: ${target}`, err);
    }
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

/**
 * Internal helpers exposed for unit testing the at-rest encryption and
 * UPLOAD_DIR bundling behaviour (Req 3.1, 3.3). Not part of the public API.
 */
export const __testing = {
  getBackupEncryptionKey,
  encryptFileAtRest,
  createCombinedArchive,
  getOffsiteConfig,
  copyToOffsiteStore,
  copyToOffsiteDir,
  BACKUP_ENC_ALGORITHM,
  BACKUP_ENC_IV_LENGTH,
  BACKUP_ENC_AUTH_TAG_LENGTH,
  BACKUP_ENC_SUFFIX,
};

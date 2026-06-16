import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { db } from '../db/index';
import { AuthError, NotFoundError } from '../utils/errors';
import logger from '../utils/logger';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface TOTPSetupResult {
  secret: string;           // base32 encoded (for manual entry)
  qrCodeDataUrl: string;    // data:image/png;base64,...
  backupCodes: string[];    // 10 plaintext codes (shown once to user)
}

export interface TOTPService {
  setup(userId: string): Promise<TOTPSetupResult>;
  verify(userId: string, token: string): Promise<boolean>;
  disable(userId: string, password: string): Promise<void>;
  useBackupCode(userId: string, code: string): Promise<boolean>;
  isEnabled(userId: string): Promise<boolean>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const HKDF_INFO = 'alsaqi-totp-encryption';
const HKDF_SALT = 'alsaqi-totp-enc-salt';
const ISSUER = 'AL-SAQI';
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

// ─── Encryption Helpers ──────────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const rawKey = process.env.TOTP_ENCRYPTION_KEY || process.env.FILE_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('TOTP_ENCRYPTION_KEY or FILE_ENCRYPTION_KEY must be set for 2FA functionality');
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(rawKey, 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(HKDF_INFO, 'utf8'),
    KEY_LENGTH
  );
  return Buffer.from(derived);
}

function encryptSecret(secret: string): { encrypted: string; iv: string; tag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptSecret(encrypted: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ─── Backup Code Helpers ─────────────────────────────────────────────────────

function generateBackupCodes(): string[] {
  const codes: string[] = [];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code = '';
    const randomBytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
      code += chars[randomBytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

function hashBackupCodes(codes: string[]): string[] {
  return codes.map((code) => bcrypt.hashSync(code, 10));
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class TOTPServiceImpl implements TOTPService {
  /**
   * Sets up TOTP for a user.
   * Generates a TOTP secret, encrypts it, generates a QR code,
   * generates 10 backup codes (stored as bcrypt hashes), and saves to user_totp table.
   *
   * @param userId - The user ID to set up 2FA for
   * @returns The setup result with secret, QR code, and backup codes
   */
  async setup(userId: string): Promise<TOTPSetupResult> {
    // Fetch user info for the TOTP label
    const user = await db.prepare('SELECT username, email FROM users WHERE id = ?').get(userId) as any;
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Generate TOTP secret
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: user.username || user.email,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    });

    const base32Secret = totp.secret.base32;

    // Encrypt the secret for storage
    const { encrypted, iv, tag } = encryptSecret(base32Secret);

    // Generate QR code data URL
    const otpauthUri = totp.toString();
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

    // Generate backup codes
    const backupCodes = generateBackupCodes();
    const hashedCodes = hashBackupCodes(backupCodes);
    const backupCodesJson = JSON.stringify(hashedCodes);

    // Delete any existing TOTP record for this user (re-setup scenario)
    await db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);

    // Insert new TOTP record
    await db.prepare(`
      INSERT INTO user_totp (user_id, secret_encrypted, secret_iv, secret_tag, is_enabled, backup_codes_hash, created_at)
      VALUES (?::text, ?::text, ?::text, ?::text, FALSE, ?::text, CURRENT_TIMESTAMP)
    `).run(userId, encrypted, iv, tag, backupCodesJson);

    logger.info(`[TOTPService] 2FA setup initiated for user ${userId}`);

    return {
      secret: base32Secret,
      qrCodeDataUrl,
      backupCodes,
    };
  }

  /**
   * Verifies a TOTP code against the stored secret.
   * Uses timing-safe comparison and accepts codes within ±1 time window (±30 seconds).
   * Updates last_used_at on success.
   *
   * @param userId - The user ID to verify for
   * @param token - The 6-digit TOTP code
   * @returns true if the code is valid, false otherwise
   */
  async verify(userId: string, token: string): Promise<boolean> {
    // Per-user 2FA attempt limiting: after 5 failed attempts within 15 minutes,
    // block further 2FA verification to prevent brute-force attacks (Req 2FA.1).
    const MAX_2FA_ATTEMPTS = 5;
    const ATTEMPT_WINDOW_MINUTES = 15;
    
    const attemptRecord = await db.prepare(
      `SELECT totp_failed_attempts, totp_locked_until FROM users WHERE id = ?`
    ).get(userId) as any;
    
    if (attemptRecord?.totp_locked_until && new Date(attemptRecord.totp_locked_until) > new Date()) {
      logger.warn(`[TOTPService] 2FA locked for user ${userId} until ${attemptRecord.totp_locked_until}`);
      return false;
    }

    // Read last_used_at alongside the secret so reuse within the validity
    // window can be rejected (replay protection).
    const record = await db.prepare(
      'SELECT secret_encrypted, secret_iv, secret_tag, is_enabled, last_used_at FROM user_totp WHERE user_id = ?'
    ).get(userId) as any;

    if (!record) {
      return false;
    }

    // Decrypt the stored secret
    const secret = decryptSecret(record.secret_encrypted, record.secret_iv, record.secret_tag);

    // Create TOTP instance for verification
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: userId,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    // Validate with ±1 window.
    // OTPAuth.TOTP.validate returns the time-step difference (delta) or null if invalid.
    const delta = totp.validate({ token, window: 1 });

    if (delta === null) {
      logger.warn(`[TOTPService] TOTP verification failed for user ${userId}`);
      await this.recordFailed2FAAttempt(userId, MAX_2FA_ATTEMPTS, ATTEMPT_WINDOW_MINUTES);
      return false;
    }

    // Defense-in-depth: constant-time comparison against the code expected for
    // the matched time step. The result GATES acceptance — a mismatch (or a
    // length difference) is treated as a failed verification.
    const matchTimestamp = Date.now() + delta * TOTP_PERIOD * 1000;
    const expectedToken = totp.generate({ timestamp: matchTimestamp });
    const tokenBuffer = Buffer.from(token.padStart(TOTP_DIGITS, '0'), 'utf8');
    const expectedBuffer = Buffer.from(expectedToken.padStart(TOTP_DIGITS, '0'), 'utf8');
    const constantTimeMatch =
      tokenBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(tokenBuffer, expectedBuffer);

    if (!constantTimeMatch) {
      logger.warn(`[TOTPService] TOTP verification failed for user ${userId}`);
      await this.recordFailed2FAAttempt(userId, MAX_2FA_ATTEMPTS, ATTEMPT_WINDOW_MINUTES);
      return false;
    }

    // Replay protection: reject a code reused within its validity window.
    // Compute the start of the matched code's time step; if a successful
    // verification was already recorded at or after that instant, the same
    // (or an equally-recent) code has already been consumed.
    const matchedCounter = Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta;
    const codeWindowStartMs = matchedCounter * TOTP_PERIOD * 1000;
    if (record.last_used_at) {
      const lastUsedMs = new Date(record.last_used_at).getTime();
      if (!Number.isNaN(lastUsedMs) && lastUsedMs >= codeWindowStartMs) {
        logger.warn(`[TOTPService] TOTP replay rejected for user ${userId}`);
        await this.recordFailed2FAAttempt(userId, MAX_2FA_ATTEMPTS, ATTEMPT_WINDOW_MINUTES);
        return false;
      }
    }

    // Record this successful use to block subsequent replays and reset 2FA attempt counter.
    await db.prepare(
      'UPDATE user_totp SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(userId);
    await db.prepare(
      'UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = ?'
    ).run(userId);

    logger.info(`[TOTPService] TOTP verified successfully for user ${userId}`);
    return true;
  }

  /**
   * Disables 2FA for a user after verifying their current password.
   * Deletes the user_totp record.
   *
   * @param userId - The user ID to disable 2FA for
   * @param password - The user's current password for confirmation
   * @throws AuthError if the password is incorrect
   * @throws NotFoundError if the user or TOTP record is not found
   */
  async disable(userId: string, password: string): Promise<void> {
    // Verify the user's password first
    const user = await db.prepare('SELECT id, password FROM users WHERE id = ?').get(userId) as any;
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      throw new AuthError('Incorrect password');
    }

    // Check if 2FA is actually enabled
    const record = await db.prepare('SELECT id FROM user_totp WHERE user_id = ?').get(userId) as any;
    if (!record) {
      throw new NotFoundError('2FA is not configured for this user');
    }

    // Delete the TOTP record
    await db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);

    logger.info(`[TOTPService] 2FA disabled for user ${userId}`);
  }

  /**
   * Verifies a backup code against stored bcrypt hashes.
   * If valid, removes it from the list (single-use).
   *
   * @param userId - The user ID
   * @param code - The backup code to verify
   * @returns true if the code is valid and was consumed, false otherwise
   */
  async useBackupCode(userId: string, code: string): Promise<boolean> {
    const record = await db.prepare(
      'SELECT id, backup_codes_hash FROM user_totp WHERE user_id = ?'
    ).get(userId) as any;

    if (!record) {
      return false;
    }

    let hashedCodes: string[];
    try {
      hashedCodes = JSON.parse(record.backup_codes_hash);
    } catch {
      logger.error(`[TOTPService] Failed to parse backup codes for user ${userId}`);
      return false;
    }

    // Find and verify the matching backup code
    let matchIndex = -1;
    for (let i = 0; i < hashedCodes.length; i++) {
      if (bcrypt.compareSync(code, hashedCodes[i])) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      logger.warn(`[TOTPService] Invalid backup code attempt for user ${userId}`);
      return false;
    }

    // Remove the used code (single-use)
    hashedCodes.splice(matchIndex, 1);
    const updatedCodesJson = JSON.stringify(hashedCodes);

    // Update the database
    await db.prepare(
      'UPDATE user_totp SET backup_codes_hash = ?::text, last_used_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(updatedCodesJson, userId);

    logger.info(`[TOTPService] Backup code used for user ${userId}. Remaining: ${hashedCodes.length}`);
    return true;
  }

  /**
   * Checks if 2FA is enabled for the user.
   *
   * @param userId - The user ID to check
   * @returns true if 2FA is enabled, false otherwise
   */
  async isEnabled(userId: string): Promise<boolean> {
    const record = await db.prepare(
      'SELECT is_enabled FROM user_totp WHERE user_id = ?'
    ).get(userId) as any;

    if (!record) {
      return false;
    }

    return record.is_enabled === true || record.is_enabled === 1;
  }

  /**
   * Records a failed 2FA attempt and locks the user's 2FA if the threshold is reached.
   */
  private async recordFailed2FAAttempt(userId: string, maxAttempts: number, windowMinutes: number): Promise<void> {
    try {
      await db.prepare(
        'UPDATE users SET totp_failed_attempts = COALESCE(totp_failed_attempts, 0) + 1 WHERE id = ?'
      ).run(userId);

      const updated = await db.prepare(
        'SELECT totp_failed_attempts FROM users WHERE id = ?'
      ).get(userId) as any;

      if (updated && updated.totp_failed_attempts >= maxAttempts) {
        const lockUntil = new Date(Date.now() + windowMinutes * 60 * 1000).toISOString();
        await db.prepare(
          'UPDATE users SET totp_locked_until = ?::timestamp WHERE id = ?'
        ).run(lockUntil, userId);
        logger.warn(`[TOTPService] 2FA locked for user ${userId} after ${maxAttempts} failed attempts`);
      }
    } catch (e) {
      logger.error(`[TOTPService] Failed to record 2FA attempt for user ${userId}:`, e);
    }
  }
}

// Export singleton instance
export const totpService = new TOTPServiceImpl();

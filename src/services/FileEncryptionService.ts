import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import logger from '../utils/logger';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface EncryptionMetadata {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  iv: string;        // base64
  authTag: string;   // base64
  encryptedAt: string;
  checksum: string;  // SHA-256 of original
  keyVersion: number;
}

export interface EncryptFileInput {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  keyVersion: number;
}

export interface EncryptFileResult {
  path: string;
  metadata: EncryptionMetadata;
}

export interface DecryptFileResult {
  buffer: Buffer;
  metadata: EncryptionMetadata;
}

export interface DecryptStreamResult {
  /**
   * A readable stream emitting the decrypted plaintext in bounded chunks
   * (≤ STREAM_CHUNK_SIZE bytes). For GCM-encrypted files this is the decipher
   * transform; integrity is verified on stream end (`final()`), surfacing any
   * auth-tag/tamper failure as an `error` event.
   */
  stream: Readable;
  metadata: EncryptionMetadata;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = 'alsaqi-file-encryption';
const HKDF_SALT = 'alsaqi-file-enc-salt';

/** Header prefix length: [IV (12 bytes)][AuthTag (16 bytes)] precedes the ciphertext. */
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Maximum size of each decrypted chunk produced while streaming (64 KB). This bounds
 * the read-stream `highWaterMark` so the decipher never processes more than 64 KB at a
 * time, keeping resident memory bounded independent of total file size (Req 12.1, 12.3).
 */
const STREAM_CHUNK_SIZE = 64 * 1024;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * FileEncryptionService provides AES-256-GCM encryption for uploaded files.
 *
 * Features:
 * - HKDF-SHA256 key derivation from FILE_ENCRYPTION_KEY environment variable
 * - Unique 12-byte IV per file
 * - SHA-256 checksum of original file for integrity verification
 * - Encrypted file format: [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
 * - File permissions set to 0o600 (owner read/write only)
 * - Key rotation support
 * - Graceful degradation: stores files unencrypted if FILE_ENCRYPTION_KEY is not set
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */
export class FileEncryptionService {
  private encryptionKey: Buffer | null = null;
  /**
   * المفتاح السابق المُستخدَم لفكّ التشفير فقط أثناء التدوير (rotation fallback).
   *
   * أثناء إعادة التشفير المتدرّجة، تبقى بعض العناصر مشفّرةً بالسرّ السابق حتى
   * يُعاد تشفيرها. يُبقي هذا الحقل السرّ السابق صالحاً **لفكّ التشفير فقط** حتى
   * يُتحقَّق من اكتمال إعادة التشفير، فلا تُفقَد قراءة أي عنصر (AC 19.3, 19.4).
   * يُشتق من `FILE_ENCRYPTION_KEY_PREVIOUS` عند الإقلاع إن وُجد، أو يُضبط برمجياً
   * عبر {@link setPreviousEncryptionKey}، ويُزال عبر {@link clearPreviousEncryptionKey}
   * بعد التحقق من اكتمال الترحيل.
   */
  private previousEncryptionKey: Buffer | null = null;
  private uploadDir: string;
  private metadataStore: Map<string, EncryptionMetadata> = new Map();

  constructor(uploadDir?: string) {
    this.uploadDir = uploadDir || path.join(process.cwd(), 'uploads');
    this.initializeKey();
  }

  /**
   * Initializes the encryption key from FILE_ENCRYPTION_KEY using HKDF-SHA256.
   * If the key is not set, logs a warning and operates in passthrough mode.
   *
   * Also initializes the optional previous-key decryption fallback from
   * FILE_ENCRYPTION_KEY_PREVIOUS, which keeps data readable during a scheduled
   * secret rotation until re-encryption completion is verified (AC 19.3, 19.4).
   */
  private initializeKey(): void {
    const rawKey = process.env.FILE_ENCRYPTION_KEY;

    if (!rawKey) {
      logger.warn(
        '[FileEncryption] FILE_ENCRYPTION_KEY is not set. Files will be stored unencrypted (backward compatibility mode).'
      );
      this.encryptionKey = null;
      return;
    }

    this.encryptionKey = this.deriveKey(rawKey);

    // Optional previous-key fallback for in-progress secret rotation. The previous
    // secret stays valid for DECRYPTION ONLY (never used to encrypt new data) until
    // re-encryption is verified complete (AC 19.3).
    const rawPreviousKey = process.env.FILE_ENCRYPTION_KEY_PREVIOUS;
    if (rawPreviousKey) {
      this.previousEncryptionKey = this.deriveKey(rawPreviousKey);
      logger.info(
        '[FileEncryption] FILE_ENCRYPTION_KEY_PREVIOUS is set: previous key enabled for decryption fallback during rotation.'
      );
    }
  }

  /**
   * Sets (or clears) the previous encryption key used as a decryption-only
   * fallback during a key rotation. Pass the raw key material; pass `null` to
   * clear. The previous key is NEVER used to encrypt new data — only to decrypt
   * items not yet re-encrypted with the current key (AC 19.3, 19.4).
   */
  setPreviousEncryptionKey(rawKey: string | null): void {
    this.previousEncryptionKey = rawKey ? this.deriveKey(rawKey) : null;
  }

  /**
   * Clears the previous encryption key. Call this ONLY after
   * {@link isReEncryptionComplete} confirms every encrypted item has been
   * migrated to the current key, so no readable data is lost (AC 19.3).
   */
  clearPreviousEncryptionKey(): void {
    this.previousEncryptionKey = null;
  }

  /**
   * Returns whether a previous-key decryption fallback is currently active.
   */
  hasPreviousEncryptionKey(): boolean {
    return this.previousEncryptionKey !== null;
  }

  /**
   * Derives a 256-bit encryption key from the raw key material using HKDF-SHA256.
   */
  private deriveKey(rawKey: string): Buffer {
    const derived = crypto.hkdfSync(
      'sha256',
      Buffer.from(rawKey, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      KEY_LENGTH
    );
    return Buffer.from(derived);
  }

  /**
   * Returns whether encryption is enabled (FILE_ENCRYPTION_KEY is set).
   */
  isEncryptionEnabled(): boolean {
    return this.encryptionKey !== null;
  }

  /**
   * Encrypts a file buffer using AES-256-GCM.
   *
   * If encryption is disabled (no FILE_ENCRYPTION_KEY), saves the file unencrypted
   * but still computes the checksum and returns metadata.
   *
   * @param buffer - The file content to encrypt
   * @param input - File metadata (fileId, originalName, mimeType, size, keyVersion)
   * @returns The encrypted file path and full metadata
   */
  async encryptFile(
    buffer: Buffer,
    input: EncryptFileInput
  ): Promise<EncryptFileResult> {
    const { fileId, originalName, mimeType, size, keyVersion } = input;

    // Compute SHA-256 checksum of original file
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    // If encryption is disabled, save file as-is
    if (!this.encryptionKey) {
      const filePath = path.join(this.uploadDir, `${fileId}`);
      await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });

      const metadata: EncryptionMetadata = {
        fileId,
        originalName,
        mimeType,
        size,
        iv: '',
        authTag: '',
        encryptedAt: new Date().toISOString(),
        checksum,
        keyVersion: 0,
      };

      this.metadataStore.set(fileId, metadata);
      return { path: filePath, metadata };
    }

    // Generate unique 12-byte IV
    const iv = crypto.randomBytes(IV_LENGTH);

    // Encrypt with AES-256-GCM
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Write encrypted file: [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
    const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);
    const output = Buffer.concat([iv, authTag, encrypted]);
    await fs.promises.writeFile(encryptedPath, output, { mode: 0o600 });

    const metadata: EncryptionMetadata = {
      fileId,
      originalName,
      mimeType,
      size,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      encryptedAt: new Date().toISOString(),
      checksum,
      keyVersion,
    };

    this.metadataStore.set(fileId, metadata);
    return { path: encryptedPath, metadata };
  }

  /**
   * Decrypts an encrypted file and returns the original buffer.
   *
   * Reads the encrypted file, extracts IV (first 12 bytes), AuthTag (next 16 bytes),
   * and ciphertext, then decrypts using AES-256-GCM.
   *
   * @param fileId - The unique file identifier
   * @returns The decrypted buffer and associated metadata
   * @throws Error if file not found, encryption key missing, or decryption fails
   */
  async decryptFile(fileId: string): Promise<DecryptFileResult> {
    const metadata = this.metadataStore.get(fileId);
    if (!metadata) {
      throw new Error(`File metadata not found for fileId: ${fileId}`);
    }

    // If file was stored unencrypted (keyVersion === 0 or no iv)
    if (!metadata.iv || metadata.keyVersion === 0) {
      const filePath = path.join(this.uploadDir, `${fileId}`);
      const buffer = await fs.promises.readFile(filePath);
      return { buffer, metadata };
    }

    if (!this.encryptionKey) {
      throw new Error(
        'Cannot decrypt file: FILE_ENCRYPTION_KEY is not set but file was encrypted.'
      );
    }

    const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);
    const fileData = await fs.promises.readFile(encryptedPath);

    // Extract IV (first 12 bytes), AuthTag (next 16 bytes), and ciphertext
    const iv = fileData.subarray(0, IV_LENGTH);
    const authTag = fileData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = fileData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    // Decrypt using AES-256-GCM. Try the CURRENT key first; if it fails and a
    // previous-key fallback is active (mid-rotation), retry with the previous
    // key so items not yet re-encrypted remain readable (AC 19.3, 19.4).
    const decrypted = this.decryptWithFallback(iv, authTag, ciphertext, fileId);

    // Verify integrity via checksum comparison
    const computedChecksum = crypto.createHash('sha256').update(decrypted).digest('hex');
    if (computedChecksum !== metadata.checksum) {
      throw new Error(
        `Integrity check failed for fileId: ${fileId}. Checksum mismatch.`
      );
    }

    return { buffer: decrypted, metadata };
  }

  /**
   * Decrypts a GCM ciphertext trying the current key first, then the previous
   * key (decryption-only fallback) if one is configured. This is the core
   * decrypt-with-fallback mechanism that keeps the previous secret valid for
   * decryption during a rotation until re-encryption is verified complete
   * (AC 19.3, 19.4).
   *
   * @throws Error if neither the current nor the previous key can decrypt/verify.
   */
  private decryptWithFallback(
    iv: Buffer,
    authTag: Buffer,
    ciphertext: Buffer,
    fileId: string,
  ): Buffer {
    const tryKey = (key: Buffer): Buffer => {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    };

    try {
      return tryKey(this.encryptionKey as Buffer);
    } catch (currentErr) {
      // Fall back to the previous key ONLY for decryption during rotation.
      if (this.previousEncryptionKey) {
        try {
          const result = tryKey(this.previousEncryptionKey);
          logger.debug(
            `[FileEncryption] Decrypted ${fileId} with previous key (pending re-encryption).`
          );
          return result;
        } catch {
          // Both keys failed — surface the original (current-key) error below.
        }
      }
      throw currentErr instanceof Error
        ? currentErr
        : new Error(`Decryption failed for fileId: ${fileId}`);
    }
  }

  /**
   * Creates a streaming decryptor for an encrypted file.
   *
   * Instead of buffering the entire file in memory (as `decryptFile` does), this reads
   * the fixed-size header ([IV (12 bytes)][AuthTag (16 bytes)]) up front, configures an
   * AES-256-GCM decipher with the IV and auth tag, then pipes the ciphertext through the
   * decipher in chunks of at most {@link STREAM_CHUNK_SIZE} (64 KB). The returned stream
   * emits decrypted plaintext incrementally, so callers can write each chunk to a response
   * before the next is decrypted — keeping resident memory bounded regardless of file size
   * (Req 12.1, 12.2, 12.3).
   *
   * GCM integrity is enforced by the decipher's `final()` step: if any chunk was tampered
   * with or the auth tag does not verify, the stream emits an `error` event rather than
   * completing, allowing the caller to terminate delivery (Req 12.4).
   *
   * The returned stream owns the underlying file handle; destroying the stream (e.g. on
   * client disconnect) releases the read stream and its file descriptor (Req 12.5).
   *
   * @param fileId - The unique file identifier
   * @returns A readable plaintext stream and the associated metadata
   * @throws Error if file metadata not found or the encryption key is missing
   */
  async createDecryptStream(fileId: string): Promise<DecryptStreamResult> {
    const metadata = this.metadataStore.get(fileId);
    if (!metadata) {
      throw new Error(`File metadata not found for fileId: ${fileId}`);
    }

    // If file was stored unencrypted (keyVersion === 0 or no iv), stream it as-is.
    if (!metadata.iv || metadata.keyVersion === 0) {
      const filePath = path.join(this.uploadDir, `${fileId}`);
      const stream = fs.createReadStream(filePath, { highWaterMark: STREAM_CHUNK_SIZE });
      return { stream, metadata };
    }

    if (!this.encryptionKey) {
      throw new Error(
        'Cannot decrypt file: FILE_ENCRYPTION_KEY is not set but file was encrypted.'
      );
    }

    const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);

    // Read the fixed-size header ([IV][AuthTag]) up front. GCM requires the auth tag to be
    // set on the decipher before the final block is processed; here the tag is stored as a
    // prefix (not a trailer), so we read it eagerly and release this handle immediately.
    const header = Buffer.alloc(HEADER_LENGTH);
    const fh = await fs.promises.open(encryptedPath, 'r');
    try {
      const { bytesRead } = await fh.read(header, 0, HEADER_LENGTH, 0);
      if (bytesRead < HEADER_LENGTH) {
        throw new Error(
          `Encrypted file is truncated for fileId: ${fileId} (header incomplete).`
        );
      }
    } finally {
      await fh.close();
    }

    const iv = header.subarray(0, IV_LENGTH);
    const authTag = header.subarray(IV_LENGTH, HEADER_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    // Stream the ciphertext (everything after the header) through the decipher in ≤ 64 KB
    // chunks. The read stream owns the file descriptor.
    const ciphertextStream = fs.createReadStream(encryptedPath, {
      start: HEADER_LENGTH,
      highWaterMark: STREAM_CHUNK_SIZE,
    });

    // Wire failures and lifecycle so the file handle is always released:
    // - a read error aborts the decipher
    // - destroying the decipher (e.g. on client disconnect) destroys the read stream,
    //   closing its file descriptor (Req 12.5)
    ciphertextStream.on('error', (err) => {
      decipher.destroy(err);
    });
    decipher.on('close', () => {
      if (!ciphertextStream.destroyed) {
        ciphertextStream.destroy();
      }
    });

    ciphertextStream.pipe(decipher);

    return { stream: decipher, metadata };
  }

  /**
   * Rotates the encryption key for a specific file.
   *
   * Decrypts the file with the old key, then re-encrypts with the new key
   * and updates the key version in metadata.
   *
   * @param fileId - The file to re-encrypt
   * @param oldKey - The previous encryption key (raw string)
   * @param newKey - The new encryption key (raw string)
   * @param newKeyVersion - The new key version number
   */
  async rotateKey(
    fileId: string,
    oldKey: string,
    newKey: string,
    newKeyVersion: number
  ): Promise<EncryptionMetadata> {
    const metadata = this.metadataStore.get(fileId);
    if (!metadata) {
      throw new Error(`File metadata not found for fileId: ${fileId}`);
    }

    // Derive old key
    const derivedOldKey = this.deriveKey(oldKey);

    // Read encrypted file
    const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);
    const fileData = await fs.promises.readFile(encryptedPath);

    // Extract components
    const iv = fileData.subarray(0, IV_LENGTH);
    const authTag = fileData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = fileData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    // Decrypt with old key
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedOldKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Derive new key
    const derivedNewKey = this.deriveKey(newKey);

    // Re-encrypt with new key
    const newIv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, derivedNewKey, newIv);
    const encrypted = Buffer.concat([cipher.update(decrypted), cipher.final()]);
    const newAuthTag = cipher.getAuthTag();

    // Write re-encrypted file
    const output = Buffer.concat([newIv, newAuthTag, encrypted]);
    await fs.promises.writeFile(encryptedPath, output, { mode: 0o600 });

    // Update metadata
    const updatedMetadata: EncryptionMetadata = {
      ...metadata,
      iv: newIv.toString('base64'),
      authTag: newAuthTag.toString('base64'),
      encryptedAt: new Date().toISOString(),
      keyVersion: newKeyVersion,
    };

    this.metadataStore.set(fileId, updatedMetadata);

    // Update the service's encryption key to the new one
    this.encryptionKey = derivedNewKey;

    return updatedMetadata;
  }

  /**
   * Verifies the integrity of an encrypted file by decrypting it
   * and comparing the SHA-256 checksum with the stored value.
   *
   * @param fileId - The file to verify
   * @returns true if the checksum matches, false otherwise
   */
  async verifyIntegrity(fileId: string): Promise<boolean> {
    try {
      const { buffer, metadata } = await this.decryptFile(fileId);
      const computedChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
      return computedChecksum === metadata.checksum;
    } catch {
      return false;
    }
  }

  /**
   * Gets the stored metadata for a file.
   */
  getMetadata(fileId: string): EncryptionMetadata | undefined {
    return this.metadataStore.get(fileId);
  }

  /**
   * Sets metadata for a file (used when loading from database).
   */
  setMetadata(fileId: string, metadata: EncryptionMetadata): void {
    this.metadataStore.set(fileId, metadata);
  }

  /**
   * Performs key rotation for all files using rotateEncryptionKey interface.
   * Re-encrypts files from oldKey to newKey.
   *
   * @param oldKey - The previous raw encryption key as Buffer
   * @param newKey - The new raw encryption key as Buffer
   */
  async rotateEncryptionKey(oldKey: Buffer, newKey: Buffer): Promise<void> {
    const oldKeyStr = oldKey.toString('utf8');
    const newKeyStr = newKey.toString('utf8');
    const derivedOldKey = this.deriveKey(oldKeyStr);
    const derivedNewKey = this.deriveKey(newKeyStr);

    for (const [fileId, metadata] of this.metadataStore.entries()) {
      // Skip unencrypted files
      if (!metadata.iv || metadata.keyVersion === 0) {
        continue;
      }

      const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);

      // Check if file exists
      try {
        await fs.promises.access(encryptedPath, fs.constants.R_OK);
      } catch {
        logger.warn(`[FileEncryption] Skipping key rotation for missing file: ${fileId}`);
        continue;
      }

      // Read encrypted file
      const fileData = await fs.promises.readFile(encryptedPath);

      // Extract components
      const iv = fileData.subarray(0, IV_LENGTH);
      const authTag = fileData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = fileData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

      // Decrypt with old key
      const decipher = crypto.createDecipheriv(ALGORITHM, derivedOldKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      // Re-encrypt with new key
      const newIv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, derivedNewKey, newIv);
      const encrypted = Buffer.concat([cipher.update(decrypted), cipher.final()]);
      const newAuthTag = cipher.getAuthTag();

      // Write re-encrypted file
      const output = Buffer.concat([newIv, newAuthTag, encrypted]);
      await fs.promises.writeFile(encryptedPath, output, { mode: 0o600 });

      // Update metadata
      metadata.iv = newIv.toString('base64');
      metadata.authTag = newAuthTag.toString('base64');
      metadata.encryptedAt = new Date().toISOString();
      metadata.keyVersion = metadata.keyVersion + 1;
      this.metadataStore.set(fileId, metadata);
    }

    // Update the service's encryption key
    this.encryptionKey = derivedNewKey;
  }

  /**
   * Re-encrypts the entire store from the previous key to the current key while
   * keeping the previous key valid for decryption, then reports whether the
   * migration is complete. This is the rotation-support entry point referenced
   * by docs/key-rotation-procedure.md §2.أ (scheduled secret rotation):
   *
   *   1. caller sets the previous key via {@link setPreviousEncryptionKey} (or
   *      FILE_ENCRYPTION_KEY_PREVIOUS) and the new current key via the
   *      FILE_ENCRYPTION_KEY env / constructor;
   *   2. caller invokes this method to advance every item's keyVersion;
   *   3. only once {@link isReEncryptionComplete} returns true does the caller
   *      call {@link clearPreviousEncryptionKey} and drop the old secret (AC 19.3).
   *
   * Items that fail to re-encrypt are left untouched and remain readable via the
   * previous-key decryption fallback, so a partial failure never loses data
   * (AC 19.4). The previous secret is never removed here.
   *
   * @param newKeyVersion The keyVersion to assign to successfully migrated items.
   * @returns A summary of migrated / failed file ids.
   */
  async reEncryptStoreToCurrentKey(
    newKeyVersion: number,
  ): Promise<{ migrated: string[]; failed: string[] }> {
    const migrated: string[] = [];
    const failed: string[] = [];

    if (!this.encryptionKey) {
      throw new Error('Cannot re-encrypt: current FILE_ENCRYPTION_KEY is not set.');
    }
    if (!this.previousEncryptionKey) {
      throw new Error(
        'Cannot re-encrypt: previous key is not configured. Set FILE_ENCRYPTION_KEY_PREVIOUS or call setPreviousEncryptionKey().'
      );
    }

    for (const [fileId, metadata] of this.metadataStore.entries()) {
      // Skip unencrypted files and items already on the new key version.
      if (!metadata.iv || metadata.keyVersion === 0 || metadata.keyVersion >= newKeyVersion) {
        continue;
      }

      const encryptedPath = path.join(this.uploadDir, `${fileId}.enc`);
      try {
        const fileData = await fs.promises.readFile(encryptedPath);
        const iv = fileData.subarray(0, IV_LENGTH);
        const authTag = fileData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = fileData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

        // Decrypt with whichever key works (current or previous fallback).
        const decrypted = this.decryptWithFallback(iv, authTag, ciphertext, fileId);

        // Re-encrypt with the current key.
        const newIv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, newIv);
        const encrypted = Buffer.concat([cipher.update(decrypted), cipher.final()]);
        const newAuthTag = cipher.getAuthTag();
        const output = Buffer.concat([newIv, newAuthTag, encrypted]);
        await fs.promises.writeFile(encryptedPath, output, { mode: 0o600 });

        metadata.iv = newIv.toString('base64');
        metadata.authTag = newAuthTag.toString('base64');
        metadata.encryptedAt = new Date().toISOString();
        metadata.keyVersion = newKeyVersion;
        this.metadataStore.set(fileId, metadata);
        migrated.push(fileId);
      } catch (err) {
        // Leave the item untouched; it stays readable via the previous-key
        // fallback. Record the failure so the caller does NOT drop the old
        // secret yet (AC 19.4).
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[FileEncryption] Re-encryption failed for ${fileId}; item left readable with previous key: ${message}`
        );
        failed.push(fileId);
      }
    }

    return { migrated, failed };
  }

  /**
   * Returns true if every encrypted item in the store has reached at least the
   * given key version, meaning re-encryption to the current key is complete and
   * the previous secret can be safely dropped (AC 19.3). Unencrypted items
   * (keyVersion === 0) are excluded from the check.
   *
   * Validates: Requirements 19.3
   */
  isReEncryptionComplete(targetKeyVersion: number): boolean {
    for (const metadata of this.metadataStore.values()) {
      if (!metadata.iv || metadata.keyVersion === 0) {
        continue; // unencrypted/passthrough items are not part of the migration
      }
      if (metadata.keyVersion < targetKeyVersion) {
        return false;
      }
    }
    return true;
  }
}

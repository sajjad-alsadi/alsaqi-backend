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
  private uploadDir: string;
  private metadataStore: Map<string, EncryptionMetadata> = new Map();

  constructor(uploadDir?: string) {
    this.uploadDir = uploadDir || path.join(process.cwd(), 'uploads');
    this.initializeKey();
  }

  /**
   * Initializes the encryption key from FILE_ENCRYPTION_KEY using HKDF-SHA256.
   * If the key is not set, logs a warning and operates in passthrough mode.
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

    // Decrypt using AES-256-GCM
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

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
}

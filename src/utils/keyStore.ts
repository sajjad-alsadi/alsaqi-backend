import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from './logger';

export interface KeyPair {
  privateKey: string; // PEM format
  publicKey: string;  // PEM format
}

export interface KeyStoreOptions {
  dataDir: string;          // From DATA_DIR env or './data'
  encryptionSecret: string; // JWT_SECRET
}

/**
 * Encrypted storage format written to disk.
 * All fields are base64-encoded.
 */
interface EncryptedPayload {
  iv: string;   // 12-byte IV (base64)
  tag: string;  // 16-byte auth tag (base64)
  data: string; // AES-256-GCM ciphertext (base64)
}

// HKDF parameters for deriving the AES-256-GCM key from the encryption secret.
// Mirrors the HKDF approach used by TOTPService; domain-separated via salt + info.
const KEY_LENGTH = 32; // 256-bit AES key
const HKDF_SALT = 'alsaqi-rsa-keystore-salt';
const HKDF_INFO = 'alsaqi-rsa-keystore-encryption';

/**
 * KeyStore provides encrypted persistence for RSA key pairs.
 *
 * Storage path: `${dataDir}/keys/.rsa_keys.enc`
 * Encryption: AES-256-GCM with a key derived from JWT_SECRET via HKDF-SHA256.
 * Fallback: If the configured dataDir is not writable, attempts './data' relative to app root.
 *
 * MIGRATION NOTE: the derivation was changed from `SHA-256(JWT_SECRET + '_rsa_enc')`
 * to HKDF-SHA256 (finding 1.39). A `.rsa_keys.enc` written by the old derivation can no
 * longer be decrypted; `load()` already treats a failed decryption as a corrupted file
 * (it backs the file up and returns null), so `getOrCreate()` transparently regenerates a
 * fresh RSA key pair on first boot after the upgrade. Regeneration rotates the signing
 * keys, which invalidates outstanding JWT access/refresh tokens — existing sessions reset
 * once after deployment. This is the same behavior as a JWT_SECRET change today.
 */
export class KeyStore {
  private readonly dataDir: string;
  private readonly encryptionSecret: string;
  private resolvedKeysDir: string | null = null;

  constructor(options: KeyStoreOptions) {
    this.dataDir = options.dataDir;
    this.encryptionSecret = options.encryptionSecret;
  }

  /**
   * Derives a 256-bit encryption key from the JWT_SECRET using HKDF-SHA256.
   *
   * HKDF (RFC 5869) is a proper key-derivation function with domain separation via the
   * salt/info parameters, replacing the previous plain `SHA-256(secret + '_rsa_enc')`
   * concatenation (finding 1.39).
   */
  private deriveEncryptionKey(): Buffer {
    const derived = crypto.hkdfSync(
      'sha256',
      Buffer.from(this.encryptionSecret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      KEY_LENGTH
    );
    return Buffer.from(derived);
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   */
  private encrypt(plaintext: string): string {
    const key = this.deriveEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted,
    };
    return JSON.stringify(payload);
  }

  /**
   * Decrypts an AES-256-GCM encrypted payload.
   */
  private decrypt(encryptedStr: string): string {
    const key = this.deriveEncryptionKey();
    const payload: EncryptedPayload = JSON.parse(encryptedStr);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    let decrypted = decipher.update(payload.data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Ensures a directory exists and is writable.
   * Returns true if the directory is usable.
   */
  private ensureDir(dir: string): boolean {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Test writability
      const testFile = path.join(dir, '.write-test-' + Date.now());
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the keys directory path.
   * Tries DATA_DIR/keys first, falls back to ./data/keys.
   * Never uses /tmp.
   */
  private getKeysDir(): string {
    if (this.resolvedKeysDir) {
      return this.resolvedKeysDir;
    }

    const primaryDir = path.join(this.dataDir, 'keys');
    if (this.ensureDir(primaryDir)) {
      this.resolvedKeysDir = primaryDir;
      return primaryDir;
    }

    logger.warn(`[KeyStore] Primary data directory ${primaryDir} is not writable. Falling back to ./data/keys`);

    const fallbackDir = path.join(process.cwd(), 'data', 'keys');
    if (this.ensureDir(fallbackDir)) {
      this.resolvedKeysDir = fallbackDir;
      return fallbackDir;
    }

    // Last resort: use the primary dir path anyway (will fail on write)
    logger.error(`[KeyStore] Fallback directory ${fallbackDir} is also not writable.`);
    this.resolvedKeysDir = primaryDir;
    return primaryDir;
  }

  /**
   * Returns the full path to the encrypted key file.
   */
  private getKeyFilePath(): string {
    return path.join(this.getKeysDir(), '.rsa_keys.enc');
  }

  /**
   * Loads an existing RSA key pair from encrypted storage.
   * Returns null if no key file exists or decryption fails.
   */
  async load(): Promise<KeyPair | null> {
    const keyFilePath = this.getKeyFilePath();

    if (!fs.existsSync(keyFilePath)) {
      return null;
    }

    try {
      const encContent = fs.readFileSync(keyFilePath, 'utf8');
      const decrypted = this.decrypt(encContent);
      const keys: KeyPair = JSON.parse(decrypted);

      // Validate that the loaded keys look like PEM
      if (!keys.privateKey?.includes('-----BEGIN') || !keys.publicKey?.includes('-----BEGIN')) {
        logger.error('[KeyStore] Loaded keys are not valid PEM format. Treating as corrupted.');
        return null;
      }

      logger.info('[KeyStore] Loaded persisted RSA keys from encrypted storage.');
      return keys;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unsupported state')) {
        logger.warn('[KeyStore] Decryption failed (JWT_SECRET may have changed). Keys will be regenerated.');
      } else {
        logger.error('[KeyStore] Failed to load key file (corrupted or invalid).', { error: String(error) });
      }
      // Backup corrupted file
      try {
        const backupPath = keyFilePath + '.bak.' + Date.now();
        fs.copyFileSync(keyFilePath, backupPath);
        logger.info(`[KeyStore] Backed up corrupted key file to ${backupPath}`);
      } catch {
        // Ignore backup failure
      }
      return null;
    }
  }

  /**
   * Saves an RSA key pair to encrypted storage.
   */
  async save(keys: KeyPair): Promise<void> {
    const keyFilePath = this.getKeyFilePath();
    const encrypted = this.encrypt(JSON.stringify(keys));
    fs.writeFileSync(keyFilePath, encrypted, { mode: 0o600 });
    logger.info('[KeyStore] Persisted RSA keys to encrypted storage.');
  }

  /**
   * Loads existing keys or generates and persists a new RSA key pair.
   */
  async getOrCreate(): Promise<KeyPair> {
    // Try loading existing keys
    const existing = await this.load();
    if (existing) {
      return existing;
    }

    // Generate new RSA key pair
    logger.info('[KeyStore] Generating new RSA key pair...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    const keys: KeyPair = { privateKey, publicKey };

    // Persist the new keys
    try {
      await this.save(keys);
    } catch (error) {
      logger.error('[KeyStore] Failed to persist RSA keys to disk. Sessions will reset on reboot.', {
        error: String(error),
      });
    }

    return keys;
  }
}

/**
 * Resolves the data directory from environment or defaults.
 * Priority: DATA_DIR env → ./data (relative to app root)
 * Never returns /tmp.
 */
export function resolveDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }
  return path.resolve(process.cwd(), 'data');
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileEncryptionService } from '../FileEncryptionService';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Unit tests for encryption-secret rotation support (task 24.2):
 *
 * - the previous secret stays valid for DECRYPTION until re-encryption is
 *   verified complete (AC 19.3);
 * - a failed re-encryption leaves the item readable with the previous secret,
 *   no data loss (AC 19.4);
 * - the previous key is never required to encrypt new data.
 */

const OLD_KEY = 'old-file-encryption-key-minimum-32-characters-long!!';
const NEW_KEY = 'new-file-encryption-key-minimum-32-characters-long!!';

describe('FileEncryptionService — secret rotation support', () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enc-rotate-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /** Encrypts a file with the OLD key and returns its metadata. */
  async function encryptWithOldKey(fileId: string, content: string) {
    process.env = { ...originalEnv, FILE_ENCRYPTION_KEY: OLD_KEY };
    const svc = new FileEncryptionService(tmpDir);
    const { metadata } = await svc.encryptFile(Buffer.from(content), {
      fileId,
      originalName: `${fileId}.txt`,
      mimeType: 'text/plain',
      size: content.length,
      keyVersion: 1,
    });
    return metadata;
  }

  it('decrypts an old-key file using the previous-key fallback when current key is new', async () => {
    const meta = await encryptWithOldKey('f1', 'secret payload');

    // New service running with the NEW key as current + OLD key as previous fallback.
    process.env = {
      ...originalEnv,
      FILE_ENCRYPTION_KEY: NEW_KEY,
      FILE_ENCRYPTION_KEY_PREVIOUS: OLD_KEY,
    };
    const svc = new FileEncryptionService(tmpDir);
    svc.setMetadata('f1', meta);

    expect(svc.hasPreviousEncryptionKey()).toBe(true);
    const { buffer } = await svc.decryptFile('f1');
    expect(buffer.toString()).toBe('secret payload');
  });

  it('fails to decrypt an old-key file when no previous-key fallback is set', async () => {
    const meta = await encryptWithOldKey('f2', 'data');

    process.env = { ...originalEnv, FILE_ENCRYPTION_KEY: NEW_KEY };
    const svc = new FileEncryptionService(tmpDir);
    svc.setMetadata('f2', meta);

    expect(svc.hasPreviousEncryptionKey()).toBe(false);
    await expect(svc.decryptFile('f2')).rejects.toThrow();
  });

  it('re-encrypts the store to the current key and reports completion', async () => {
    const m1 = await encryptWithOldKey('a', 'alpha');
    const m2 = await encryptWithOldKey('b', 'beta');

    process.env = {
      ...originalEnv,
      FILE_ENCRYPTION_KEY: NEW_KEY,
      FILE_ENCRYPTION_KEY_PREVIOUS: OLD_KEY,
    };
    const svc = new FileEncryptionService(tmpDir);
    svc.setMetadata('a', m1);
    svc.setMetadata('b', m2);

    // Before migration, items are at keyVersion 1 — not complete for target v2.
    expect(svc.isReEncryptionComplete(2)).toBe(false);

    const result = await svc.reEncryptStoreToCurrentKey(2);
    expect(result.migrated.sort()).toEqual(['a', 'b']);
    expect(result.failed).toEqual([]);

    // After migration every item is at the target version.
    expect(svc.isReEncryptionComplete(2)).toBe(true);

    // Dropping the previous key is now safe; items still decrypt with current key.
    svc.clearPreviousEncryptionKey();
    expect(svc.hasPreviousEncryptionKey()).toBe(false);
    const { buffer } = await svc.decryptFile('a');
    expect(buffer.toString()).toBe('alpha');
  });

  it('leaves an item readable with the previous key when re-encryption fails (no data loss)', async () => {
    const m1 = await encryptWithOldKey('ok', 'good');
    const m2 = await encryptWithOldKey('bad', 'lost?');

    process.env = {
      ...originalEnv,
      FILE_ENCRYPTION_KEY: NEW_KEY,
      FILE_ENCRYPTION_KEY_PREVIOUS: OLD_KEY,
    };
    const svc = new FileEncryptionService(tmpDir);
    svc.setMetadata('ok', m1);
    svc.setMetadata('bad', m2);

    // Simulate a failure for 'bad' by removing its underlying encrypted file.
    await fs.promises.rm(path.join(tmpDir, 'bad.enc'));

    const result = await svc.reEncryptStoreToCurrentKey(2);
    expect(result.migrated).toContain('ok');
    expect(result.failed).toContain('bad');

    // Migration is NOT complete, so the previous secret must be kept.
    expect(svc.isReEncryptionComplete(2)).toBe(false);

    // The successfully migrated item reads back correctly.
    const ok = await svc.decryptFile('ok');
    expect(ok.buffer.toString()).toBe('good');
  });

  it('keeps the failed item readable with the previous secret when re-encryption write fails (no data loss)', async () => {
    const m1 = await encryptWithOldKey('ok', 'good');
    const m2 = await encryptWithOldKey('bad', 'precious payload');

    process.env = {
      ...originalEnv,
      FILE_ENCRYPTION_KEY: NEW_KEY,
      FILE_ENCRYPTION_KEY_PREVIOUS: OLD_KEY,
    };
    const svc = new FileEncryptionService(tmpDir);
    svc.setMetadata('ok', m1);
    svc.setMetadata('bad', m2);

    // Simulate a re-encryption failure for 'bad' WITHOUT destroying its data:
    // the write of the freshly re-encrypted payload fails, but the original
    // old-key ciphertext on disk is left intact.
    const badPath = path.join(tmpDir, 'bad.enc');
    const realWriteFile = fs.promises.writeFile;
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation((file: any, ...args: any[]) => {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(badPath)) {
          return Promise.reject(new Error('simulated disk write failure'));
        }
        return (realWriteFile as any)(file, ...args);
      });

    try {
      const result = await svc.reEncryptStoreToCurrentKey(2);

      // 'ok' migrated; 'bad' failed and was recorded.
      expect(result.migrated).toContain('ok');
      expect(result.failed).toContain('bad');

      // Migration is incomplete, so the previous secret must NOT be dropped.
      expect(svc.isReEncryptionComplete(2)).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }

    // No data loss: the failed item is STILL readable with the previous secret
    // via the decrypt-with-fallback path, returning its original content.
    expect(svc.hasPreviousEncryptionKey()).toBe(true);
    const bad = await svc.decryptFile('bad');
    expect(bad.buffer.toString()).toBe('precious payload');
  });
});

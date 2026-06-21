// @vitest-environment node
//
// Real-fs unit tests for the backup at-rest encryption (AES-256-GCM) and
// UPLOAD_DIR bundling helpers added for task 10.1 (Requirements 3.1, 3.3).
// These exercise the actual crypto and `tar` binary (no mocks) so the
// round-trip and archive contents are verified against real functionality.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { __testing } from '../backup';

const {
  getBackupEncryptionKey,
  encryptFileAtRest,
  createCombinedArchive,
  BACKUP_ENC_IV_LENGTH,
  BACKUP_ENC_AUTH_TAG_LENGTH,
} = __testing;

const ALGORITHM = 'aes-256-gcm';

/** Decrypts a file produced by encryptFileAtRest: [IV][Ciphertext][AuthTag]. */
function decryptAtRest(encPath: string, key: Buffer): Buffer {
  const blob = fs.readFileSync(encPath);
  const iv = blob.subarray(0, BACKUP_ENC_IV_LENGTH);
  const authTag = blob.subarray(blob.length - BACKUP_ENC_AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(BACKUP_ENC_IV_LENGTH, blob.length - BACKUP_ENC_AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: BACKUP_ENC_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function listArchive(archivePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    tar.stdout.on('data', (d) => { out += d.toString(); });
    tar.stderr.on('data', (d) => { err += d.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tar -t exited ${code}: ${err}`));
      resolve(out.split('\n').map((l) => l.trim()).filter(Boolean));
    });
  });
}

describe('backup at-rest encryption (Req 3.1)', () => {
  let tmpDir: string;
  const originalKey = process.env.FILE_ENCRYPTION_KEY;
  const originalAccess = process.env.FILE_ACCESS_SECRET;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-enc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.FILE_ENCRYPTION_KEY;
    else process.env.FILE_ENCRYPTION_KEY = originalKey;
    if (originalAccess === undefined) delete process.env.FILE_ACCESS_SECRET;
    else process.env.FILE_ACCESS_SECRET = originalAccess;
  });

  it('derives a 256-bit key from FILE_ENCRYPTION_KEY', () => {
    process.env.FILE_ENCRYPTION_KEY = 'backup-test-encryption-key-minimum-32-chars!';
    const key = getBackupEncryptionKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('falls back to FILE_ACCESS_SECRET when FILE_ENCRYPTION_KEY is absent', () => {
    delete process.env.FILE_ENCRYPTION_KEY;
    process.env.FILE_ACCESS_SECRET = 'backup-file-access-secret-minimum-32-characters!';
    const key = getBackupEncryptionKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('returns null when no key material is configured', () => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete process.env.FILE_ACCESS_SECRET;
    expect(getBackupEncryptionKey()).toBeNull();
  });

  it('encrypts a file at rest and decrypts back to the original content', async () => {
    const key = crypto.randomBytes(32);
    const plaintext = crypto.randomBytes(50_000); // larger than one chunk
    const src = path.join(tmpDir, 'dump.sql');
    const dest = path.join(tmpDir, 'dump.sql.enc');
    fs.writeFileSync(src, plaintext);

    await encryptFileAtRest(src, dest, key);

    // Encrypted artifact must differ from plaintext and start with the IV header.
    const enc = fs.readFileSync(dest);
    expect(enc.length).toBeGreaterThan(plaintext.length); // IV + tag overhead
    expect(enc.subarray(BACKUP_ENC_IV_LENGTH).equals(plaintext)).toBe(false);

    const recovered = decryptAtRest(dest, key);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('produces an auth tag that detects tampering', async () => {
    const key = crypto.randomBytes(32);
    const src = path.join(tmpDir, 'a.txt');
    const dest = path.join(tmpDir, 'a.txt.enc');
    fs.writeFileSync(src, 'sensitive backup content');
    await encryptFileAtRest(src, dest, key);

    // Flip a byte in the ciphertext region.
    const blob = fs.readFileSync(dest);
    blob[BACKUP_ENC_IV_LENGTH + 1] ^= 0xff;
    fs.writeFileSync(dest, blob);

    expect(() => decryptAtRest(dest, key)).toThrow();
  });
});

describe('backup UPLOAD_DIR bundling (Req 3.3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-arch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes both the dump and the UPLOAD_DIR contents in the archive', async () => {
    const dump = path.join(tmpDir, 'backup_dump.sql');
    fs.writeFileSync(dump, 'SELECT 1;');

    const uploads = path.join(tmpDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'file1.bin'), crypto.randomBytes(64));
    fs.writeFileSync(path.join(uploads, 'file2.bin'), crypto.randomBytes(64));

    const archive = path.join(tmpDir, 'combined.tar.gz');
    await createCombinedArchive(archive, dump, uploads);

    const entries = await listArchive(archive);
    expect(entries.some((e) => e.includes('backup_dump.sql'))).toBe(true);
    expect(entries.some((e) => e.includes('uploads/file1.bin'))).toBe(true);
    expect(entries.some((e) => e.includes('uploads/file2.bin'))).toBe(true);
  });

  it('archives the dump alone when no UPLOAD_DIR is provided', async () => {
    const dump = path.join(tmpDir, 'backup_dump.sql');
    fs.writeFileSync(dump, 'SELECT 1;');

    const archive = path.join(tmpDir, 'dump-only.tar.gz');
    await createCombinedArchive(archive, dump, null);

    const entries = await listArchive(archive);
    expect(entries.some((e) => e.includes('backup_dump.sql'))).toBe(true);
  });
});

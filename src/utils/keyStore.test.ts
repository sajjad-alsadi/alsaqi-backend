import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyStore, resolveDataDir } from './keyStore';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('KeyStore', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'keystore-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should generate and persist keys on first call to getOrCreate', async () => {
    const store = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'test-secret-123',
    });

    const keys = await store.getOrCreate();

    expect(keys.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keys.publicKey).toContain('-----BEGIN PUBLIC KEY-----');

    // Verify file was created
    const keyFile = path.join(testDir, 'keys', '.rsa_keys.enc');
    expect(fs.existsSync(keyFile)).toBe(true);

    // Verify file does NOT contain PEM markers (encrypted at rest)
    const rawContent = fs.readFileSync(keyFile, 'utf8');
    expect(rawContent).not.toContain('-----BEGIN');
  });

  it('should load existing keys on subsequent calls', async () => {
    const store = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'test-secret-123',
    });

    const keys1 = await store.getOrCreate();
    const keys2 = await store.getOrCreate();

    expect(keys1.privateKey).toBe(keys2.privateKey);
    expect(keys1.publicKey).toBe(keys2.publicKey);
  });

  it('should regenerate keys if decryption fails (wrong secret)', async () => {
    const store1 = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'secret-1',
    });
    const keys1 = await store1.getOrCreate();

    // Create a new store with a different secret
    const store2 = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'secret-2',
    });
    const keys2 = await store2.getOrCreate();

    // Keys should be different since decryption failed and new ones were generated
    expect(keys2.privateKey).not.toBe(keys1.privateKey);
  });

  it('should encrypt keys at rest using AES-256-GCM format', async () => {
    const store = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'test-secret',
    });

    await store.getOrCreate();

    const keyFile = path.join(testDir, 'keys', '.rsa_keys.enc');
    const rawContent = fs.readFileSync(keyFile, 'utf8');
    const parsed = JSON.parse(rawContent);

    // Verify the encrypted payload structure
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('tag');
    expect(parsed).toHaveProperty('data');

    // IV should be 12 bytes = 16 base64 chars
    expect(Buffer.from(parsed.iv, 'base64').length).toBe(12);
    // Auth tag should be 16 bytes
    expect(Buffer.from(parsed.tag, 'base64').length).toBe(16);
  });

  it('load() should return null when no key file exists', async () => {
    const store = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'test-secret',
    });

    const result = await store.load();
    expect(result).toBeNull();
  });

  it('save() and load() should round-trip correctly', async () => {
    const store = new KeyStore({
      dataDir: testDir,
      encryptionSecret: 'test-secret',
    });

    const mockKeys = {
      privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----',
      publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...\n-----END PUBLIC KEY-----',
    };

    await store.save(mockKeys);
    const loaded = await store.load();

    expect(loaded).toEqual(mockKeys);
  });
});

describe('resolveDataDir', () => {
  const originalEnv = process.env.DATA_DIR;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATA_DIR = originalEnv;
    } else {
      delete process.env.DATA_DIR;
    }
  });

  it('should use DATA_DIR env variable when set', () => {
    process.env.DATA_DIR = '/custom/data/path';
    const result = resolveDataDir();
    expect(result).toBe(path.resolve('/custom/data/path'));
  });

  it('should fall back to ./data when DATA_DIR is not set', () => {
    delete process.env.DATA_DIR;
    const result = resolveDataDir();
    expect(result).toBe(path.resolve(process.cwd(), 'data'));
  });

  it('should never return a /tmp path', () => {
    delete process.env.DATA_DIR;
    const result = resolveDataDir();
    expect(result).not.toContain('/tmp');
    expect(result).not.toContain('\\tmp');
  });
});

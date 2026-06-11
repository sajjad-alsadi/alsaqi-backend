import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { KeyStore, KeyPair } from '../keyStore';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Property 2: KeyStore Encryption Round-Trip
 *
 * For any valid RSA key pair and any non-empty encryption secret,
 * encrypting the key pair with the KeyStore's AES-256-GCM scheme
 * and then decrypting it SHALL produce an identical key pair
 * (private key and public key match byte-for-byte).
 *
 * **Validates: Requirements 1.3, 2.1, 20.1**
 */
describe('Property 2: KeyStore Encryption Round-Trip', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'keystore-prop-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Arbitrary that generates PEM-formatted key strings.
   * The KeyStore's load() validates that keys contain '-----BEGIN' markers,
   * so we generate realistic PEM-style content with arbitrary base64 bodies.
   */
  const pemKeyArb = (label: string) =>
    fc.base64String({ minLength: 32, maxLength: 512 }).map(
      (body) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
    );

  const keyPairArb: fc.Arbitrary<KeyPair> = fc.record({
    privateKey: pemKeyArb('PRIVATE KEY'),
    publicKey: pemKeyArb('PUBLIC KEY'),
  });

  /**
   * Arbitrary that generates non-empty encryption secrets.
   * Secrets must be non-empty strings (the KeyStore derives an AES key via SHA-256).
   */
  const encryptionSecretArb = fc.string({ minLength: 1, maxLength: 256 });

  it('encrypt→decrypt round-trip preserves key pair bytes for any key pair and secret', async () => {
    await fc.assert(
      fc.asyncProperty(keyPairArb, encryptionSecretArb, async (keyPair, secret) => {
        // Create a fresh subdirectory per iteration to avoid conflicts
        const iterDir = path.join(testDir, Math.random().toString(36).slice(2));
        fs.mkdirSync(iterDir, { recursive: true });

        const store = new KeyStore({
          dataDir: iterDir,
          encryptionSecret: secret,
        });

        // Encrypt (save) then decrypt (load)
        await store.save(keyPair);
        const loaded = await store.load();

        // Round-trip must produce identical bytes
        expect(loaded).not.toBeNull();
        expect(loaded!.privateKey).toBe(keyPair.privateKey);
        expect(loaded!.publicKey).toBe(keyPair.publicKey);
      }),
      { numRuns: 100 }
    );
  });

  it('encrypt→decrypt round-trip is independent of secret content (Unicode, special chars)', async () => {
    const unicodeSecretArb = fc.string({ minLength: 1, maxLength: 128, unit: 'grapheme' });

    await fc.assert(
      fc.asyncProperty(keyPairArb, unicodeSecretArb, async (keyPair, secret) => {
        const iterDir = path.join(testDir, Math.random().toString(36).slice(2));
        fs.mkdirSync(iterDir, { recursive: true });

        const store = new KeyStore({
          dataDir: iterDir,
          encryptionSecret: secret,
        });

        await store.save(keyPair);
        const loaded = await store.load();

        expect(loaded).not.toBeNull();
        expect(loaded!.privateKey).toBe(keyPair.privateKey);
        expect(loaded!.publicKey).toBe(keyPair.publicKey);
      }),
      { numRuns: 100 }
    );
  });

  it('same key pair encrypted with different secrets produces different ciphertext', async () => {
    await fc.assert(
      fc.asyncProperty(
        keyPairArb,
        encryptionSecretArb,
        encryptionSecretArb.filter((s) => s.length > 0),
        async (keyPair, secret1, secret2) => {
          // Only test when secrets are actually different
          fc.pre(secret1 !== secret2);

          const dir1 = path.join(testDir, 'a-' + Math.random().toString(36).slice(2));
          const dir2 = path.join(testDir, 'b-' + Math.random().toString(36).slice(2));
          fs.mkdirSync(dir1, { recursive: true });
          fs.mkdirSync(dir2, { recursive: true });

          const store1 = new KeyStore({ dataDir: dir1, encryptionSecret: secret1 });
          const store2 = new KeyStore({ dataDir: dir2, encryptionSecret: secret2 });

          await store1.save(keyPair);
          await store2.save(keyPair);

          // Read raw encrypted files - they should differ
          const file1 = fs.readFileSync(path.join(dir1, 'keys', '.rsa_keys.enc'), 'utf8');
          const file2 = fs.readFileSync(path.join(dir2, 'keys', '.rsa_keys.enc'), 'utf8');

          // Due to random IV, even with the same secret the ciphertext would differ,
          // but with different secrets the decryption keys are definitely different
          expect(file1).not.toBe(file2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

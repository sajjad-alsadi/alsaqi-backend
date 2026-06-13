// Feature: backend-security-hardening, Task 10.11 — Integration tests for streaming decryption.
//
// These tests exercise FileEncryptionService.createDecryptStream against real files in a
// temporary upload directory (encrypted via FileEncryptionService.encryptFile with a real
// FILE_ENCRYPTION_KEY) and assert the streaming-delivery guarantees of Requirement 12:
//
//   - 12.1 Decryption happens in sequential chunks of at most 64 KB (not one big operation).
//   - 12.2 Each chunk is emitted before the next is produced; the whole plaintext is never
//          buffered at once (bounded in-flight chunk size).
//   - 12.3 Memory stays bounded regardless of total file size (observed via chunk sizing).
//   - 12.4 A tampered chunk / auth-tag failure terminates the stream with an error instead of
//          completing with full valid plaintext.
//   - 12.5 A client disconnect (destroying the consumer/decrypt stream) releases the decrypt
//          stream and the underlying file read stream (file handle).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileEncryptionService } from '../FileEncryptionService';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { once } from 'events';

const FILE_ENCRYPTION_KEY = 'streaming-integration-test-key-minimum-32-characters!';
const CHUNK_SIZE = 64 * 1024; // 64 KB — the streaming chunk bound (Req 12.1).
const HEADER_LENGTH = 28; // [IV(12)][AuthTag(16)] prefix.

/** Drains a readable stream into a single Buffer. */
async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('Streaming decryption (integration) — Requirement 12', () => {
  const originalEnv = process.env;
  let tmpDir: string;
  let service: FileEncryptionService;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-dec-'));
    process.env = { ...originalEnv, FILE_ENCRYPTION_KEY };
    service = new FileEncryptionService(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Encrypts `buffer` under `fileId` in the temp upload dir and returns the on-disk path.
   */
  async function encrypt(fileId: string, buffer: Buffer): Promise<string> {
    const { path: encPath } = await service.encryptFile(buffer, {
      fileId,
      originalName: `${fileId}.bin`,
      mimeType: 'application/octet-stream',
      size: buffer.length,
      keyVersion: 1,
    });
    return encPath;
  }

  describe('1. Chunked decryption (Req 12.1, 12.3)', () => {
    it('round-trips correctly and emits multiple chunks for a file larger than 64 KB', async () => {
      // 256 KB forces at least 4 chunks of <= 64 KB.
      const plaintext = crypto.randomBytes(256 * 1024);
      await encrypt('chunked-256k', plaintext);

      const { stream, metadata } = await service.createDecryptStream('chunked-256k');

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      // Multiple chunks => decryption was performed incrementally, not in one operation.
      expect(chunks.length).toBeGreaterThan(1);
      // Faithful round-trip of the original plaintext.
      expect(Buffer.concat(chunks).equals(plaintext)).toBe(true);
      expect(metadata.fileId).toBe('chunked-256k');
    });
  });

  describe('2. Bounded memory for large files (Req 12.2, 12.3)', () => {
    it('never buffers the whole plaintext: max in-flight chunk size stays <= 64 KB for a multi-MB file', async () => {
      // 5 MB plaintext. If the implementation buffered the whole file, we would observe a
      // single ~5 MB chunk. Bounded streaming caps each emitted chunk at 64 KB.
      const sizeBytes = 5 * 1024 * 1024;
      const plaintext = crypto.randomBytes(sizeBytes);
      await encrypt('bounded-5mb', plaintext);

      const { stream } = await service.createDecryptStream('bounded-5mb');

      let maxChunk = 0;
      let totalBytes = 0;
      let chunkCount = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        maxChunk = Math.max(maxChunk, buf.length);
        totalBytes += buf.length;
        chunkCount += 1;
      }

      // The largest single in-flight chunk never exceeds the 64 KB bound (bounded memory).
      expect(maxChunk).toBeLessThanOrEqual(CHUNK_SIZE);
      // Many chunks for a multi-MB file (≈ size / 64 KB), proving incremental delivery.
      expect(chunkCount).toBeGreaterThanOrEqual(Math.floor(sizeBytes / CHUNK_SIZE));
      // All bytes round-tripped.
      expect(totalBytes).toBe(sizeBytes);
    });
  });

  describe('3. Tampered-chunk termination (Req 12.4)', () => {
    it('emits an error (auth-tag failure) instead of completing with full valid plaintext', async () => {
      const plaintext = crypto.randomBytes(128 * 1024);
      const encPath = await encrypt('tampered-128k', plaintext);

      // Corrupt a single ciphertext byte on disk (after the 28-byte [IV][AuthTag] header).
      const fileData = await fs.promises.readFile(encPath);
      const tamperIndex = HEADER_LENGTH + 10;
      fileData[tamperIndex] = fileData[tamperIndex] ^ 0xff;
      await fs.promises.writeFile(encPath, fileData);

      const { stream } = await service.createDecryptStream('tampered-128k');

      const received: Buffer[] = [];
      let error: unknown;
      try {
        for await (const chunk of stream) {
          received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
      } catch (err) {
        error = err;
      }

      // The stream terminated with an error rather than resolving cleanly.
      expect(error).toBeDefined();
      // It did NOT deliver the full, valid original plaintext.
      expect(Buffer.concat(received).equals(plaintext)).toBe(false);
    });
  });

  describe('4. Client-disconnect cleanup (Req 12.5)', () => {
    it('releases the decrypt stream and the underlying file read stream when the consumer is destroyed early', async () => {
      // Spy on createReadStream so we can capture the underlying ciphertext read stream that
      // owns the file descriptor. serveEncryptedFile destroys the decrypt stream on the
      // response `close` event; here we drive that same teardown by destroying the returned
      // stream directly.
      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      // Large enough that the transfer is still in progress when we "disconnect".
      const plaintext = crypto.randomBytes(4 * 1024 * 1024);
      await encrypt('disconnect-4mb', plaintext);

      const { stream } = await service.createDecryptStream('disconnect-4mb');

      // The ciphertext read stream created inside createDecryptStream (start = HEADER_LENGTH).
      expect(createReadStreamSpy).toHaveBeenCalled();
      const underlyingReadStream = createReadStreamSpy.mock.results[0].value as fs.ReadStream;
      expect(underlyingReadStream.destroyed).toBe(false);

      // Consume a single chunk, then simulate a client disconnect mid-transfer by destroying
      // the consumer/decrypt stream (this mirrors serveEncryptedFile's res 'close' handler).
      await once(stream, 'readable');
      stream.read();
      stream.destroy();

      // Wait for teardown to propagate to the decipher and underlying read stream.
      await once(stream, 'close');
      if (!underlyingReadStream.destroyed) {
        await once(underlyingReadStream, 'close');
      }

      // Decrypt stream is destroyed and the underlying read stream / file handle is released.
      expect(stream.destroyed).toBe(true);
      expect(underlyingReadStream.destroyed).toBe(true);
    });

    it('stops producing further chunks after the consumer disconnects', async () => {
      const plaintext = crypto.randomBytes(4 * 1024 * 1024);
      await encrypt('disconnect-stop', plaintext);

      const { stream } = await service.createDecryptStream('disconnect-stop');

      let chunksAfterDestroy = 0;
      let destroyed = false;

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          if (destroyed) {
            // Any data delivered after destroy() would indicate the source kept decrypting.
            chunksAfterDestroy += 1;
            return;
          }
          // Disconnect after the first chunk.
          destroyed = true;
          stream.destroy();
        });
        stream.on('close', () => resolve());
        stream.on('error', (err) => {
          // A destroy() without an error argument should not surface as an error; if it does
          // for an unrelated reason, fail explicitly.
          reject(err);
        });
      });

      expect(destroyed).toBe(true);
      // No further chunks were decrypted/emitted once the consumer disconnected.
      expect(chunksAfterDestroy).toBe(0);
    });
  });
});

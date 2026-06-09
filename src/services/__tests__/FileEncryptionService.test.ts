import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileEncryptionService } from '../FileEncryptionService';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('FileEncryptionService', () => {
  const originalEnv = process.env;
  let tmpDir: string;
  let service: FileEncryptionService;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'enc-test-'));
    process.env = { ...originalEnv, FILE_ENCRYPTION_KEY: 'test-encryption-key-for-unit-tests-minimum-32-chars' };
    service = new FileEncryptionService(tmpDir);
  });

  afterEach(async () => {
    process.env = originalEnv;
    // Clean up temp directory
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should enable encryption when FILE_ENCRYPTION_KEY is set', () => {
      expect(service.isEncryptionEnabled()).toBe(true);
    });

    it('should disable encryption when FILE_ENCRYPTION_KEY is not set', () => {
      delete process.env.FILE_ENCRYPTION_KEY;
      const noKeyService = new FileEncryptionService(tmpDir);
      expect(noKeyService.isEncryptionEnabled()).toBe(false);
    });
  });

  describe('encryptFile', () => {
    it('should encrypt a file and return metadata with iv, authTag, and checksum', async () => {
      const buffer = Buffer.from('Hello, this is a test file content for encryption.');
      const input = {
        fileId: 'test-file-001',
        originalName: 'document.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        keyVersion: 1,
      };

      const result = await service.encryptFile(buffer, input);

      expect(result.metadata.fileId).toBe('test-file-001');
      expect(result.metadata.originalName).toBe('document.pdf');
      expect(result.metadata.mimeType).toBe('application/pdf');
      expect(result.metadata.size).toBe(buffer.length);
      expect(result.metadata.iv).toBeTruthy();
      expect(result.metadata.authTag).toBeTruthy();
      expect(result.metadata.checksum).toBeTruthy();
      expect(result.metadata.encryptedAt).toBeTruthy();
      expect(result.metadata.keyVersion).toBe(1);
      expect(result.path).toContain('.enc');
    });

    it('should save encrypted file with .enc extension', async () => {
      const buffer = Buffer.from('Test content');
      const input = {
        fileId: 'test-file-002',
        originalName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: buffer.length,
        keyVersion: 1,
      };

      const result = await service.encryptFile(buffer, input);

      expect(result.path).toBe(path.join(tmpDir, 'test-file-002.enc'));
      // Verify file exists
      const stat = await fs.promises.stat(result.path);
      expect(stat.isFile()).toBe(true);
    });

    it('should write encrypted file in format [IV(12)][AuthTag(16)][Ciphertext]', async () => {
      const buffer = Buffer.from('Content to verify format');
      const input = {
        fileId: 'test-file-003',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };

      const result = await service.encryptFile(buffer, input);
      const fileData = await fs.promises.readFile(result.path);

      // File should be at least IV(12) + AuthTag(16) + some ciphertext
      expect(fileData.length).toBeGreaterThan(28);

      // IV should be 12 bytes
      const iv = fileData.subarray(0, 12);
      expect(iv.length).toBe(12);

      // AuthTag should be 16 bytes
      const authTag = fileData.subarray(12, 28);
      expect(authTag.length).toBe(16);
    });

    it('should compute correct SHA-256 checksum of original file', async () => {
      const buffer = Buffer.from('Checksum verification content');
      const expectedChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

      const input = {
        fileId: 'test-file-004',
        originalName: 'check.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };

      const result = await service.encryptFile(buffer, input);
      expect(result.metadata.checksum).toBe(expectedChecksum);
    });

    it('should generate unique IVs for different files', async () => {
      const buffer = Buffer.from('Same content');
      const input1 = {
        fileId: 'test-file-005a',
        originalName: 'file1.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };
      const input2 = {
        fileId: 'test-file-005b',
        originalName: 'file2.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };

      const result1 = await service.encryptFile(buffer, input1);
      const result2 = await service.encryptFile(buffer, input2);

      expect(result1.metadata.iv).not.toBe(result2.metadata.iv);
    });

    it('should store file unencrypted when encryption is disabled', async () => {
      delete process.env.FILE_ENCRYPTION_KEY;
      const noKeyService = new FileEncryptionService(tmpDir);

      const content = 'Unencrypted content';
      const buffer = Buffer.from(content);
      const input = {
        fileId: 'test-file-006',
        originalName: 'plain.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 0,
      };

      const result = await noKeyService.encryptFile(buffer, input);

      // File should be stored without .enc extension
      expect(result.path).not.toContain('.enc');
      // File content should be the original buffer
      const stored = await fs.promises.readFile(result.path);
      expect(stored.toString()).toBe(content);
      // Metadata should have empty iv and authTag
      expect(result.metadata.iv).toBe('');
      expect(result.metadata.authTag).toBe('');
      expect(result.metadata.keyVersion).toBe(0);
      // Checksum should still be computed
      expect(result.metadata.checksum).toBeTruthy();
    });
  });

  describe('decryptFile', () => {
    it('should decrypt an encrypted file and return original content', async () => {
      const originalContent = 'This is the original file content that should be recovered after decryption.';
      const buffer = Buffer.from(originalContent);
      const input = {
        fileId: 'test-decrypt-001',
        originalName: 'secret.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        keyVersion: 1,
      };

      await service.encryptFile(buffer, input);
      const result = await service.decryptFile('test-decrypt-001');

      expect(result.buffer.toString()).toBe(originalContent);
      expect(result.metadata.fileId).toBe('test-decrypt-001');
    });

    it('should throw error for non-existent file metadata', async () => {
      await expect(service.decryptFile('non-existent-id')).rejects.toThrow(
        'File metadata not found'
      );
    });

    it('should throw error when encryption key is missing but file was encrypted', async () => {
      const buffer = Buffer.from('Encrypted content');
      const input = {
        fileId: 'test-decrypt-002',
        originalName: 'locked.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        keyVersion: 1,
      };

      // Encrypt with key
      await service.encryptFile(buffer, input);

      // Create a new service without key but with the same metadata
      delete process.env.FILE_ENCRYPTION_KEY;
      const noKeyService = new FileEncryptionService(tmpDir);
      noKeyService.setMetadata('test-decrypt-002', service.getMetadata('test-decrypt-002')!);

      await expect(noKeyService.decryptFile('test-decrypt-002')).rejects.toThrow(
        'Cannot decrypt file: FILE_ENCRYPTION_KEY is not set'
      );
    });

    it('should return unencrypted file when keyVersion is 0', async () => {
      delete process.env.FILE_ENCRYPTION_KEY;
      const noKeyService = new FileEncryptionService(tmpDir);

      const content = 'Plain text file';
      const buffer = Buffer.from(content);
      const input = {
        fileId: 'test-decrypt-003',
        originalName: 'plain.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 0,
      };

      await noKeyService.encryptFile(buffer, input);
      const result = await noKeyService.decryptFile('test-decrypt-003');

      expect(result.buffer.toString()).toBe(content);
    });
  });

  describe('encryption roundtrip', () => {
    it('should satisfy decrypt(encrypt(data)) === data for various content', async () => {
      const testCases = [
        Buffer.from('Simple text'),
        Buffer.from('مرحبا بالعالم - Arabic text'),
        crypto.randomBytes(1024), // Random binary data
        Buffer.alloc(0), // Empty buffer
        Buffer.from('A'.repeat(10000)), // Larger content
      ];

      for (let i = 0; i < testCases.length; i++) {
        const buffer = testCases[i];
        const input = {
          fileId: `roundtrip-${i}`,
          originalName: `test-${i}.bin`,
          mimeType: 'application/octet-stream',
          size: buffer.length,
          keyVersion: 1,
        };

        await service.encryptFile(buffer, input);
        const result = await service.decryptFile(`roundtrip-${i}`);

        expect(Buffer.compare(result.buffer, buffer)).toBe(0);
      }
    });
  });

  describe('verifyIntegrity', () => {
    it('should return true for a valid encrypted file', async () => {
      const buffer = Buffer.from('Integrity check content');
      const input = {
        fileId: 'integrity-001',
        originalName: 'check.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };

      await service.encryptFile(buffer, input);
      const isValid = await service.verifyIntegrity('integrity-001');

      expect(isValid).toBe(true);
    });

    it('should return false for a tampered file', async () => {
      const buffer = Buffer.from('Original content');
      const input = {
        fileId: 'integrity-002',
        originalName: 'tampered.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 1,
      };

      await service.encryptFile(buffer, input);

      // Tamper with the encrypted file (modify a byte in the ciphertext area)
      const encPath = path.join(tmpDir, 'integrity-002.enc');
      const fileData = await fs.promises.readFile(encPath);
      // Modify a byte in the ciphertext (after IV + AuthTag)
      const tampered = Buffer.from(fileData);
      if (tampered.length > 29) {
        tampered[29] = tampered[29] ^ 0xff;
      }
      await fs.promises.writeFile(encPath, tampered);

      const isValid = await service.verifyIntegrity('integrity-002');
      expect(isValid).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const isValid = await service.verifyIntegrity('non-existent');
      expect(isValid).toBe(false);
    });
  });

  describe('rotateKey', () => {
    it('should re-encrypt a file with a new key', async () => {
      const originalContent = 'Content to be re-encrypted with new key';
      const buffer = Buffer.from(originalContent);
      const oldKey = 'test-encryption-key-for-unit-tests-minimum-32-chars';
      const newKey = 'new-encryption-key-for-rotation-testing-minimum-32';

      const input = {
        fileId: 'rotate-001',
        originalName: 'rotate.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        keyVersion: 1,
      };

      const encResult = await service.encryptFile(buffer, input);
      const originalIv = encResult.metadata.iv;

      // Rotate key
      const updatedMetadata = await service.rotateKey('rotate-001', oldKey, newKey, 2);

      expect(updatedMetadata.keyVersion).toBe(2);
      // New IV should be different from the original
      expect(updatedMetadata.iv).not.toBe(originalIv);

      // Verify we can still decrypt with the new key active
      const result = await service.decryptFile('rotate-001');
      expect(result.buffer.toString()).toBe(originalContent);
    });

    it('should throw error for non-existent file during rotation', async () => {
      await expect(
        service.rotateKey('non-existent', 'old', 'new', 2)
      ).rejects.toThrow('File metadata not found');
    });
  });

  describe('rotateEncryptionKey (bulk)', () => {
    it('should re-encrypt all files with the new key', async () => {
      const contents = ['File 1 content', 'File 2 content', 'File 3 content'];

      for (let i = 0; i < contents.length; i++) {
        const buffer = Buffer.from(contents[i]);
        await service.encryptFile(buffer, {
          fileId: `bulk-${i}`,
          originalName: `file-${i}.txt`,
          mimeType: 'text/plain',
          size: buffer.length,
          keyVersion: 1,
        });
      }

      const oldKey = Buffer.from('test-encryption-key-for-unit-tests-minimum-32-chars', 'utf8');
      const newKey = Buffer.from('new-bulk-rotation-key-for-testing-minimum-32-chars!', 'utf8');

      await service.rotateEncryptionKey(oldKey, newKey);

      // Verify all files can still be decrypted
      for (let i = 0; i < contents.length; i++) {
        const result = await service.decryptFile(`bulk-${i}`);
        expect(result.buffer.toString()).toBe(contents[i]);
        expect(result.metadata.keyVersion).toBe(2);
      }
    });

    it('should skip unencrypted files during bulk rotation', async () => {
      delete process.env.FILE_ENCRYPTION_KEY;
      const mixedService = new FileEncryptionService(tmpDir);

      // Store an unencrypted file
      const buffer = Buffer.from('Unencrypted');
      await mixedService.encryptFile(buffer, {
        fileId: 'unenc-001',
        originalName: 'plain.txt',
        mimeType: 'text/plain',
        size: buffer.length,
        keyVersion: 0,
      });

      // Now enable encryption and add an encrypted file
      process.env.FILE_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-minimum-32-chars';
      const encService = new FileEncryptionService(tmpDir);
      // Copy metadata from mixed service
      encService.setMetadata('unenc-001', mixedService.getMetadata('unenc-001')!);

      const encBuffer = Buffer.from('Encrypted content');
      await encService.encryptFile(encBuffer, {
        fileId: 'enc-001',
        originalName: 'secret.pdf',
        mimeType: 'application/pdf',
        size: encBuffer.length,
        keyVersion: 1,
      });

      const oldKey = Buffer.from('test-encryption-key-for-unit-tests-minimum-32-chars', 'utf8');
      const newKey = Buffer.from('new-bulk-rotation-key-for-testing-minimum-32-chars!', 'utf8');

      // Should not throw for unencrypted files
      await encService.rotateEncryptionKey(oldKey, newKey);

      // Encrypted file should be re-encrypted
      const result = await encService.decryptFile('enc-001');
      expect(result.buffer.toString()).toBe('Encrypted content');
      expect(result.metadata.keyVersion).toBe(2);

      // Unencrypted file metadata should remain unchanged
      const unencMeta = encService.getMetadata('unenc-001');
      expect(unencMeta?.keyVersion).toBe(0);
    });
  });
});

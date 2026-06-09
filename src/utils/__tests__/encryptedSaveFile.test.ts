// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createEncryptedSaveFile } from '../serverUtils';

// Mock the logger module
vi.mock('../logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock magika to avoid loading the heavy ML model in tests
vi.mock('magika', () => ({
  Magika: {
    create: vi.fn().mockResolvedValue(null),
  },
}));

const TEST_UPLOAD_DIR = path.join(process.cwd(), 'tmp', 'test-encrypted-uploads');

/** Creates a mock file object similar to express-fileupload */
function createMockFile(options: {
  name?: string;
  mimetype?: string;
  data?: Buffer;
  size?: number;
} = {}) {
  const data = options.data || Buffer.from('test file content for encryption');
  return {
    name: options.name || 'test-document.pdf',
    mimetype: options.mimetype || 'application/pdf',
    data,
    size: options.size || data.length,
    tempFilePath: '',
    mv: vi.fn().mockResolvedValue(undefined),
  };
}

/** Creates a mock database instance */
function createMockDb() {
  const runFn = vi.fn().mockResolvedValue(undefined);
  return {
    prepare: vi.fn().mockResolvedValue({ run: runFn }),
    _runFn: runFn,
  };
}

describe('createEncryptedSaveFile', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Ensure upload dir exists
    if (!fs.existsSync(TEST_UPLOAD_DIR)) {
      fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clean up test files
    if (fs.existsSync(TEST_UPLOAD_DIR)) {
      const files = fs.readdirSync(TEST_UPLOAD_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(TEST_UPLOAD_DIR, file));
      }
    }
  });

  describe('when FILE_ENCRYPTION_KEY is NOT set', () => {
    beforeEach(() => {
      delete process.env.FILE_ENCRYPTION_KEY;
    });

    it('should fall back to original unencrypted save behavior', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile();

      const result = await saveFile(file);

      // Should use the original saveFile which calls file.mv()
      expect(file.mv).toHaveBeenCalled();
      expect(result).toMatch(/^\/uploads\//);
      // Should NOT have .enc extension
      expect(result).not.toContain('.enc');
      // Should NOT insert into encrypted_files table
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });
  });

  describe('when FILE_ENCRYPTION_KEY is set', () => {
    const TEST_KEY = 'test-encryption-key-for-unit-tests-minimum-length';

    beforeEach(() => {
      process.env.FILE_ENCRYPTION_KEY = TEST_KEY;
    });

    it('should encrypt the file and save with .enc extension', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const fileContent = Buffer.from('sensitive audit evidence data');
      const file = createMockFile({ data: fileContent });

      const result = await saveFile(file);

      // Should return path with .enc extension
      expect(result).toMatch(/^\/uploads\/.*\.enc$/);

      // Verify the encrypted file exists on disk
      const encryptedFilePath = path.join(TEST_UPLOAD_DIR, path.basename(result));
      expect(fs.existsSync(encryptedFilePath)).toBe(true);

      // Verify the file content is NOT the original plaintext
      const encryptedContent = fs.readFileSync(encryptedFilePath);
      expect(encryptedContent.toString()).not.toEqual(fileContent.toString());

      // Verify file structure: [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
      expect(encryptedContent.length).toBeGreaterThan(12 + 16);
    });

    it('should store encryption metadata in the database', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile({ name: 'evidence.pdf', mimetype: 'application/pdf' });

      await saveFile(file);

      // Should have called db.prepare with INSERT INTO encrypted_files
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO encrypted_files')
      );

      // Should have called run with the correct parameters
      expect(mockDb._runFn).toHaveBeenCalledWith(
        expect.any(String),   // fileId (UUID)
        'evidence.pdf',       // original_name
        'application/pdf',    // mime_type
        expect.any(Number),   // original_size
        expect.any(String),   // encrypted_path
        expect.any(String),   // iv (base64)
        expect.any(String),   // auth_tag (base64)
        expect.any(String),   // checksum_sha256
        1,                    // key_version
        'system',             // uploaded_by (default)
        'audit'              // module (default)
      );
    });

    it('should set file permissions to 0o600', async () => {
      // Skip on Windows as file permissions work differently
      if (process.platform === 'win32') return;

      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile();

      const result = await saveFile(file);

      const encryptedFilePath = path.join(TEST_UPLOAD_DIR, path.basename(result));
      const stats = fs.statSync(encryptedFilePath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });

    it('should reject files with disallowed extensions', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile({ name: 'malware.exe', mimetype: 'application/x-msdownload' });

      await expect(saveFile(file)).rejects.toThrow(/not allowed/);
    });

    it('should reject files with MIME type mismatch', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile({ name: 'document.pdf', mimetype: 'image/png' });

      await expect(saveFile(file)).rejects.toThrow(/mismatch/i);
    });

    it('should clean up encrypted file if database insert fails', async () => {
      const mockDb = createMockDb();
      mockDb.prepare = vi.fn().mockResolvedValue({
        run: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      });
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile();

      await expect(saveFile(file)).rejects.toThrow('DB connection lost');

      // Verify no .enc files remain in the upload directory
      const remainingFiles = fs.readdirSync(TEST_UPLOAD_DIR).filter(f => f.endsWith('.enc'));
      expect(remainingFiles).toHaveLength(0);
    });

    it('should pass custom module and uploadedBy options to database', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const file = createMockFile();

      await saveFile(file, { module: 'fraud', uploadedBy: 'user-123' });

      expect(mockDb._runFn).toHaveBeenCalledWith(
        expect.any(String),   // fileId
        expect.any(String),   // original_name
        expect.any(String),   // mime_type
        expect.any(Number),   // original_size
        expect.any(String),   // encrypted_path
        expect.any(String),   // iv
        expect.any(String),   // auth_tag
        expect.any(String),   // checksum
        1,                    // key_version
        'user-123',           // uploaded_by
        'fraud'              // module
      );
    });

    it('should compute correct SHA-256 checksum of original file', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const fileContent = Buffer.from('checksum verification test data');
      const expectedChecksum = crypto.createHash('sha256').update(fileContent).digest('hex');
      const file = createMockFile({ data: fileContent });

      await saveFile(file);

      // The 8th argument to run() should be the checksum
      const runArgs = mockDb._runFn.mock.calls[0];
      expect(runArgs[7]).toBe(expectedChecksum);
    });

    it('should handle files from tempFilePath when data buffer is not available', async () => {
      const mockDb = createMockDb();
      const saveFile = createEncryptedSaveFile(TEST_UPLOAD_DIR, mockDb);
      const fileContent = Buffer.from('temp file content');

      // Create a temp file
      const tempPath = path.join(TEST_UPLOAD_DIR, 'temp-upload.tmp');
      fs.writeFileSync(tempPath, fileContent);

      const file = {
        name: 'document.pdf',
        mimetype: 'application/pdf',
        data: null, // No buffer available
        size: fileContent.length,
        tempFilePath: tempPath,
        mv: vi.fn(),
      };

      const result = await saveFile(file);

      expect(result).toMatch(/^\/uploads\/.*\.enc$/);
    });
  });
});

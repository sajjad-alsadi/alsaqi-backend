import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import bcrypt from 'bcryptjs';

// Set encryption key before importing the service
process.env.TOTP_ENCRYPTION_KEY = 'test-totp-encryption-key-for-unit-tests-minimum-length';

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: vi.fn(),
  },
}));

// Mock the logger
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { TOTPServiceImpl } from '../TOTPService';
import { db } from '../../db/index';
import { AuthError, NotFoundError } from '../../utils/errors';

describe('TOTPService', () => {
  let service: TOTPServiceImpl;

  beforeEach(() => {
    service = new TOTPServiceImpl();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setup()', () => {
    it('should return a base32 secret, QR code data URL, and 10 backup codes', async () => {
      const userId = 'user-123';

      // Mock user lookup
      const mockGet = vi.fn()
        .mockResolvedValueOnce({ username: 'testuser', email: 'test@example.com' }); // user lookup
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT username')) {
          return { get: mockGet };
        }
        if (sql.includes('DELETE FROM user_totp') || sql.includes('INSERT INTO user_totp')) {
          return { run: mockRun };
        }
        return { get: mockGet, run: mockRun };
      });

      const result = await service.setup(userId);

      // Verify base32 secret
      expect(result.secret).toBeDefined();
      expect(result.secret.length).toBeGreaterThan(0);
      // Base32 characters: A-Z, 2-7
      expect(result.secret).toMatch(/^[A-Z2-7]+=*$/);

      // Verify QR code data URL
      expect(result.qrCodeDataUrl).toBeDefined();
      expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      // Verify 10 backup codes
      expect(result.backupCodes).toBeDefined();
      expect(result.backupCodes).toHaveLength(10);
      result.backupCodes.forEach((code) => {
        expect(code.length).toBe(8);
      });
    });

    it('should throw NotFoundError if user does not exist', async () => {
      const mockGet = vi.fn().mockResolvedValue(undefined);
      (db.prepare as any).mockReturnValue({ get: mockGet });

      await expect(service.setup('nonexistent-user')).rejects.toThrow(NotFoundError);
    });
  });

  describe('verify()', () => {
    it('should accept a valid TOTP code within ±1 time window', async () => {
      const userId = 'user-456';

      // Generate a real TOTP secret
      const totp = new OTPAuth.TOTP({
        issuer: 'AL-SAQI',
        label: userId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      });
      const base32Secret = totp.secret.base32;

      // Encrypt the secret the same way the service does
      const encryptedData = encryptTestSecret(base32Secret);

      // Mock DB to return the encrypted record
      const mockGet = vi.fn().mockResolvedValue({
        secret_encrypted: encryptedData.encrypted,
        secret_iv: encryptedData.iv,
        secret_tag: encryptedData.tag,
        is_enabled: true,
      });
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT secret_encrypted')) {
          return { get: mockGet };
        }
        if (sql.includes('UPDATE user_totp')) {
          return { run: mockRun };
        }
        return { get: mockGet, run: mockRun };
      });

      // Generate a valid token for the current time
      const validToken = totp.generate();

      const result = await service.verify(userId, validToken);
      expect(result).toBe(true);
    });

    it('should reject invalid/random TOTP codes', async () => {
      const userId = 'user-789';

      // Generate a real TOTP secret
      const totp = new OTPAuth.TOTP({
        issuer: 'AL-SAQI',
        label: userId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      });
      const base32Secret = totp.secret.base32;

      const encryptedData = encryptTestSecret(base32Secret);

      const mockGet = vi.fn().mockResolvedValue({
        secret_encrypted: encryptedData.encrypted,
        secret_iv: encryptedData.iv,
        secret_tag: encryptedData.tag,
        is_enabled: true,
      });

      (db.prepare as any).mockImplementation(() => ({
        get: mockGet,
        run: vi.fn().mockResolvedValue({ changes: 0 }),
      }));

      // Use a random invalid code
      const result = await service.verify(userId, '000000');
      expect(result).toBe(false);
    });

    it('should return false when no TOTP record exists', async () => {
      const mockGet = vi.fn().mockResolvedValue(undefined);
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.verify('no-record-user', '123456');
      expect(result).toBe(false);
    });
  });

  describe('verify() timing-safe comparison', () => {
    it('should use crypto.timingSafeEqual in the verification code path', async () => {
      const userId = 'user-timing';

      const totp = new OTPAuth.TOTP({
        issuer: 'AL-SAQI',
        label: userId,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      });
      const base32Secret = totp.secret.base32;
      const encryptedData = encryptTestSecret(base32Secret);

      const mockGet = vi.fn().mockResolvedValue({
        secret_encrypted: encryptedData.encrypted,
        secret_iv: encryptedData.iv,
        secret_tag: encryptedData.tag,
        is_enabled: true,
      });
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT secret_encrypted')) {
          return { get: mockGet };
        }
        return { get: mockGet, run: mockRun };
      });

      // Spy on crypto.timingSafeEqual
      const timingSafeSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const validToken = totp.generate();
      await service.verify(userId, validToken);

      // The service calls timingSafeEqual as defense-in-depth
      expect(timingSafeSpy).toHaveBeenCalled();

      timingSafeSpy.mockRestore();
    });
  });

  describe('useBackupCode()', () => {
    it('should accept a valid backup code and remove it (single-use)', async () => {
      const userId = 'user-backup';
      const backupCode = 'AbCd1234';

      // Hash the backup code like the service does
      const hashedCode = bcrypt.hashSync(backupCode, 10);
      const hashedCodes = JSON.stringify([hashedCode, bcrypt.hashSync('OtherCode', 10)]);

      const mockGet = vi.fn().mockResolvedValue({
        id: 'record-1',
        backup_codes_hash: hashedCodes,
      });
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, backup_codes_hash')) {
          return { get: mockGet };
        }
        if (sql.includes('UPDATE user_totp SET backup_codes_hash')) {
          return { run: mockRun };
        }
        return { get: mockGet, run: mockRun };
      });

      const result = await service.useBackupCode(userId, backupCode);
      expect(result).toBe(true);

      // Verify the update was called with one fewer code
      expect(mockRun).toHaveBeenCalled();
      const updatedJson = mockRun.mock.calls[0][0];
      const updatedCodes = JSON.parse(updatedJson);
      expect(updatedCodes).toHaveLength(1); // One code removed
    });

    it('should reject an invalid backup code', async () => {
      const userId = 'user-backup-invalid';
      const hashedCodes = JSON.stringify([bcrypt.hashSync('ValidCode', 10)]);

      const mockGet = vi.fn().mockResolvedValue({
        id: 'record-2',
        backup_codes_hash: hashedCodes,
      });

      (db.prepare as any).mockReturnValue({ get: mockGet, run: vi.fn() });

      const result = await service.useBackupCode(userId, 'WrongCode');
      expect(result).toBe(false);
    });

    it('should not allow the same backup code to be used twice', async () => {
      const userId = 'user-backup-twice';
      const backupCode = 'UseOnce1';
      const hashedCode = bcrypt.hashSync(backupCode, 10);

      // First use: code exists
      let currentCodes = [hashedCode, bcrypt.hashSync('AnotherC', 10)];

      const mockRun = vi.fn().mockImplementation((updatedJson: string) => {
        // Simulate the DB update by updating our local state
        currentCodes = JSON.parse(updatedJson);
        return Promise.resolve({ changes: 1 });
      });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, backup_codes_hash')) {
          return {
            get: vi.fn().mockResolvedValue({
              id: 'record-3',
              backup_codes_hash: JSON.stringify(currentCodes),
            }),
          };
        }
        if (sql.includes('UPDATE user_totp SET backup_codes_hash')) {
          return { run: mockRun };
        }
        return { get: vi.fn(), run: mockRun };
      });

      // First use should succeed
      const firstResult = await service.useBackupCode(userId, backupCode);
      expect(firstResult).toBe(true);

      // Second use should fail (code was removed)
      const secondResult = await service.useBackupCode(userId, backupCode);
      expect(secondResult).toBe(false);
    });

    it('should return false when no TOTP record exists', async () => {
      const mockGet = vi.fn().mockResolvedValue(undefined);
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.useBackupCode('no-record', 'SomeCode');
      expect(result).toBe(false);
    });
  });

  describe('isEnabled()', () => {
    it('should return false when no TOTP record exists', async () => {
      const mockGet = vi.fn().mockResolvedValue(undefined);
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.isEnabled('no-record-user');
      expect(result).toBe(false);
    });

    it('should return true when is_enabled is true', async () => {
      const mockGet = vi.fn().mockResolvedValue({ is_enabled: true });
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.isEnabled('enabled-user');
      expect(result).toBe(true);
    });

    it('should return true when is_enabled is 1 (integer)', async () => {
      const mockGet = vi.fn().mockResolvedValue({ is_enabled: 1 });
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.isEnabled('enabled-user-int');
      expect(result).toBe(true);
    });

    it('should return false when is_enabled is false', async () => {
      const mockGet = vi.fn().mockResolvedValue({ is_enabled: false });
      (db.prepare as any).mockReturnValue({ get: mockGet });

      const result = await service.isEnabled('disabled-user');
      expect(result).toBe(false);
    });
  });

  describe('disable()', () => {
    it('should disable 2FA when correct password is provided', async () => {
      const userId = 'user-disable';
      const password = 'correctPassword123';
      const hashedPassword = bcrypt.hashSync(password, 10);

      const mockGet = vi.fn()
        .mockResolvedValueOnce({ id: userId, password: hashedPassword }) // user lookup
        .mockResolvedValueOnce({ id: 'totp-record-1' }); // totp record lookup
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      (db.prepare as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, password')) {
          return { get: () => mockGet() };
        }
        if (sql.includes('SELECT id FROM user_totp')) {
          return { get: () => mockGet() };
        }
        if (sql.includes('DELETE FROM user_totp')) {
          return { run: mockRun };
        }
        return { get: () => mockGet(), run: mockRun };
      });

      await expect(service.disable(userId, password)).resolves.toBeUndefined();
      expect(mockRun).toHaveBeenCalled();
    });

    it('should throw AuthError when wrong password is provided', async () => {
      const userId = 'user-wrong-pw';
      const hashedPassword = bcrypt.hashSync('correctPassword', 10);

      const mockGet = vi.fn().mockResolvedValue({ id: userId, password: hashedPassword });
      (db.prepare as any).mockReturnValue({ get: mockGet });

      await expect(service.disable(userId, 'wrongPassword')).rejects.toThrow(AuthError);
    });

    it('should throw NotFoundError when user does not exist', async () => {
      const mockGet = vi.fn().mockResolvedValue(undefined);
      (db.prepare as any).mockReturnValue({ get: mockGet });

      await expect(service.disable('nonexistent', 'password')).rejects.toThrow(NotFoundError);
    });
  });
});

// ─── Helper: Encrypt a secret the same way TOTPService does ──────────────────

function encryptTestSecret(secret: string): { encrypted: string; iv: string; tag: string } {
  const rawKey = process.env.TOTP_ENCRYPTION_KEY!;
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(rawKey, 'utf8'),
    Buffer.from('alsaqi-totp-enc-salt', 'utf8'),
    Buffer.from('alsaqi-totp-encryption', 'utf8'),
    32
  );
  const key = Buffer.from(derived);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

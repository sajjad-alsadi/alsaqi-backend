// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateProductionSecrets, runSecretsValidation } from '../secretsValidator';

// Mock the logger module
vi.mock('../logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

import logger from '../logger';

/** Helper: creates a valid env object that passes all validations */
function createValidEnv(): Record<string, string> {
  return {
    JWT_SECRET: 'a'.repeat(64), // 64 chars, not a weak default
    VITE_STORAGE_SECRET: 'b'.repeat(32), // 32 chars, not a weak default
    VITE_NETWORK_SECRET: 'some-strong-network-secret-value',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/alsaqi',
    CORS_ORIGIN: 'https://alsaqi.example.com',
    FILE_ENCRYPTION_KEY: 'c'.repeat(32),
  };
}

describe('validateProductionSecrets', () => {
  describe('weak defaults rejected', () => {
    it('should reject JWT_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.JWT_SECRET = 'alsaqi-dev-secret-key-123';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('JWT_SECRET')
      );
    });

    it('should reject VITE_STORAGE_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.VITE_STORAGE_SECRET = 'your-32-character-secret-key-here';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('VITE_STORAGE_SECRET')
      );
    });

    it('should reject VITE_NETWORK_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.VITE_NETWORK_SECRET = 'your-network-hmac-secret-here';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('VITE_NETWORK_SECRET')
      );
    });
  });

  describe('short secrets rejected', () => {
    it('should reject JWT_SECRET shorter than 64 characters', () => {
      const env = createValidEnv();
      env.JWT_SECRET = 'short-but-not-a-default'; // < 64 chars

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('JWT_SECRET must be at least 64 characters')
      );
    });

    it('should reject VITE_STORAGE_SECRET shorter than 32 characters', () => {
      const env = createValidEnv();
      env.VITE_STORAGE_SECRET = 'short-secret'; // < 32 chars

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('VITE_STORAGE_SECRET must be at least 32 characters')
      );
    });
  });

  describe('missing DATABASE_URL rejected', () => {
    it('should reject when DATABASE_URL is undefined', () => {
      const env = createValidEnv();
      delete (env as Record<string, string | undefined>).DATABASE_URL;

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('DATABASE_URL')
      );
    });
  });

  describe('valid secrets accepted', () => {
    it('should accept all secrets meeting requirements', () => {
      const env = createValidEnv();

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('warnings for optional variables', () => {
    it('should warn when CORS_ORIGIN is not set', () => {
      const env = createValidEnv();
      delete (env as Record<string, string | undefined>).CORS_ORIGIN;

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('CORS_ORIGIN')
      );
    });

    it('should warn when FILE_ENCRYPTION_KEY is not set', () => {
      const env = createValidEnv();
      delete (env as Record<string, string | undefined>).FILE_ENCRYPTION_KEY;

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('FILE_ENCRYPTION_KEY')
      );
    });
  });
});

describe('runSecretsValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('development mode allows weak secrets with warnings', () => {
    it('should NOT exit and should log warnings when NODE_ENV=development with weak secrets', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'development',
        JWT_SECRET: 'alsaqi-dev-secret-key-123',
        VITE_STORAGE_SECRET: 'your-32-character-secret-key-here',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
        DATABASE_URL: 'postgresql://localhost/test',
      };

      const result = runSecretsValidation(env);

      // Should return the validation result (errors present but not blocking)
      expect(result.isValid).toBe(false);
      // Should log warnings, not errors
      expect(logger.warn).toHaveBeenCalled();
      // Should NOT log errors (production-only behavior)
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should log debug messages for optional variable warnings in development', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'development',
        JWT_SECRET: 'a'.repeat(64),
        VITE_STORAGE_SECRET: 'b'.repeat(32),
        VITE_NETWORK_SECRET: 'strong-network-secret',
        DATABASE_URL: 'postgresql://localhost/test',
      };

      const result = runSecretsValidation(env);

      expect(result.isValid).toBe(true);
      // Optional variable warnings should be logged as debug in development
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  describe('production mode logs errors', () => {
    it('should log errors when NODE_ENV=production with invalid secrets', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'production',
        JWT_SECRET: 'alsaqi-dev-secret-key-123',
        VITE_STORAGE_SECRET: 'your-32-character-secret-key-here',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
      };

      const result = runSecretsValidation(env);

      expect(result.isValid).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

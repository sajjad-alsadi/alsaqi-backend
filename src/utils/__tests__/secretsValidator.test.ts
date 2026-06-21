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

/** Helper: creates a valid env object where all three secrets pass. */
function createValidEnv(): Record<string, string> {
  return {
    JWT_SECRET: 'a'.repeat(64), // 64 chars, not a weak default
    VITE_STORAGE_SECRET: 'b'.repeat(32), // 32 chars, not a weak default
    VITE_NETWORK_SECRET: 'some-strong-network-secret-value',
  };
}

/** Helper: finds a failure entry for a given variable. */
function failureFor(
  result: ReturnType<typeof validateProductionSecrets>,
  variable: string
) {
  return result.failures.find((f) => f.variable === variable);
}

describe('validateProductionSecrets', () => {
  describe('weak defaults rejected', () => {
    it('should reject JWT_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.JWT_SECRET = 'alsaqi-dev-secret-key-123';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'JWT_SECRET')?.reason).toBe('weak-default');
    });

    it('should reject VITE_STORAGE_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.VITE_STORAGE_SECRET = 'your-32-character-secret-key-here';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'VITE_STORAGE_SECRET')?.reason).toBe('weak-default');
    });

    it('should reject VITE_NETWORK_SECRET with weak default value', () => {
      const env = createValidEnv();
      env.VITE_NETWORK_SECRET = 'your-network-hmac-secret-here';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'VITE_NETWORK_SECRET')?.reason).toBe('weak-default');
    });
  });

  describe('short secrets rejected', () => {
    it('should reject JWT_SECRET shorter than 64 characters', () => {
      const env = createValidEnv();
      env.JWT_SECRET = 'short-but-not-a-default'; // < 64 chars

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'JWT_SECRET')?.reason).toBe('too-short');
    });

    it('should reject VITE_STORAGE_SECRET shorter than 32 characters', () => {
      const env = createValidEnv();
      env.VITE_STORAGE_SECRET = 'short-secret'; // < 32 chars

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'VITE_STORAGE_SECRET')?.reason).toBe('too-short');
    });
  });

  describe('missing secrets rejected', () => {
    it('should reject when JWT_SECRET is undefined', () => {
      const env = createValidEnv();
      delete (env as Record<string, string | undefined>).JWT_SECRET;

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'JWT_SECRET')?.reason).toBe('missing');
    });

    it('should reject when VITE_NETWORK_SECRET is empty', () => {
      const env = createValidEnv();
      env.VITE_NETWORK_SECRET = '';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(false);
      expect(failureFor(result, 'VITE_NETWORK_SECRET')?.reason).toBe('missing');
    });
  });

  describe('valid secrets accepted', () => {
    it('should accept all three secrets meeting requirements with no failures', () => {
      const env = createValidEnv();

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('should ignore unrelated environment variables', () => {
      const env = createValidEnv();
      // Adding/removing unrelated vars must not affect the secrets gate.
      delete (env as Record<string, string | undefined>).DATABASE_URL;
      env.CORS_ORIGIN = 'https://alsaqi.example.com';

      const result = validateProductionSecrets(env);

      expect(result.isValid).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });
});

describe('runSecretsValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('development mode allows weak secrets with warnings', () => {
    it('should NOT exit and should log warnings when not in production with weak secrets', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'development',
        JWT_SECRET: 'alsaqi-dev-secret-key-123',
        VITE_STORAGE_SECRET: 'your-32-character-secret-key-here',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
      };
      const exit = vi.fn();

      const result = runSecretsValidation(env, { exit: exit as unknown as (code: number) => never });

      // Should return the validation result (failures present but not blocking)
      expect(result.isValid).toBe(false);
      // Should log warnings, not errors, and must NOT terminate the process
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });

    it('should not log or exit when secrets are valid', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'development',
        JWT_SECRET: 'a'.repeat(64),
        VITE_STORAGE_SECRET: 'b'.repeat(32),
        VITE_NETWORK_SECRET: 'strong-network-secret',
      };
      const exit = vi.fn();

      const result = runSecretsValidation(env, { exit: exit as unknown as (code: number) => never });

      expect(result.isValid).toBe(true);
      expect(logger.error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('production mode logs errors and exits', () => {
    it('should log FATAL errors and exit(1) when in production with invalid secrets', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'production',
        JWT_SECRET: 'alsaqi-dev-secret-key-123',
        VITE_STORAGE_SECRET: 'your-32-character-secret-key-here',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
      };
      const exit = vi.fn();

      const result = runSecretsValidation(env, {
        isProduction: true,
        exit: exit as unknown as (code: number) => never,
      });

      expect(result.isValid).toBe(false);
      expect(logger.error).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('should never print actual secret values in log messages', () => {
      const env: Record<string, string> = {
        NODE_ENV: 'production',
        JWT_SECRET: 'super-secret-jwt-value-that-must-not-leak',
        VITE_STORAGE_SECRET: 'short-secret',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
      };
      const exit = vi.fn();

      runSecretsValidation(env, {
        isProduction: true,
        exit: exit as unknown as (code: number) => never,
      });

      const loggedMessages = (logger.error as ReturnType<typeof vi.fn>).mock.calls
        .flat()
        .filter((arg): arg is string => typeof arg === 'string');
      for (const value of Object.values(env)) {
        if (value === 'production') continue;
        expect(loggedMessages.some((m) => m.includes(value))).toBe(false);
      }
    });
  });
});

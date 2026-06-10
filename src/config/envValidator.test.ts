import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger at top level to prevent actual logging during tests
vi.mock('../utils/logger.js', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  validateEnvironment,
  validateEnvironmentOnStartup,
  isValidNumeric,
  isValidUrl,
  isValidBoolean,
  isValidPemKey,
  isValidLogLevel,
  validateType,
  getRequiredVariables,
  getOptionalVariables,
  ENV_VAR_DEFINITIONS,
} from './envValidator.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Creates a full valid production environment for testing.
 */
function createValidProductionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/alsaqi?sslmode=require',
    JWT_SECRET: 'a'.repeat(64),
    VITE_STORAGE_SECRET: 'b'.repeat(32),
    VITE_NETWORK_SECRET: 'strong-network-hmac-secret-value-here',
    CORS_ORIGIN: 'https://app.example.com',
    REDIS_URL: 'redis://redis.example.com:6379',
    UPLOAD_DIR: '/app/uploads',
    DATA_DIR: '/app/data',
  };
}

// ─── Type Validation Tests ───────────────────────────────────────────────────

describe('Type validators', () => {
  describe('isValidNumeric', () => {
    it('should accept valid integers', () => {
      expect(isValidNumeric('3000')).toBe(true);
      expect(isValidNumeric('0')).toBe(true);
      expect(isValidNumeric('-1')).toBe(true);
    });

    it('should accept valid floats', () => {
      expect(isValidNumeric('3.14')).toBe(true);
    });

    it('should reject non-numeric strings', () => {
      expect(isValidNumeric('abc')).toBe(false);
      expect(isValidNumeric('')).toBe(false);
      expect(isValidNumeric('3000abc')).toBe(false);
    });

    it('should reject Infinity and NaN', () => {
      expect(isValidNumeric('Infinity')).toBe(false);
      expect(isValidNumeric('NaN')).toBe(false);
    });
  });

  describe('isValidUrl', () => {
    it('should accept postgresql:// URLs', () => {
      expect(isValidUrl('postgresql://user:pass@localhost:5432/db')).toBe(true);
      expect(isValidUrl('postgres://user:pass@host/db')).toBe(true);
    });

    it('should accept redis:// URLs', () => {
      expect(isValidUrl('redis://localhost:6379')).toBe(true);
      expect(isValidUrl('rediss://user:pass@redis.example.com:6380')).toBe(true);
    });

    it('should accept http/https URLs', () => {
      expect(isValidUrl('https://api.example.com/webhook')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('ftp://server.com')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });

  describe('isValidBoolean', () => {
    it('should accept valid boolean strings', () => {
      expect(isValidBoolean('true')).toBe(true);
      expect(isValidBoolean('false')).toBe(true);
      expect(isValidBoolean('1')).toBe(true);
      expect(isValidBoolean('0')).toBe(true);
      expect(isValidBoolean('yes')).toBe(true);
      expect(isValidBoolean('no')).toBe(true);
    });

    it('should reject non-boolean strings', () => {
      expect(isValidBoolean('maybe')).toBe(false);
      expect(isValidBoolean('2')).toBe(false);
    });
  });

  describe('isValidPemKey', () => {
    it('should accept PEM-formatted keys', () => {
      expect(isValidPemKey('-----BEGIN RSA PRIVATE KEY-----\ndata\n-----END RSA PRIVATE KEY-----')).toBe(true);
      expect(isValidPemKey('-----BEGIN PUBLIC KEY-----\\ndata\\n-----END PUBLIC KEY-----')).toBe(true);
    });

    it('should reject non-PEM strings', () => {
      expect(isValidPemKey('not-a-pem-key')).toBe(false);
      expect(isValidPemKey('')).toBe(false);
    });
  });

  describe('isValidLogLevel', () => {
    it('should accept valid log levels', () => {
      expect(isValidLogLevel('error')).toBe(true);
      expect(isValidLogLevel('warn')).toBe(true);
      expect(isValidLogLevel('info')).toBe(true);
      expect(isValidLogLevel('debug')).toBe(true);
    });

    it('should reject invalid log levels', () => {
      expect(isValidLogLevel('trace')).toBe(false);
      expect(isValidLogLevel('verbose')).toBe(false);
    });
  });

  describe('validateType', () => {
    it('should validate string type as non-empty', () => {
      expect(validateType('hello', 'string')).toBe(true);
      expect(validateType('', 'string')).toBe(false);
    });

    it('should validate path type as non-empty', () => {
      expect(validateType('/app/data', 'path')).toBe(true);
      expect(validateType('  ', 'path')).toBe(false);
    });
  });
});

// ─── Environment Validation Tests ────────────────────────────────────────────

describe('validateEnvironment', () => {
  describe('production mode', () => {
    it('should pass with all required variables set correctly', () => {
      const env = createValidProductionEnv();
      const result = validateEnvironment(env, true);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should collect all missing required variables in a single result', () => {
      const env: Record<string, string> = { NODE_ENV: 'production' };
      const result = validateEnvironment(env, true);

      expect(result.isValid).toBe(false);
      // Should have errors for each required var: DATABASE_URL, JWT_SECRET, VITE_STORAGE_SECRET, VITE_NETWORK_SECRET, CORS_ORIGIN, REDIS_URL
      const requiredVars = getRequiredVariables();
      expect(result.errors.length).toBe(requiredVars.length);

      // All required variable names should appear in error messages
      for (const varName of requiredVars) {
        const hasError = result.errors.some(e => e.variable === varName);
        expect(hasError, `Expected error for missing ${varName}`).toBe(true);
      }
    });

    it('should report type error for non-numeric PORT', () => {
      const env = createValidProductionEnv();
      env.PORT = 'not-a-number';
      const result = validateEnvironment(env, true);

      // PORT is optional so it should be a warning, not an error
      const portWarning = result.warnings.find(w => w.variable === 'PORT');
      expect(portWarning).toBeDefined();
      expect(portWarning!.message).toContain('PORT');
      expect(portWarning!.message).toContain('numeric');
      expect(portWarning!.message).toContain('not-a-number');
    });

    it('should report type error for invalid DATABASE_URL format', () => {
      const env = createValidProductionEnv();
      env.DATABASE_URL = 'not-a-valid-url';
      const result = validateEnvironment(env, true);

      expect(result.isValid).toBe(false);
      const dbError = result.errors.find(e => e.variable === 'DATABASE_URL');
      expect(dbError).toBeDefined();
      expect(dbError!.message).toContain('DATABASE_URL');
      expect(dbError!.expectedType).toContain('URL');
    });

    it('should report type error for invalid REDIS_URL format', () => {
      const env = createValidProductionEnv();
      env.REDIS_URL = 'not-redis-url';
      const result = validateEnvironment(env, true);

      expect(result.isValid).toBe(false);
      const redisError = result.errors.find(e => e.variable === 'REDIS_URL');
      expect(redisError).toBeDefined();
      expect(redisError!.message).toContain('REDIS_URL');
    });

    it('should report minLength violation for JWT_SECRET', () => {
      const env = createValidProductionEnv();
      env.JWT_SECRET = 'short-secret'; // < 64 chars
      const result = validateEnvironment(env, true);

      expect(result.isValid).toBe(false);
      const jwtError = result.errors.find(e => e.variable === 'JWT_SECRET');
      expect(jwtError).toBeDefined();
      expect(jwtError!.message).toContain('at least 64 characters');
    });

    it('should report minLength violation for VITE_STORAGE_SECRET', () => {
      const env = createValidProductionEnv();
      env.VITE_STORAGE_SECRET = 'short'; // < 32 chars
      const result = validateEnvironment(env, true);

      expect(result.isValid).toBe(false);
      const storageError = result.errors.find(e => e.variable === 'VITE_STORAGE_SECRET');
      expect(storageError).toBeDefined();
      expect(storageError!.message).toContain('at least 32 characters');
    });

    it('should not expose full secret values in error messages', () => {
      const env = createValidProductionEnv();
      env.DATABASE_URL = 'invalid-url-with-password';
      const result = validateEnvironment(env, true);

      const dbError = result.errors.find(e => e.variable === 'DATABASE_URL');
      expect(dbError).toBeDefined();
      // Should show only first 4 chars + mask for sensitive vars
      expect(dbError!.receivedValue).toContain('****');
      expect(dbError!.receivedValue).not.toContain('password');
    });
  });

  describe('development mode', () => {
    it('should not produce errors for missing required variables', () => {
      const env: Record<string, string> = { NODE_ENV: 'development' };
      const result = validateEnvironment(env, false);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should produce warnings for missing required variables', () => {
      const env: Record<string, string> = { NODE_ENV: 'development' };
      const result = validateEnvironment(env, false);

      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });
});

// ─── Startup Validator Tests ─────────────────────────────────────────────────

describe('validateEnvironmentOnStartup', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('should call process.exit(1) in production when validation fails', async () => {
    const env: Record<string, string> = { NODE_ENV: 'production' };
    validateEnvironmentOnStartup(env);

    // Give the setImmediate a chance to fire
    await new Promise(resolve => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should not call process.exit in development mode', () => {
    const env: Record<string, string> = { NODE_ENV: 'development' };
    validateEnvironmentOnStartup(env);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should not call process.exit in production when all vars are valid', () => {
    const env = createValidProductionEnv();
    validateEnvironmentOnStartup(env);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should return validation result for programmatic use', () => {
    const env = createValidProductionEnv();
    const result = validateEnvironmentOnStartup(env);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── Utility Function Tests ──────────────────────────────────────────────────

describe('getRequiredVariables', () => {
  it('should return all required variable names', () => {
    const required = getRequiredVariables();
    expect(required).toContain('DATABASE_URL');
    expect(required).toContain('JWT_SECRET');
    expect(required).toContain('VITE_STORAGE_SECRET');
    expect(required).toContain('VITE_NETWORK_SECRET');
    expect(required).toContain('CORS_ORIGIN');
    expect(required).toContain('REDIS_URL');
  });

  it('should not include optional variables', () => {
    const required = getRequiredVariables();
    expect(required).not.toContain('PORT');
    expect(required).not.toContain('UPLOAD_DIR');
    expect(required).not.toContain('DATA_DIR');
  });
});

describe('getOptionalVariables', () => {
  it('should return optional variables with their defaults', () => {
    const optional = getOptionalVariables();
    const portDef = optional.find(v => v.name === 'PORT');
    expect(portDef).toBeDefined();
    expect(portDef!.defaultValue).toBe('3000');

    const dataDirDef = optional.find(v => v.name === 'DATA_DIR');
    expect(dataDirDef).toBeDefined();
    expect(dataDirDef!.defaultValue).toBe('./data');
  });
});

describe('ENV_VAR_DEFINITIONS', () => {
  it('should have unique variable names', () => {
    const names = ENV_VAR_DEFINITIONS.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should have all required fields for each definition', () => {
    for (const def of ENV_VAR_DEFINITIONS) {
      expect(def.name).toBeTruthy();
      expect(typeof def.required).toBe('boolean');
      expect(def.type).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.category).toBeTruthy();
    }
  });

  it('optional variables should have defaultValue or be nullable secrets', () => {
    const optionalWithoutDefaults = ENV_VAR_DEFINITIONS.filter(
      d => !d.required && !d.defaultValue
    );
    // These are all optional secrets/keys that don't need defaults
    // (they gracefully degrade when missing)
    for (const def of optionalWithoutDefaults) {
      expect(
        ['auth', 'encryption', 'integrations', 'database'].includes(def.category),
        `Optional var ${def.name} without default should be in auth/encryption/integrations/database category`
      ).toBe(true);
    }
  });
});

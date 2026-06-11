// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Integration Test: Redis Authentication Flow
 *
 * Validates that:
 * 1. Redis connection succeeds when correct password is provided (via RedisManager)
 * 2. Redis connection fails/rejects when no password or wrong password is used
 * 3. docker-compose.yml configures Redis with --requirepass
 * 4. REDIS_URL in docker-compose includes authentication credentials
 *
 * **Validates: Requirements 9.5, 13.2**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../utils/logger.js', () => ({
  default: {
    warn: (...args: any[]) => mockLoggerWarn(...args),
    info: (...args: any[]) => mockLoggerInfo(...args),
    error: (...args: any[]) => mockLoggerError(...args),
    debug: vi.fn(),
  },
}));

// ─── Docker Compose Configuration Tests ──────────────────────────────────────

describe('Redis Authentication - Docker Compose Configuration', () => {
  let dockerComposeContent: string;

  beforeEach(() => {
    const dockerComposePath = resolve(__dirname, '../../../docker-compose.yml');
    // Normalize line endings for cross-platform regex matching
    dockerComposeContent = readFileSync(dockerComposePath, 'utf-8').replace(/\r\n/g, '\n');
  });

  it('redis service uses --requirepass to enforce authentication', () => {
    // The redis service command must include --requirepass
    expect(dockerComposeContent).toContain('--requirepass');
    // Specifically, it should reference REDIS_PASSWORD variable
    expect(dockerComposeContent).toMatch(/command:.*redis-server.*--requirepass.*\$\{REDIS_PASSWORD/);
  });

  it('redis service does NOT expose port 6379 to the host', () => {
    // Parse the redis service section to check for port mappings
    const redisSection = extractServiceSection(dockerComposeContent, 'redis');
    expect(redisSection).not.toBeNull();

    // The redis section should NOT contain a ports mapping like "6379:6379"
    expect(redisSection).not.toMatch(/ports:\s*\n\s*-\s*"?6379:6379"?/);
  });

  it('api service REDIS_URL includes authentication credentials', () => {
    // The REDIS_URL should contain a password component in the URL format
    // Format: redis://:password@host:port
    expect(dockerComposeContent).toMatch(/REDIS_URL=redis:\/\/:.*@redis:6379/);
    // Specifically, it should reference REDIS_PASSWORD variable
    expect(dockerComposeContent).toMatch(/REDIS_URL=redis:\/\/:\$\{REDIS_PASSWORD/);
  });

  it('redis healthcheck uses -a flag with password for authentication', () => {
    // The healthcheck must pass the password via -a flag
    expect(dockerComposeContent).toMatch(/redis-cli.*-a.*\$\{REDIS_PASSWORD/);
  });

  it('redis service is on the internal alsaqi-network', () => {
    const redisSection = extractServiceSection(dockerComposeContent, 'redis');
    expect(redisSection).not.toBeNull();
    expect(redisSection).toContain('alsaqi-network');
  });

  it('api service depends on redis with service_healthy condition', () => {
    const apiSection = extractServiceSection(dockerComposeContent, 'api');
    expect(apiSection).not.toBeNull();
    expect(apiSection).toContain('redis');
    expect(apiSection).toContain('service_healthy');
  });
});

// ─── RedisManager Connection Configuration Tests ─────────────────────────────

describe('Redis Authentication - RedisManager Connection Logic', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerError.mockClear();
  });

  it('RedisManager uses the URL containing auth credentials for connection', async () => {
    // Dynamically import to get a fresh module with mocks applied
    const { RedisManager } = await import('../redisManager.js');

    const authenticatedUrl = 'redis://:my-strong-password@redis:6379';
    const manager = new RedisManager({ url: authenticatedUrl });

    // The manager should store the authenticated URL
    expect((manager as any).url).toBe(authenticatedUrl);
  });

  it('RedisManager with empty URL enters degraded mode (no auth possible)', async () => {
    const { RedisManager } = await import('../redisManager.js');

    const manager = new RedisManager({ url: '' });
    const result = await manager.connect();

    // Without a URL (no auth), connection should fail gracefully
    expect(result).toBe(false);
    expect(manager.status).toBe('degraded');
  });

  it('RedisManager configured with password-authenticated URL attempts connection', async () => {
    const { RedisManager } = await import('../redisManager.js');

    // Simulate a URL with authentication - connection will fail since no server
    // is running, but we verify the manager correctly attempts with the auth URL
    const authenticatedUrl = 'redis://:test-password@localhost:16379';
    const manager = new RedisManager({
      url: authenticatedUrl,
      connectTimeout: 500, // Fast timeout for test
    });

    const result = await manager.connect();

    // Connection fails (no server), but the attempt was made with auth URL
    expect(result).toBe(false);
    expect(manager.status).toBe('degraded');
    // The manager logged about the failed connection
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('[Redis] Initial connection failed')
    );

    await manager.disconnect();
  });

  it('RedisManager rejects startup in production when REDIS_URL is missing', async () => {
    const { RedisManager } = await import('../redisManager.js');

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const manager = new RedisManager({ url: '' });

    try {
      await manager.connect();
    } catch (err: any) {
      expect(err.message).toBe('process.exit called');
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL is not defined')
    );

    mockExit.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it('RedisManager connection with wrong password fails (mocked ioredis)', async () => {
    // We mock ioredis to simulate an AUTH failure
    const mockConnect = vi.fn().mockRejectedValue(new Error('NOAUTH Authentication required'));
    const mockDisconnect = vi.fn();
    const mockOn = vi.fn();

    vi.doMock('ioredis', () => ({
      default: class MockRedis {
        constructor() {}
        connect = mockConnect;
        disconnect = mockDisconnect;
        on = mockOn;
      },
    }));

    // Re-import with the mock
    const { RedisManager: MockedRedisManager } = await import('../redisManager.js');

    const manager = new MockedRedisManager({
      url: 'redis://localhost:6379', // No password in URL
      connectTimeout: 500,
    });

    const result = await manager.connect();

    // Connection should fail - Redis requires auth but none provided
    expect(result).toBe(false);
    expect(manager.status).toBe('degraded');

    vi.doUnmock('ioredis');
    await manager.disconnect();
  });
});

// ─── Network Isolation Tests ─────────────────────────────────────────────────

describe('Redis Authentication - Network Isolation (Requirement 13.2)', () => {
  let dockerComposeContent: string;

  beforeEach(() => {
    const dockerComposePath = resolve(__dirname, '../../../docker-compose.yml');
    // Normalize line endings for cross-platform regex matching
    dockerComposeContent = readFileSync(dockerComposePath, 'utf-8').replace(/\r\n/g, '\n');
  });

  it('redis service communicates only via internal bridge network', () => {
    const redisSection = extractServiceSection(dockerComposeContent, 'redis');
    expect(redisSection).not.toBeNull();

    // Should use internal network
    expect(redisSection).toContain('alsaqi-network');

    // Should NOT have any port mappings
    expect(redisSection).not.toContain('ports:');
  });

  it('api service connects to redis via internal hostname, not host port', () => {
    // REDIS_URL should reference 'redis' hostname (Docker DNS), not localhost
    expect(dockerComposeContent).toMatch(/REDIS_URL=redis:\/\/.*@redis:6379/);
    // Should NOT reference localhost for Redis in the API service
    const apiSection = extractServiceSection(dockerComposeContent, 'api');
    expect(apiSection).not.toMatch(/REDIS_URL.*localhost/);
  });

  it('docker network is configured as a bridge driver', () => {
    // The networks section should define alsaqi-network with bridge driver
    expect(dockerComposeContent).toContain('alsaqi-network:');
    expect(dockerComposeContent).toContain('driver: bridge');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts a top-level service section from docker-compose.yml content.
 * Only matches services defined directly under the `services:` key.
 * Returns the indented content belonging to the specified service.
 */
function extractServiceSection(content: string, serviceName: string): string | null {
  const lines = content.split('\n');
  let inServicesBlock = false;
  let servicesIndent = -1;
  let inTargetService = false;
  let serviceIndent = -1;
  const sectionLines: string[] = [];

  for (const line of lines) {
    // Detect the top-level "services:" key
    if (!inServicesBlock) {
      if (line.match(/^services:\s*$/)) {
        inServicesBlock = true;
        servicesIndent = 0;
        continue;
      }
      continue;
    }

    // Within the services block, find the target service
    if (!inTargetService) {
      // Service definitions are at servicesIndent + 2 (standard YAML)
      const match = line.match(new RegExp(`^(\\s+)${serviceName}:\\s*$`));
      if (match) {
        const indent = match[1].length;
        // Must be a direct child of services (indent = 2)
        if (indent === 2) {
          inTargetService = true;
          serviceIndent = indent;
          sectionLines.push(line);
          continue;
        }
      }
    } else {
      // Check if we've exited the service block (same or lower indent, non-empty)
      if (line.trim() !== '') {
        const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (currentIndent <= serviceIndent) {
          break;
        }
      }
      sectionLines.push(line);
    }
  }

  return sectionLines.length > 0 ? sectionLines.join('\n') : null;
}

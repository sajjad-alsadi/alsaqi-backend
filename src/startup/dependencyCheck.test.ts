import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mock references available in vi.mock factories
const { mockPool, mockRedis } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  },
  mockRedis: {
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  },
}));

// Mock pg module
vi.mock('pg', () => {
  function MockPool() {
    return mockPool;
  }
  MockPool.prototype = {};
  return {
    default: {
      Pool: MockPool,
    },
    Pool: MockPool,
  };
});

// Mock ioredis module
vi.mock('ioredis', () => {
  function MockRedis() {
    return mockRedis;
  }
  MockRedis.prototype = {};
  return {
    default: MockRedis,
  };
});

import pg from 'pg';
import Redis from 'ioredis';
import { waitForDependencies } from './dependencyCheck.js';

describe('dependencyCheck', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should succeed when both PostgreSQL and Redis are ready on first attempt', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockRedis.connect.mockResolvedValue(undefined);
    mockRedis.ping.mockResolvedValue('PONG');

    const result = await waitForDependencies({
      databaseUrl: 'postgresql://user:pass@localhost:5432/test',
      redisUrl: 'redis://localhost:6379',
      timeoutMs: 30_000,
      retryIntervalMs: 5_000,
    });

    expect(result.postgresReady).toBe(true);
    expect(result.redisReady).toBe(true);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should retry and succeed when dependencies become ready on second attempt', async () => {
    // First attempt: both fail
    mockPool.query
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockRedis.connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    mockRedis.ping.mockResolvedValue('PONG');

    const result = await waitForDependencies({
      databaseUrl: 'postgresql://user:pass@localhost:5432/test',
      redisUrl: 'redis://localhost:6379',
      timeoutMs: 30_000,
      retryIntervalMs: 100, // short interval for testing
    });

    expect(result.postgresReady).toBe(true);
    expect(result.redisReady).toBe(true);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should exit with code 1 when PostgreSQL is not ready within timeout', async () => {
    mockPool.query.mockRejectedValue(new Error('ECONNREFUSED'));
    mockRedis.connect.mockResolvedValue(undefined);
    mockRedis.ping.mockResolvedValue('PONG');

    await expect(
      waitForDependencies({
        databaseUrl: 'postgresql://user:pass@localhost:5432/test',
        redisUrl: 'redis://localhost:6379',
        timeoutMs: 250,
        retryIntervalMs: 100,
      })
    ).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PostgreSQL')
    );
  });

  it('should exit with code 1 when Redis is not ready within timeout', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockRedis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      waitForDependencies({
        databaseUrl: 'postgresql://user:pass@localhost:5432/test',
        redisUrl: 'redis://localhost:6379',
        timeoutMs: 250,
        retryIntervalMs: 100,
      })
    ).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis')
    );
  });

  it('should exit with code 1 when both services are not ready within timeout', async () => {
    mockPool.query.mockRejectedValue(new Error('ECONNREFUSED'));
    mockRedis.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      waitForDependencies({
        databaseUrl: 'postgresql://user:pass@localhost:5432/test',
        redisUrl: 'redis://localhost:6379',
        timeoutMs: 250,
        retryIntervalMs: 100,
      })
    ).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const errorMessage = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0];
    expect(errorMessage).toContain('PostgreSQL');
    expect(errorMessage).toContain('Redis');
  });

  it('should use default timeout of 30s and retry interval of 5s', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockRedis.connect.mockResolvedValue(undefined);
    mockRedis.ping.mockResolvedValue('PONG');

    const result = await waitForDependencies({
      databaseUrl: 'postgresql://user:pass@localhost:5432/test',
      redisUrl: 'redis://localhost:6379',
      // Not passing timeoutMs or retryIntervalMs to test defaults
    });

    expect(result.postgresReady).toBe(true);
    expect(result.redisReady).toBe(true);
  });

  it('should not re-check a dependency once it becomes ready', async () => {
    // PostgreSQL ready immediately, Redis fails first then succeeds
    mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockRedis.connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);
    mockRedis.ping.mockResolvedValue('PONG');

    const result = await waitForDependencies({
      databaseUrl: 'postgresql://user:pass@localhost:5432/test',
      redisUrl: 'redis://localhost:6379',
      timeoutMs: 30_000,
      retryIntervalMs: 100,
    });

    expect(result.postgresReady).toBe(true);
    expect(result.redisReady).toBe(true);
    // PostgreSQL pool should only be called once since it was ready on first attempt
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

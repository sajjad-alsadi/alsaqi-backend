// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mock references
const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
  },
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock axios
vi.mock('axios', () => {
  const mockAxios: any = {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: vi.fn((err: any) => err?.isAxiosError === true),
  };
  return { default: mockAxios };
});

import { CircuitBreaker, CircuitState, getN8nCircuitBreaker, resetN8nCircuitBreaker } from '../CircuitBreaker';
import axios from 'axios';

describe('CircuitBreaker', () => {
  let mockRun: ReturnType<typeof vi.fn>;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 });
    mockPrepare.mockReturnValue({ run: mockRun });

    breaker = new CircuitBreaker('http://test-service.local/webhook', {}, {
      maxRetries: 3,
      initialBackoffMs: 1000,
      failureThreshold: 5,
      failureWindowMs: 60000,
      healthProbeIntervalMs: 30000,
      healthProbeTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    breaker.destroy();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.state).toBe(CircuitState.CLOSED);
    });

    it('should have 0 consecutive failures', () => {
      expect(breaker.consecutiveFailures).toBe(0);
    });
  });

  describe('successful calls', () => {
    it('should return true on successful call', async () => {
      (axios.post as any).mockResolvedValueOnce({ status: 200, data: {} });

      const result = await breaker.call('test_event', { key: 'value' });

      expect(result).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'http://test-service.local/webhook',
        expect.objectContaining({
          event: 'test_event',
          data: { key: 'value' },
        }),
        expect.objectContaining({
          timeout: 5000,
        })
      );
    });

    it('should reset consecutive failures on success', async () => {
      // Fail once first (all 3 retries fail = 1 consecutive failure)
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);
      const failPromise = breaker.call('event1', {});
      // Advance through backoff: 1s + 2s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await failPromise;

      expect(breaker.consecutiveFailures).toBe(1);

      // Now succeed
      (axios.post as any).mockResolvedValueOnce({ status: 200, data: {} });
      const result = await breaker.call('event2', {});

      expect(result).toBe(true);
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it('should skip silently when service URL is not configured', async () => {
      const noUrlBreaker = new CircuitBreaker(null);
      const result = await noUrlBreaker.call('test_event', {});

      expect(result).toBe(true);
      expect(axios.post).not.toHaveBeenCalled();
      noUrlBreaker.destroy();
    });
  });

  describe('retry with exponential backoff', () => {
    it('should retry up to maxRetries times on failure', async () => {
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      const callPromise = breaker.call('test_event', { data: 'test' });

      // Advance through backoff delays: 1s after first failure, 2s after second
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      
      await callPromise;

      expect(axios.post).toHaveBeenCalledTimes(3);
    });

    it('should succeed on retry if later attempt succeeds', async () => {
      const networkError = new Error('Timeout');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNABORTED';
      (axios.isAxiosError as any).mockReturnValue(true);

      // First attempt fails, second succeeds
      (axios.post as any)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ status: 200, data: {} });

      const callPromise = breaker.call('test_event', {});
      await vi.advanceTimersByTimeAsync(1000); // backoff after first failure
      const result = await callPromise;

      expect(result).toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('should store in dead letter queue after all retries fail', async () => {
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      const callPromise = breaker.call('test_event', { important: 'data' });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await callPromise;

      expect(result).toBe(false);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO dead_letter_queue')
      );
      expect(mockRun).toHaveBeenCalledWith(
        'test_event',
        JSON.stringify({ important: 'data' }),
        expect.stringContaining('Connection refused'),
        0
      );
    });

    it('should use exponential backoff starting at 1s', async () => {
      const networkError = new Error('Timeout');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNABORTED';

      (axios.post as any).mockRejectedValue(networkError);

      const callPromise = breaker.call('test_event', {});

      // First attempt happens immediately
      expect(axios.post).toHaveBeenCalledTimes(1);

      // After 1s backoff, second attempt
      await vi.advanceTimersByTimeAsync(1000);
      expect(axios.post).toHaveBeenCalledTimes(2);

      // After 2s backoff, third attempt
      await vi.advanceTimersByTimeAsync(2000);
      expect(axios.post).toHaveBeenCalledTimes(3);

      await callPromise;
    });
  });

  describe('circuit breaker state transitions', () => {
    it('should open after 5 consecutive failures within 60s window', async () => {
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      // Each call exhausts 3 retries, counting as 1 consecutive failure
      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000); // advance past all backoffs
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);
    });

    it('should store events in dead letter queue while circuit is open', async () => {
      // Force circuit open
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000);
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);

      // Clear mocks to track new calls
      vi.clearAllMocks();
      mockPrepare.mockReturnValue({ run: mockRun });

      // Now try to send an event while circuit is open
      const result = await breaker.call('new_event', { data: 'test' });

      expect(result).toBe(false);
      expect(axios.post).not.toHaveBeenCalled(); // Should NOT attempt the call
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO dead_letter_queue')
      );
      expect(mockRun).toHaveBeenCalledWith(
        'new_event',
        JSON.stringify({ data: 'test' }),
        'Circuit breaker is open',
        0
      );
    });

    it('should close circuit after successful health probe', async () => {
      // Force circuit open
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000);
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);

      // Simulate successful health probe
      (axios.get as any).mockResolvedValueOnce({ status: 200, data: {} });
      const probeResult = await breaker.performHealthProbe();

      expect(probeResult).toBe(true);
      expect(breaker.state).toBe(CircuitState.CLOSED);
    });

    it('should remain open after failed health probe', async () => {
      // Force circuit open
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000);
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);

      // Simulate failed health probe
      (axios.get as any).mockRejectedValueOnce(new Error('Still down'));
      const probeResult = await breaker.performHealthProbe();

      expect(probeResult).toBe(false);
      expect(breaker.state).toBe(CircuitState.OPEN);
    });

    it('should perform health probes every 30s while open', async () => {
      // Force circuit open
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.isAxiosError as any).mockReturnValue(true);

      (axios.post as any).mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000);
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);

      // Mock health probe to keep failing
      (axios.get as any).mockRejectedValue(new Error('Still down'));

      // Advance 30s - should trigger first health probe
      await vi.advanceTimersByTimeAsync(30000);
      expect(axios.get).toHaveBeenCalledTimes(1);

      // Advance another 30s - should trigger second health probe
      await vi.advanceTimersByTimeAsync(30000);
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('dead letter queue storage', () => {
    it('should store event with correct fields', async () => {
      await breaker.storeInDeadLetterQueue('webhook_event', { userId: '123' }, 'Connection timeout');

      expect(mockPrepare).toHaveBeenCalledWith(
        'INSERT INTO dead_letter_queue (event_type, payload, failure_reason, retry_count) VALUES (?, ?, ?, ?)'
      );
      expect(mockRun).toHaveBeenCalledWith(
        'webhook_event',
        JSON.stringify({ userId: '123' }),
        'Connection timeout',
        0
      );
    });

    it('should handle string payloads without double-serializing', async () => {
      await breaker.storeInDeadLetterQueue('event', 'already a string', 'error');

      expect(mockRun).toHaveBeenCalledWith(
        'event',
        'already a string',
        'error',
        0
      );
    });

    it('should not throw if database insert fails', async () => {
      mockRun.mockRejectedValueOnce(new Error('DB connection lost'));

      // Should not throw
      await expect(
        breaker.storeInDeadLetterQueue('event', {}, 'reason')
      ).resolves.toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      // Force some failures
      const networkError = new Error('Connection refused');
      (networkError as any).isAxiosError = true;
      (networkError as any).code = 'ECONNREFUSED';
      (axios.post as any).mockRejectedValue(networkError);

      for (let i = 0; i < 5; i++) {
        const callPromise = breaker.call(`event_${i}`, {});
        await vi.advanceTimersByTimeAsync(5000);
        await callPromise;
      }

      expect(breaker.state).toBe(CircuitState.OPEN);

      breaker.reset();

      expect(breaker.state).toBe(CircuitState.CLOSED);
      expect(breaker.consecutiveFailures).toBe(0);
    });
  });

  describe('getN8nCircuitBreaker singleton', () => {
    afterEach(() => {
      resetN8nCircuitBreaker();
    });

    it('should return the same instance on multiple calls', () => {
      const instance1 = getN8nCircuitBreaker();
      const instance2 = getN8nCircuitBreaker();
      expect(instance1).toBe(instance2);
    });

    it('should create a new instance after reset', () => {
      const instance1 = getN8nCircuitBreaker();
      resetN8nCircuitBreaker();
      const instance2 = getN8nCircuitBreaker();
      expect(instance1).not.toBe(instance2);
    });
  });
});

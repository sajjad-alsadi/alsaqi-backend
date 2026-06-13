// @vitest-environment node
// Feature: backend-security-hardening, Property 29: Failed-job retention parsing
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 29: Failed-job retention parsing
 *
 * **Validates: Requirements 21.1, 21.3**
 *
 * For any failed-job retention configuration value, `parseFailedJobRetention` accepts it
 * only when it is an integer in FAILED_RETENTION_MIN..FAILED_RETENTION_MAX, substitutes the
 * documented default when unset/whitespace, and otherwise returns a failure with a reason.
 */

// ─── Mock BullMQ + logger so importing queueManager has no side effects ──────
// queueManager instantiates a singleton QueueManager at module load; mocking the
// transport avoids needing a live Redis connection for this pure-logic test.
vi.mock('bullmq', () => {
  class Mock {
    add = vi.fn();
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    getJob = vi.fn().mockResolvedValue(null);
    constructor() {}
  }
  return { Queue: Mock, Worker: Mock, QueueEvents: Mock };
});

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  parseFailedJobRetention,
  FAILED_RETENTION_MIN,
  FAILED_RETENTION_MAX,
  FAILED_RETENTION_DEFAULT,
} from '../queueManager.js';

const NUM_RUNS = 200;

describe('Property 29: Failed-job retention parsing', () => {
  it('parses valid in-range integer strings to that limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: FAILED_RETENTION_MIN, max: FAILED_RETENTION_MAX }),
        (n) => {
          const result = parseFailedJobRetention(String(n));
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.limit).toBe(n);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('substitutes the default for unset or whitespace-only values', () => {
    const whitespace = fc
      .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'))
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), whitespace), (raw) => {
        const result = parseFailedJobRetention(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.limit).toBe(FAILED_RETENTION_DEFAULT);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects out-of-range integer strings with a reason', () => {
    const outOfRange = fc.oneof(
      fc.integer({ min: FAILED_RETENTION_MAX + 1, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: FAILED_RETENTION_MIN - 1 }),
    );
    fc.assert(
      fc.property(outOfRange, (n) => {
        const result = parseFailedJobRetention(String(n));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.reason).toBe('string');
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects non-numeric values with a reason', () => {
    // Strings that never represent a base-10 integer (contain a non-digit/sign char).
    const nonNumeric = fc
      .string()
      .filter((s) => !/^\s*[+-]?\d+\s*$/.test(s) && s.trim() !== '');
    fc.assert(
      fc.property(nonNumeric, (raw) => {
        const result = parseFailedJobRetention(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.reason).toBe('string');
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// @vitest-environment node
// Feature: backend-security-hardening, Property 30: PDF timeout parsing and clamping
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Property 30: PDF timeout parsing and clamping
 *
 * **Validates: Requirements 22.1, 22.2**
 *
 * parsePdfTimeout returns the parsed integer when it sits within
 * [PDF_TIMEOUT_MIN_S, PDF_TIMEOUT_MAX_S] = [5, 300]. For absent, non-numeric,
 * non-integer, or out-of-range input it falls back to PDF_TIMEOUT_DEFAULT_S = 30
 * (default-on-out-of-range, NOT clamp). The result is always within [5, 300].
 */

// ─── Mock BullMQ so importing the worker module never touches Redis ──────────
vi.mock('bullmq', () => {
  class MockQueue {
    add = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    getJob = vi.fn().mockResolvedValue(null);
    constructor() {}
  }
  class MockWorker {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  }
  class MockQueueEvents {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  }
  return { Queue: MockQueue, Worker: MockWorker, QueueEvents: MockQueueEvents };
});

import {
  parsePdfTimeout,
  PDF_TIMEOUT_MIN_S,
  PDF_TIMEOUT_MAX_S,
  PDF_TIMEOUT_DEFAULT_S,
} from '../pdfWorker.js';

describe('Property 30: PDF timeout parsing and clamping', () => {
  it('parses in-range integer strings to that exact value (Req 22.1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PDF_TIMEOUT_MIN_S, max: PDF_TIMEOUT_MAX_S }),
        (n) => {
          // Numeric input
          expect(parsePdfTimeout(n)).toBe(n);
          // Decimal string input
          expect(parsePdfTimeout(String(n))).toBe(n);
          // Surrounding whitespace is tolerated
          expect(parsePdfTimeout(`  ${n}  `)).toBe(n);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('falls back to the default for out-of-range input (Req 22.2)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100000, max: PDF_TIMEOUT_MIN_S - 1 }),
          fc.integer({ min: PDF_TIMEOUT_MAX_S + 1, max: 100000 })
        ),
        (n) => {
          expect(parsePdfTimeout(n)).toBe(PDF_TIMEOUT_DEFAULT_S);
          expect(parsePdfTimeout(String(n))).toBe(PDF_TIMEOUT_DEFAULT_S);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('falls back to the default for non-integer numeric input (Req 22.2)', () => {
    fc.assert(
      fc.property(
        fc
          .double({ min: -1000, max: 1000, noNaN: true })
          .filter((d) => !Number.isInteger(d)),
        (d) => {
          expect(parsePdfTimeout(d)).toBe(PDF_TIMEOUT_DEFAULT_S);
          // Decimal string forms (e.g. "12.5") are rejected by the strict regex
          expect(parsePdfTimeout(String(d))).toBe(PDF_TIMEOUT_DEFAULT_S);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('falls back to the default for non-numeric / garbage strings (Req 22.2)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[+-]?\d+$/.test(s.trim()) || s.trim().length === 0),
        (s) => {
          expect(parsePdfTimeout(s)).toBe(PDF_TIMEOUT_DEFAULT_S);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('falls back to the default for absent input (Req 22.2)', () => {
    expect(parsePdfTimeout(undefined)).toBe(PDF_TIMEOUT_DEFAULT_S);
    expect(parsePdfTimeout(null)).toBe(PDF_TIMEOUT_DEFAULT_S);
  });

  it('always returns a value within [5, 300] for any input (Req 22.1, 22.2)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1000000, max: 1000000 }),
          fc.double({ noNaN: true }),
          fc.string(),
          fc.constant(undefined),
          fc.constant(null)
        ),
        (raw) => {
          const result = parsePdfTimeout(raw as string | number | undefined | null);
          expect(Number.isInteger(result)).toBe(true);
          expect(result).toBeGreaterThanOrEqual(PDF_TIMEOUT_MIN_S);
          expect(result).toBeLessThanOrEqual(PDF_TIMEOUT_MAX_S);
        }
      ),
      { numRuns: 300 }
    );
  });
});

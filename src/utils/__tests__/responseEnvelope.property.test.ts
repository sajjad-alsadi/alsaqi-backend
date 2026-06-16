// @vitest-environment node
// Feature: api-quality-improvements, Property 1: Success envelope structure invariant
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createSuccessResponse } from '../responseEnvelope.js';

/**
 * Property 1: Success envelope structure invariant
 *
 * **Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 1.7**
 *
 * Strategy:
 * - Generate arbitrary JSON-serializable objects using fc.jsonValue()
 * - Call createSuccessResponse({ data }) with each generated value
 * - Assert success === true, data equals input, meta.requestId is UUID,
 *   meta.timestamp is ISO 8601, meta.version matches semver pattern
 */

// ─── Regex Patterns ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 1: Success envelope structure invariant', () => {
  it('for ANY JSON-serializable data, createSuccessResponse produces a valid envelope with success === true', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (data) => {
        const result = createSuccessResponse({ data });

        // success must be true
        expect(result.success).toBe(true);

        // data must equal the input payload
        expect(result.data).toEqual(data);

        // meta.requestId must be a valid UUID
        expect(result.meta.requestId).toMatch(UUID_REGEX);

        // meta.timestamp must be valid ISO 8601
        const timestamp = result.meta.timestamp;
        expect(new Date(timestamp).toISOString()).toBe(timestamp);

        // meta.version must match semver pattern
        expect(result.meta.version).toMatch(SEMVER_REGEX);
      }),
      { numRuns: 100 },
    );
  });

  it('for ANY JSON-serializable data, each call generates a unique requestId', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (data1, data2) => {
        const result1 = createSuccessResponse({ data: data1 });
        const result2 = createSuccessResponse({ data: data2 });

        // Each invocation should produce a distinct requestId
        expect(result1.meta.requestId).not.toBe(result2.meta.requestId);
      }),
      { numRuns: 100 },
    );
  });

  it('for ANY JSON-serializable data, the envelope contains exactly the expected top-level keys', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (data) => {
        const result = createSuccessResponse({ data });

        // Top-level keys: success, data, meta
        expect(Object.keys(result).sort()).toEqual(['data', 'meta', 'success']);

        // Meta keys must include requestId, timestamp, version (pagination is optional)
        const metaKeys = Object.keys(result.meta);
        expect(metaKeys).toContain('requestId');
        expect(metaKeys).toContain('timestamp');
        expect(metaKeys).toContain('version');
      }),
      { numRuns: 100 },
    );
  });
});

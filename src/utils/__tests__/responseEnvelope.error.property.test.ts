// Feature: api-quality-improvements, Property 3: Error envelope structure invariant
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createErrorResponse } from '../responseEnvelope';

/**
 * Property 3: Error envelope structure invariant
 *
 * **Validates: Requirements 1.8**
 *
 * For any error options containing a code string and message string,
 * calling `createErrorResponse` SHALL produce an object where:
 * - `success === false`
 * - `data === null`
 * - `error.code` matches the input code
 * - `error.message` matches the input message
 * - `error.traceId` is a valid UUID
 * - `meta.requestId` is a valid UUID
 * - `meta.timestamp` is ISO 8601
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

describe('Property 3: Error envelope structure invariant', () => {
  it('createErrorResponse always produces a valid error envelope for arbitrary code/message pairs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (code, message) => {
          const response = createErrorResponse({ code, message });

          // success is always false
          expect(response.success).toBe(false);

          // data is always null
          expect(response.data).toBeNull();

          // error.code matches input
          expect(response.error.code).toBe(code);

          // error.message matches input
          expect(response.error.message).toBe(message);

          // error.traceId is a valid UUID
          expect(response.error.traceId).toMatch(UUID_REGEX);

          // meta.requestId is a valid UUID
          expect(response.meta.requestId).toMatch(UUID_REGEX);

          // meta.timestamp is ISO 8601
          expect(response.meta.timestamp).toMatch(ISO_8601_REGEX);
          // Also verify it parses to a valid date
          expect(new Date(response.meta.timestamp).toISOString()).toBe(response.meta.timestamp);
        }
      ),
      { numRuns: 100 }
    );
  });
});

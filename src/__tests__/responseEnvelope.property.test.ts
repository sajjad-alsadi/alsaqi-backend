// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SuccessResponseSchema,
  ErrorResponseSchema,
  PaginationMetaSchema,
} from '@alsaqi/shared';
import { z } from 'zod';
import {
  createSuccessResponse,
  createErrorResponse,
  computePagination,
} from '../utils/responseEnvelope';

/**
 * Property Test: Response Envelope Conformance (Property 4)
 *
 * Feature: api-isolation
 * Property 4: تطابق غلاف الاستجابة (Response Envelope Conformance)
 *
 * **Validates: Requirements 3.1, 3.2, 3.3**
 *
 * For any arbitrary valid data, createSuccessResponse should produce output
 * that validates against SuccessResponseSchema.
 * For any arbitrary error inputs, createErrorResponse should produce output
 * that validates against ErrorResponseSchema.
 * For any valid pagination inputs, computePagination should produce valid PaginationMeta.
 */

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates arbitrary JSON-serializable data as the success payload */
const arbitraryData = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string(), { maxLength: 5 }),
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z_]/.test(s)),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { maxKeys: 5 }
  )
);

/** Generates a valid error code string */
const errorCodeArb = fc.constantFrom(
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'RATE_LIMIT_EXCEEDED',
  'CONFLICT',
  'BAD_REQUEST'
);

/** Generates a human-readable error message */
const errorMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0);

/** Generates optional error details (field-level validation errors) */
const errorDetailArb = fc.record({
  path: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
  message: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
  code: fc.constantFrom('too_small', 'too_big', 'invalid_enum_value', 'invalid_type', 'custom'),
});

const errorDetailsArb = fc.option(
  fc.array(errorDetailArb, { minLength: 1, maxLength: 5 }),
  { nil: undefined }
);

/** Generates valid pagination input */
const paginationInputArb = fc.record({
  page: fc.integer({ min: 1, max: 1000 }),
  pageSize: fc.integer({ min: 1, max: 100 }),
  total: fc.integer({ min: 0, max: 100000 }),
});

/** Generates edge-case pagination input (raw/unclamped values) */
const rawPaginationInputArb = fc.record({
  page: fc.integer({ min: -10, max: 1000 }),
  pageSize: fc.integer({ min: -10, max: 200 }),
  total: fc.integer({ min: -100, max: 100000 }),
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 4: Response Envelope Conformance', () => {
  describe('Success Response Conformance', () => {
    it('createSuccessResponse always produces a valid SuccessResponse (without pagination)', () => {
      fc.assert(
        fc.property(arbitraryData, (data) => {
          const response = createSuccessResponse({ data });

          // Validate against SuccessResponseSchema with z.any() as data schema
          const schema = SuccessResponseSchema(z.any());
          const result = schema.safeParse(response);

          expect(result.success).toBe(true);

          // Also verify structural properties
          expect(response.success).toBe(true);
          expect(response.data).toEqual(data);
          expect(response.meta.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          );
          expect(response.meta.version).toMatch(/^\d+\.\d+\.\d+$/);
          // timestamp is a valid ISO datetime
          expect(new Date(response.meta.timestamp).toISOString()).toBe(response.meta.timestamp);
        }),
        { numRuns: 100 }
      );
    });

    it('createSuccessResponse with pagination produces valid SuccessResponse with PaginationMeta', () => {
      fc.assert(
        fc.property(arbitraryData, paginationInputArb, (data, paginationInput) => {
          const pagination = computePagination(paginationInput);
          const response = createSuccessResponse({ data, pagination });

          // Validate against SuccessResponseSchema
          const schema = SuccessResponseSchema(z.any());
          const result = schema.safeParse(response);

          expect(result.success).toBe(true);

          // Verify pagination is included in meta
          expect(response.meta.pagination).toBeDefined();

          // Validate pagination against PaginationMetaSchema
          const paginationResult = PaginationMetaSchema.safeParse(response.meta.pagination);
          expect(paginationResult.success).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('createSuccessResponse uses provided requestId when given', () => {
      fc.assert(
        fc.property(arbitraryData, fc.uuid(), (data, requestId) => {
          const response = createSuccessResponse({ data, requestId });

          expect(response.meta.requestId).toBe(requestId);
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Error Response Conformance', () => {
    it('createErrorResponse always produces a valid ErrorResponse', () => {
      fc.assert(
        fc.property(errorCodeArb, errorMessageArb, errorDetailsArb, (code, message, details) => {
          const response = createErrorResponse({ code, message, details });

          // Validate against ErrorResponseSchema
          const result = ErrorResponseSchema.safeParse(response);

          expect(result.success).toBe(true);

          // Verify structural properties
          expect(response.success).toBe(false);
          expect(response.data).toBeNull();
          expect(response.error.code).toBe(code);
          expect(response.error.message).toBe(message);
          expect(response.error.traceId).toBeTruthy();
          expect(response.meta.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          );
          expect(response.meta.version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(new Date(response.meta.timestamp).toISOString()).toBe(response.meta.timestamp);
        }),
        { numRuns: 100 }
      );
    });

    it('createErrorResponse uses provided requestId and traceId when given', () => {
      fc.assert(
        fc.property(
          errorCodeArb,
          errorMessageArb,
          fc.uuid(),
          fc.uuid(),
          (code, message, requestId, traceId) => {
            const response = createErrorResponse({ code, message, requestId, traceId });

            expect(response.meta.requestId).toBe(requestId);
            expect(response.error.traceId).toBe(traceId);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('createErrorResponse includes details array when provided', () => {
      fc.assert(
        fc.property(
          errorCodeArb,
          errorMessageArb,
          fc.array(errorDetailArb, { minLength: 1, maxLength: 5 }),
          (code, message, details) => {
            const response = createErrorResponse({ code, message, details });

            expect(response.error.details).toBeDefined();
            expect(response.error.details).toHaveLength(details.length);

            // Each detail should match its input
            for (let i = 0; i < details.length; i++) {
              expect(response.error.details![i].path).toBe(details[i].path);
              expect(response.error.details![i].message).toBe(details[i].message);
              expect(response.error.details![i].code).toBe(details[i].code);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('createErrorResponse omits details when not provided', () => {
      fc.assert(
        fc.property(errorCodeArb, errorMessageArb, (code, message) => {
          const response = createErrorResponse({ code, message });

          // details should not be present
          expect(response.error.details).toBeUndefined();

          // Should still validate against schema
          const result = ErrorResponseSchema.safeParse(response);
          expect(result.success).toBe(true);
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Pagination Computation Conformance', () => {
    it('computePagination always produces valid PaginationMeta', () => {
      fc.assert(
        fc.property(paginationInputArb, (input) => {
          const pagination = computePagination(input);

          const result = PaginationMetaSchema.safeParse(pagination);
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('computePagination clamps raw inputs to valid PaginationMeta', () => {
      fc.assert(
        fc.property(rawPaginationInputArb, (input) => {
          const pagination = computePagination(input);

          // Should always produce valid result regardless of input
          const result = PaginationMetaSchema.safeParse(pagination);
          expect(result.success).toBe(true);

          // page is always >= 1
          expect(pagination.page).toBeGreaterThanOrEqual(1);
          // pageSize is always between 1 and 100
          expect(pagination.pageSize).toBeGreaterThanOrEqual(1);
          expect(pagination.pageSize).toBeLessThanOrEqual(100);
          // total is always >= 0
          expect(pagination.total).toBeGreaterThanOrEqual(0);
          // totalPages is always >= 0
          expect(pagination.totalPages).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 }
      );
    });

    it('computePagination hasNext/hasPrev are consistent with page and totalPages', () => {
      fc.assert(
        fc.property(paginationInputArb, (input) => {
          const pagination = computePagination(input);

          // hasNext: true only when current page is less than totalPages
          expect(pagination.hasNext).toBe(pagination.page < pagination.totalPages);
          // hasPrev: true only when current page is greater than 1
          expect(pagination.hasPrev).toBe(pagination.page > 1);
        }),
        { numRuns: 100 }
      );
    });

    it('computePagination totalPages is consistent with total and pageSize', () => {
      fc.assert(
        fc.property(paginationInputArb, (input) => {
          const pagination = computePagination(input);

          const expectedTotalPages = Math.ceil(pagination.total / pagination.pageSize);
          expect(pagination.totalPages).toBe(expectedTotalPages);
        }),
        { numRuns: 100 }
      );
    });
  });
});

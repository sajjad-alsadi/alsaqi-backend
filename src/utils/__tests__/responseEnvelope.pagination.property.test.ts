// Feature: api-quality-improvements, Property 2: Pagination computation correctness
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computePagination } from '../responseEnvelope';

/**
 * Property 2: Pagination computation correctness
 *
 * **Validates: Requirements 1.2**
 *
 * For any valid pagination input (page ≥ 1, pageSize ∈ [1, 100], total ≥ 0),
 * `computePagination` SHALL produce a PaginationMeta where:
 * - totalPages = ceil(total / pageSize)
 * - hasNext = (page < totalPages)
 * - hasPrev = (page > 1)
 */
describe('Property 2: Pagination computation correctness', () => {
  const pageArb = fc.integer({ min: 1, max: 1000 });
  const pageSizeArb = fc.integer({ min: 1, max: 100 });
  const totalArb = fc.integer({ min: 0, max: 100000 });

  it('totalPages === Math.ceil(total / pageSize) for all valid inputs', () => {
    fc.assert(
      fc.property(pageArb, pageSizeArb, totalArb, (page, pageSize, total) => {
        const result = computePagination({ page, pageSize, total });

        const expectedTotalPages = Math.ceil(total / pageSize);
        expect(result.totalPages).toBe(expectedTotalPages);
      }),
      { numRuns: 100 }
    );
  });

  it('hasNext === (page < totalPages) for all valid inputs', () => {
    fc.assert(
      fc.property(pageArb, pageSizeArb, totalArb, (page, pageSize, total) => {
        const result = computePagination({ page, pageSize, total });

        const expectedTotalPages = Math.ceil(total / pageSize);
        expect(result.hasNext).toBe(page < expectedTotalPages);
      }),
      { numRuns: 100 }
    );
  });

  it('hasPrev === (page > 1) for all valid inputs', () => {
    fc.assert(
      fc.property(pageArb, pageSizeArb, totalArb, (page, pageSize, total) => {
        const result = computePagination({ page, pageSize, total });

        expect(result.hasPrev).toBe(page > 1);
      }),
      { numRuns: 100 }
    );
  });

  it('all pagination relationships hold simultaneously for all valid inputs', () => {
    fc.assert(
      fc.property(pageArb, pageSizeArb, totalArb, (page, pageSize, total) => {
        const result = computePagination({ page, pageSize, total });

        // totalPages correctness
        expect(result.totalPages).toBe(Math.ceil(total / pageSize));
        // hasNext correctness
        expect(result.hasNext).toBe(page < result.totalPages);
        // hasPrev correctness
        expect(result.hasPrev).toBe(page > 1);
        // page and pageSize pass through unchanged for valid inputs
        expect(result.page).toBe(page);
        expect(result.pageSize).toBe(pageSize);
        expect(result.total).toBe(total);
      }),
      { numRuns: 100 }
    );
  });
});

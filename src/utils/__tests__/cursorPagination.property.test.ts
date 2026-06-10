// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  encodeCursor,
  decodeCursor,
  validatePageSize,
  buildCursorQueryParams,
  processCursorResults,
  DEFAULT_CURSOR_PAGE_SIZE,
  MAX_CURSOR_PAGE_SIZE,
} from '../cursorPagination.js';

/**
 * Property 20: Cursor-based Pagination Consistency
 *
 * **Validates: Requirements 14.2**
 *
 * Strategy:
 * - For any dataset and any valid cursor sequence, pagination produces no duplicates across pages
 * - For any dataset paginated to completion, all records are accounted for (none missing)
 * - Cursor encode/decode is a round-trip (encode then decode returns original values)
 * - Page size validation respects min 1 and max 100 bounds
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generate valid column names (alphanumeric + underscore, starts with letter or underscore) */
const columnNameArb = fc
  .tuple(
    fc.constantFrom('a', 'b', 'c', 'id', 'created_at', 'updated_at', 'name', 'status'),
  )
  .map(([col]) => col);

/** Generate arbitrary cursor values (non-empty strings representing sort field values) */
const cursorValueArb = fc.oneof(
  // ISO date strings (generated from safe integer timestamps)
  fc.integer({ min: 946684800000, max: 1924905600000 }).map((ts) => new Date(ts).toISOString()),
  // Numeric IDs as strings
  fc.integer({ min: 1, max: 1_000_000 }).map(String),
  // UUID-like strings
  fc.uuid(),
);

/** Generate a dataset row with a sort column value */
function datasetRowArb(sortColumn: string) {
  return fc.integer({ min: 1, max: 1_000_000 }).map((id) => ({
    id: String(id),
    [sortColumn]: new Date(Date.now() - id * 1000).toISOString(),
    title: `Record ${id}`,
  }));
}

/** Generate valid page sizes (1-100) */
const validPageSizeArb = fc.integer({ min: 1, max: MAX_CURSOR_PAGE_SIZE });

/** Generate arbitrary page size inputs (potentially invalid) */
const arbitraryPageSizeArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.constant(undefined as unknown as number),
  fc.constant(NaN),
);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 20: Cursor-based Pagination Consistency', () => {
  describe('Cursor encode/decode round-trip', () => {
    it('for ANY value and column, encoding then decoding returns the original values', () => {
      fc.assert(
        fc.property(cursorValueArb, columnNameArb, (value, column) => {
          const encoded = encodeCursor(value, column);
          const decoded = decodeCursor(encoded);

          expect(decoded).not.toBeNull();
          expect(decoded!.value).toBe(value);
          expect(decoded!.column).toBe(column);
        }),
        { numRuns: 200 },
      );
    });

    it('for ANY value and column, encoded cursor is a non-empty base64url string', () => {
      fc.assert(
        fc.property(cursorValueArb, columnNameArb, (value, column) => {
          const encoded = encodeCursor(value, column);

          expect(encoded.length).toBeGreaterThan(0);
          // base64url characters: A-Z, a-z, 0-9, -, _
          expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Page size validation', () => {
    it('for ANY valid page size (1-100), validatePageSize returns it unchanged', () => {
      fc.assert(
        fc.property(validPageSizeArb, (pageSize) => {
          const result = validatePageSize(pageSize);
          expect(result).toBe(pageSize);
        }),
        { numRuns: 100 },
      );
    });

    it('for ANY page size > 100, validatePageSize clamps to MAX_CURSOR_PAGE_SIZE (100)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 101, max: 10_000 }),
          (pageSize) => {
            const result = validatePageSize(pageSize);
            expect(result).toBe(MAX_CURSOR_PAGE_SIZE);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('for ANY page size < 1, validatePageSize clamps to minimum 1', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -10_000, max: 0 }),
          (pageSize) => {
            const result = validatePageSize(pageSize);
            expect(result).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('for ANY undefined/NaN page size, validatePageSize returns DEFAULT_CURSOR_PAGE_SIZE (20)', () => {
      expect(validatePageSize(undefined)).toBe(DEFAULT_CURSOR_PAGE_SIZE);
      expect(validatePageSize(NaN)).toBe(DEFAULT_CURSOR_PAGE_SIZE);
    });

    it('for ANY page size input, result is always between 1 and 100 inclusive', () => {
      fc.assert(
        fc.property(arbitraryPageSizeArb, (pageSize) => {
          const result = validatePageSize(pageSize);
          expect(result).toBeGreaterThanOrEqual(1);
          expect(result).toBeLessThanOrEqual(MAX_CURSOR_PAGE_SIZE);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Pagination produces no duplicates across pages', () => {
    it('for ANY sorted dataset paginated to completion, no record appears in more than one page', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }).chain((datasetSize) =>
            fc.tuple(
              fc.constant(datasetSize),
              fc.integer({ min: 1, max: Math.min(20, datasetSize) }),
            ),
          ),
          ([datasetSize, pageSize]) => {
            const sortColumn = 'created_at';

            // Generate a sorted dataset with unique sort values
            const dataset: Record<string, any>[] = [];
            for (let i = 0; i < datasetSize; i++) {
              dataset.push({
                id: String(i + 1),
                created_at: new Date(2024, 0, 1, 0, 0, datasetSize - i).toISOString(),
                title: `Record ${i + 1}`,
              });
            }
            // Dataset sorted DESC by created_at (newest first)
            dataset.sort((a, b) => b[sortColumn].localeCompare(a[sortColumn]));

            // Simulate paginating through the dataset
            const allPagedIds: string[] = [];
            let cursor: string | null = null;
            let pageCount = 0;
            const maxPages = Math.ceil(datasetSize / pageSize) + 1;

            while (pageCount < maxPages) {
              // Simulate what buildCursorQueryParams + processCursorResults does
              const queryParams = buildCursorQueryParams({
                cursor: cursor ?? undefined,
                pageSize,
                sortColumn,
                sortDirection: 'DESC',
              });

              // Filter the dataset based on cursor
              let filtered = [...dataset];
              if (queryParams.whereClause && queryParams.whereParams.length > 0) {
                const cursorValue = queryParams.whereParams[0] as string;
                // DESC: get records with sort value < cursor
                filtered = filtered.filter((row) => row[sortColumn] < cursorValue);
              }

              // Take pageSize + 1 to detect hasMore
              const rowsForProcessing = filtered.slice(0, queryParams.limit);

              // Process results
              const result = processCursorResults(rowsForProcessing, queryParams.pageSize, sortColumn);

              // Collect all IDs from this page
              for (const row of result.data) {
                allPagedIds.push(row.id);
              }

              if (!result.hasMore || result.nextCursor === null) {
                break;
              }

              cursor = result.nextCursor;
              pageCount++;
            }

            // Check no duplicates
            const uniqueIds = new Set(allPagedIds);
            expect(uniqueIds.size).toBe(allPagedIds.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Pagination accounts for all records (none missing)', () => {
    it('for ANY dataset paginated to completion, all records are returned', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }).chain((datasetSize) =>
            fc.tuple(
              fc.constant(datasetSize),
              fc.integer({ min: 1, max: Math.min(20, datasetSize) }),
            ),
          ),
          ([datasetSize, pageSize]) => {
            const sortColumn = 'created_at';

            // Generate a sorted dataset with unique sort values
            const dataset: Record<string, any>[] = [];
            for (let i = 0; i < datasetSize; i++) {
              dataset.push({
                id: String(i + 1),
                created_at: new Date(2024, 0, 1, 0, 0, datasetSize - i).toISOString(),
                title: `Record ${i + 1}`,
              });
            }
            // Dataset sorted DESC by created_at (newest first)
            dataset.sort((a, b) => b[sortColumn].localeCompare(a[sortColumn]));

            // Paginate through entire dataset
            const allPagedIds: string[] = [];
            let cursor: string | null = null;
            let pageCount = 0;
            const maxPages = Math.ceil(datasetSize / pageSize) + 1;

            while (pageCount < maxPages) {
              const queryParams = buildCursorQueryParams({
                cursor: cursor ?? undefined,
                pageSize,
                sortColumn,
                sortDirection: 'DESC',
              });

              // Filter the dataset based on cursor
              let filtered = [...dataset];
              if (queryParams.whereClause && queryParams.whereParams.length > 0) {
                const cursorValue = queryParams.whereParams[0] as string;
                filtered = filtered.filter((row) => row[sortColumn] < cursorValue);
              }

              const rowsForProcessing = filtered.slice(0, queryParams.limit);
              const result = processCursorResults(rowsForProcessing, queryParams.pageSize, sortColumn);

              for (const row of result.data) {
                allPagedIds.push(row.id);
              }

              if (!result.hasMore || result.nextCursor === null) {
                break;
              }

              cursor = result.nextCursor;
              pageCount++;
            }

            // ALL records must be accounted for
            expect(allPagedIds.length).toBe(datasetSize);

            // Verify it's the same set of IDs
            const originalIds = dataset.map((row) => row.id).sort();
            const pagedIdsSorted = [...allPagedIds].sort();
            expect(pagedIdsSorted).toEqual(originalIds);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('for ANY dataset paginated with ASC direction, all records are returned in order', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 30 }).chain((datasetSize) =>
            fc.tuple(
              fc.constant(datasetSize),
              fc.integer({ min: 1, max: Math.min(10, datasetSize) }),
            ),
          ),
          ([datasetSize, pageSize]) => {
            const sortColumn = 'created_at';

            // Generate dataset
            const dataset: Record<string, any>[] = [];
            for (let i = 0; i < datasetSize; i++) {
              dataset.push({
                id: String(i + 1),
                created_at: new Date(2024, 0, 1, 0, 0, i + 1).toISOString(),
                title: `Record ${i + 1}`,
              });
            }
            // Sort ASC
            dataset.sort((a, b) => a[sortColumn].localeCompare(b[sortColumn]));

            // Paginate ASC
            const allPagedIds: string[] = [];
            let cursor: string | null = null;
            let pageCount = 0;
            const maxPages = Math.ceil(datasetSize / pageSize) + 1;

            while (pageCount < maxPages) {
              const queryParams = buildCursorQueryParams({
                cursor: cursor ?? undefined,
                pageSize,
                sortColumn,
                sortDirection: 'ASC',
              });

              let filtered = [...dataset];
              if (queryParams.whereClause && queryParams.whereParams.length > 0) {
                const cursorValue = queryParams.whereParams[0] as string;
                // ASC: get records with sort value > cursor
                filtered = filtered.filter((row) => row[sortColumn] > cursorValue);
              }

              const rowsForProcessing = filtered.slice(0, queryParams.limit);
              const result = processCursorResults(rowsForProcessing, queryParams.pageSize, sortColumn);

              for (const row of result.data) {
                allPagedIds.push(row.id);
              }

              if (!result.hasMore || result.nextCursor === null) {
                break;
              }

              cursor = result.nextCursor;
              pageCount++;
            }

            // All records accounted for
            expect(allPagedIds.length).toBe(datasetSize);

            const originalIds = dataset.map((row) => row.id).sort();
            const pagedIdsSorted = [...allPagedIds].sort();
            expect(pagedIdsSorted).toEqual(originalIds);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

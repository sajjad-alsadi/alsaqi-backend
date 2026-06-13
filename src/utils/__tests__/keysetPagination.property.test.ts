// @vitest-environment node
// Feature: backend-security-hardening, Property 9: Keyset pagination round-trip
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  encodeKeysetCursor,
  decodeKeysetCursor,
  clampKeysetPageSize,
  buildKeysetClause,
  processKeysetResults,
  DEFAULT_KEYSET_PAGE_SIZE,
  MIN_KEYSET_PAGE_SIZE,
  MAX_KEYSET_PAGE_SIZE,
} from '../cursorPagination.js';

/**
 * Property 9: Keyset pagination round-trip
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 *
 * For any dataset of rows with a deterministic composite order key and any page
 * size, paging from the first cursor to exhaustion yields every row exactly once
 * in the defined order with no duplicates or gaps, clamps page size to 1..100
 * (default 25), and returns a non-null `nextCursor` if and only if more rows
 * remain after the current page.
 *
 * This validates four facets of the keyset-pagination contract:
 *   1. encodeKeysetCursor -> decodeKeysetCursor returns the original order-key values (Req 6.1)
 *   2. page-size clamping holds (1..100, default 25) (Req 6.2)
 *   3. nextCursor is present iff more rows remain (Req 6.3, 6.4)
 *   4. full paging yields every row exactly once, in order, with no gaps (Req 6.1, 6.3, 6.4)
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid order-key column names (must be SQL-identifier safe for buildKeysetClause). */
const columnNameArb = fc.constantFrom(
  'id',
  'created_at',
  'updated_at',
  'name',
  'seq',
  'code',
  'rank',
);

/** A composite order key: 1..3 distinct columns. */
const orderKeyArb = fc.uniqueArray(columnNameArb, { minLength: 1, maxLength: 3 });

/** A scenario: an order key plus a row carrying a (string) value for each order-key column. */
const cursorRoundTripArb = orderKeyArb.chain((orderKey) =>
  fc.record(
    Object.fromEntries(orderKey.map((col) => [col, fc.string()])),
  ).map((row) => ({ orderKey, row })),
);

/** Arbitrary page-size inputs, including invalid/out-of-range values. */
const arbitraryPageSizeArb = fc.oneof(
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double({ min: -1000, max: 1000, noNaN: false }),
  fc.constant(undefined as unknown as number),
  fc.constant(null as unknown as number),
  fc.constant(NaN),
);

// ─── Composite-key helpers (mirror SQL row-value comparison semantics) ─────────

/** Lexicographic tuple comparison over stringified order-key values. */
function cmpTuple(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function keyValues(row: Record<string, unknown>, orderKey: readonly string[]): string[] {
  return orderKey.map((col) => String(row[col]));
}

// ─── Property Tests ────────────────────────────────────────────────────────────

describe('Property 9: Keyset pagination round-trip', () => {
  describe('Cursor encode/decode round-trip (Req 6.1)', () => {
    it('for ANY row and composite order key, encode then decode returns the original order-key values', () => {
      fc.assert(
        fc.property(cursorRoundTripArb, ({ orderKey, row }) => {
          const cursor = encodeKeysetCursor(orderKey, row);
          const decoded = decodeKeysetCursor(cursor, orderKey);

          expect(decoded).toHaveLength(orderKey.length);
          orderKey.forEach((col, i) => {
            expect(decoded[i]).toBe(String(row[col]));
          });
        }),
        { numRuns: 200 },
      );
    });

    it('for ANY row and order key, the encoded cursor is a non-empty base64url string', () => {
      fc.assert(
        fc.property(cursorRoundTripArb, ({ orderKey, row }) => {
          const cursor = encodeKeysetCursor(orderKey, row);
          expect(cursor.length).toBeGreaterThan(0);
          expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Page-size clamping holds 1..100 with default 25 (Req 6.2)', () => {
    it('for ANY page-size input, the result is always within 1..100 inclusive', () => {
      fc.assert(
        fc.property(arbitraryPageSizeArb, (pageSize) => {
          const result = clampKeysetPageSize(pageSize);
          expect(result).toBeGreaterThanOrEqual(MIN_KEYSET_PAGE_SIZE);
          expect(result).toBeLessThanOrEqual(MAX_KEYSET_PAGE_SIZE);
        }),
        { numRuns: 200 },
      );
    });

    it('for ANY in-range page size (1..100), clampKeysetPageSize returns it unchanged', () => {
      fc.assert(
        fc.property(fc.integer({ min: MIN_KEYSET_PAGE_SIZE, max: MAX_KEYSET_PAGE_SIZE }), (pageSize) => {
          expect(clampKeysetPageSize(pageSize)).toBe(pageSize);
        }),
        { numRuns: 100 },
      );
    });

    it('for ANY page size > 100, clampKeysetPageSize clamps to 100; for any < 1, clamps to 1', () => {
      fc.assert(
        fc.property(fc.integer({ min: 101, max: 1_000_000 }), (pageSize) => {
          expect(clampKeysetPageSize(pageSize)).toBe(MAX_KEYSET_PAGE_SIZE);
        }),
        { numRuns: 100 },
      );
      fc.assert(
        fc.property(fc.integer({ min: -1_000_000, max: 0 }), (pageSize) => {
          expect(clampKeysetPageSize(pageSize)).toBe(MIN_KEYSET_PAGE_SIZE);
        }),
        { numRuns: 100 },
      );
    });

    it('for absent/NaN page size, clampKeysetPageSize returns the documented default of 25', () => {
      expect(clampKeysetPageSize(undefined)).toBe(DEFAULT_KEYSET_PAGE_SIZE);
      expect(clampKeysetPageSize(null)).toBe(DEFAULT_KEYSET_PAGE_SIZE);
      expect(clampKeysetPageSize(NaN)).toBe(DEFAULT_KEYSET_PAGE_SIZE);
      expect(DEFAULT_KEYSET_PAGE_SIZE).toBe(25);
    });
  });

  describe('nextCursor present iff more rows remain (Req 6.3, 6.4)', () => {
    it('for ANY fetched row count and page size, nextCursor is non-null exactly when extra rows were fetched', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_KEYSET_PAGE_SIZE, max: 40 }),
          fc.integer({ min: 0, max: 80 }),
          (pageSize, fetched) => {
            // Build `fetched` rows with a unique composite key (created_at, id).
            const rows = Array.from({ length: fetched }, (_, i) => ({
              created_at: new Date(2024, 0, 1, 0, 0, fetched - i).toISOString(),
              id: String(i).padStart(6, '0'),
            }));
            const orderKey = ['created_at', 'id'] as const;

            const page = processKeysetResults(rows, pageSize, orderKey);

            const moreRowsRemain = fetched > pageSize;
            if (moreRowsRemain) {
              expect(page.nextCursor).not.toBeNull();
              // The page is exactly pageSize rows; the extra sentinel row is dropped.
              expect(page.data).toHaveLength(pageSize);
            } else {
              expect(page.nextCursor).toBeNull();
              expect(page.data).toHaveLength(fetched);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('Full paging yields every row exactly once, in order, with no gaps (Req 6.1, 6.3, 6.4)', () => {
    it('for ANY dataset paged DESC from the first cursor to exhaustion, every row appears exactly once in order', () => {
      fc.assert(
        fc.property(
          // Distinct created_at "buckets" force composite ties resolved by the unique id column.
          fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 45 }),
          fc.integer({ min: MIN_KEYSET_PAGE_SIZE, max: MAX_KEYSET_PAGE_SIZE }),
          (buckets, requestedPageSize) => {
            const orderKey = ['created_at', 'id'] as const;
            const pageSize = clampKeysetPageSize(requestedPageSize);

            // Build a dataset whose composite (created_at, id) key is unique: id is unique.
            const dataset = buckets.map((bucket, i) => ({
              created_at: `2024-01-01T00:00:0${bucket}.000Z`,
              id: String(i).padStart(6, '0'),
            }));

            // Authoritative DESC order by the composite key.
            const sortedDesc = [...dataset].sort((a, b) =>
              cmpTuple(keyValues(b, orderKey), keyValues(a, orderKey)),
            );
            const expectedIds = sortedDesc.map((r) => r.id);

            // Page through using buildKeysetClause to derive the cursor filter.
            const collectedIds: string[] = [];
            let cursor: string | null = null;
            const maxPages = dataset.length + 2;

            for (let pageNo = 0; pageNo < maxPages; pageNo++) {
              const { whereClause, whereParams } = buildKeysetClause(orderKey, cursor, 'DESC');

              // Emulate the SQL `(cols) < (?)` filter then ORDER BY ... DESC LIMIT pageSize+1.
              let remaining = sortedDesc;
              if (whereClause) {
                remaining = sortedDesc.filter(
                  (row) => cmpTuple(keyValues(row, orderKey), whereParams) < 0,
                );
              }
              const fetched = remaining.slice(0, pageSize + 1);
              const page = processKeysetResults(fetched, pageSize, orderKey);

              for (const row of page.data) collectedIds.push(row.id);

              if (page.nextCursor === null) break;
              cursor = page.nextCursor;
            }

            // No duplicates, no gaps: exactly the dataset, in the defined DESC order.
            expect(collectedIds).toEqual(expectedIds);
            expect(new Set(collectedIds).size).toBe(collectedIds.length);
          },
        ),
        { numRuns: 150 },
      );
    });

    it('for ANY dataset paged ASC from the first cursor to exhaustion, every row appears exactly once in order', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 45 }),
          fc.integer({ min: MIN_KEYSET_PAGE_SIZE, max: MAX_KEYSET_PAGE_SIZE }),
          (buckets, requestedPageSize) => {
            const orderKey = ['created_at', 'id'] as const;
            const pageSize = clampKeysetPageSize(requestedPageSize);

            const dataset = buckets.map((bucket, i) => ({
              created_at: `2024-01-01T00:00:0${bucket}.000Z`,
              id: String(i).padStart(6, '0'),
            }));

            const sortedAsc = [...dataset].sort((a, b) =>
              cmpTuple(keyValues(a, orderKey), keyValues(b, orderKey)),
            );
            const expectedIds = sortedAsc.map((r) => r.id);

            const collectedIds: string[] = [];
            let cursor: string | null = null;
            const maxPages = dataset.length + 2;

            for (let pageNo = 0; pageNo < maxPages; pageNo++) {
              const { whereClause, whereParams } = buildKeysetClause(orderKey, cursor, 'ASC');

              let remaining = sortedAsc;
              if (whereClause) {
                remaining = sortedAsc.filter(
                  (row) => cmpTuple(keyValues(row, orderKey), whereParams) > 0,
                );
              }
              const fetched = remaining.slice(0, pageSize + 1);
              const page = processKeysetResults(fetched, pageSize, orderKey);

              for (const row of page.data) collectedIds.push(row.id);

              if (page.nextCursor === null) break;
              cursor = page.nextCursor;
            }

            expect(collectedIds).toEqual(expectedIds);
            expect(new Set(collectedIds).size).toBe(collectedIds.length);
          },
        ),
        { numRuns: 150 },
      );
    });
  });
});

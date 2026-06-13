// @vitest-environment node
// Feature: backend-security-hardening, Property 10: Malformed cursor rejection
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  decodeKeysetCursor,
  buildKeysetClause,
  keysetPaginate,
  KEYSET_TABLES,
} from '../cursorPagination.js';
import { ValidationError } from '../errors.js';

/**
 * Property 10: Malformed cursor rejection
 *
 * **Validates: Requirements 6.6**
 *
 * For any malformed/undecodable cursor — non-base64url garbage, valid base64url
 * that is not JSON, JSON that is not an object (numbers, strings, booleans,
 * null, arrays), an object whose key count does not match the order key (wrong
 * arity), an object whose keys do not match the order-key columns, or an object
 * whose order-key values are not strings — `decodeKeysetCursor` and
 * `buildKeysetClause` throw a `ValidationError` whose message is exactly
 * 'Invalid pagination cursor', and the high-level `keysetPaginate` rejects the
 * request before executing any query, so no page rows are produced.
 */

const INVALID_CURSOR_MESSAGE = 'Invalid pagination cursor';

// ─── Generators ──────────────────────────────────────────────────────────────

/** SQL-identifier-safe column names usable as order-key columns. */
const columnNameArb = fc.constantFrom(
  'id',
  'created_at',
  'updated_at',
  'name',
  'status',
  'priority',
);

/** A composite order key of 1..3 distinct columns. */
const orderKeyArb = fc.uniqueArray(columnNameArb, { minLength: 1, maxLength: 3 });

/** base64url-encode a UTF-8 string (the opaque cursor envelope). */
const toCursor = (raw: string): string => Buffer.from(raw, 'utf-8').toString('base64url');

/**
 * Category 1 — valid base64url of JSON that is NOT an object:
 * numbers, strings, booleans, null, and arrays all fail the object check.
 */
const nonObjectCursorArb = fc
  .oneof(
    fc.integer().map((v) => JSON.stringify(v)),
    fc.double({ noNaN: true }).map((v) => JSON.stringify(v)),
    fc.boolean().map((v) => JSON.stringify(v)),
    fc.constant('null'),
    fc.string().map((v) => JSON.stringify(v)), // JSON string literal e.g. "\"abc\""
    fc.array(fc.string()).map((v) => JSON.stringify(v)),
  )
  .map(toCursor);

/**
 * Category 2 — valid base64url that does NOT decode to JSON at all.
 * Wrapping a brace-prefixed fragment guarantees JSON.parse rejects.
 */
const nonJsonCursorArb = fc
  .string({ minLength: 1 })
  .map((s) => toCursor(`{not json:${s}`));

/** Build a JSON object cursor with the given key/value entries. */
function objectCursor(entries: Array<[string, unknown]>): string {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of entries) obj[k] = v;
  return toCursor(JSON.stringify(obj));
}

/**
 * Category 3 — wrong arity: an object whose key count differs from the order
 * key length (all string values, so only the arity is wrong).
 */
function wrongArityCursorArb(orderKey: readonly string[]) {
  return fc
    .integer({ min: 0, max: 5 })
    .filter((n) => n !== orderKey.length)
    .map((n) => {
      const entries: Array<[string, unknown]> = [];
      for (let i = 0; i < n; i++) entries.push([`col_${i}`, `v${i}`]);
      return objectCursor(entries);
    });
}

/**
 * Category 4 — correct key count but wrong key names: arity passes but the
 * order-key columns are absent, so each lookup is undefined (not a string).
 */
function wrongKeyNamesCursorArb(orderKey: readonly string[]) {
  return fc.constant(
    objectCursor(orderKey.map((col, i) => [`${col}__renamed_${i}`, `v${i}`])),
  );
}

/**
 * Category 5 — correct keys but non-string values for the order-key columns.
 */
function nonStringValuesCursorArb(orderKey: readonly string[]) {
  const nonStringArb = fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.double({ noNaN: true }),
  );
  return fc
    .array(nonStringArb, { minLength: orderKey.length, maxLength: orderKey.length })
    .map((values) => objectCursor(orderKey.map((col, i) => [col, values[i]])));
}

/** All deterministically-malformed cursor categories for a given order key. */
function malformedCursorArb(orderKey: readonly string[]) {
  return fc.oneof(
    nonObjectCursorArb,
    nonJsonCursorArb,
    wrongArityCursorArb(orderKey),
    wrongKeyNamesCursorArb(orderKey),
    nonStringValuesCursorArb(orderKey),
  );
}

/** Pair an order key with a malformed cursor built against it. */
const orderKeyWithMalformedCursorArb = orderKeyArb.chain((orderKey) =>
  fc.record({
    orderKey: fc.constant(orderKey),
    cursor: malformedCursorArb(orderKey),
  }),
);

// ─── Mock DB ─────────────────────────────────────────────────────────────────

/**
 * Minimal IDBWrapper mock that records whether any query was prepared/executed,
 * so we can assert that a malformed cursor produces no page rows (the query is
 * never run).
 */
function makeMockDb() {
  const state = { prepareCalls: 0 };
  const db = {
    validateIdentifier: (table: string) => table,
    prepare: (_sql: string) => {
      state.prepareCalls++;
      return { all: async () => [] as unknown[] };
    },
  };
  return { db: db as unknown as Parameters<typeof keysetPaginate>[0], state };
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 10: Malformed cursor rejection', () => {
  it('decodeKeysetCursor throws ValidationError("Invalid pagination cursor") for ANY malformed cursor', () => {
    fc.assert(
      fc.property(orderKeyWithMalformedCursorArb, ({ orderKey, cursor }) => {
        let thrown: unknown;
        try {
          decodeKeysetCursor(cursor, orderKey);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ValidationError);
        expect((thrown as Error).message).toBe(INVALID_CURSOR_MESSAGE);
      }),
      { numRuns: 300 },
    );
  });

  it('buildKeysetClause throws ValidationError("Invalid pagination cursor") for ANY malformed cursor', () => {
    fc.assert(
      fc.property(
        orderKeyWithMalformedCursorArb,
        fc.constantFrom<'ASC' | 'DESC'>('ASC', 'DESC'),
        ({ orderKey, cursor }, direction) => {
          let thrown: unknown;
          try {
            buildKeysetClause(orderKey, cursor, direction);
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(ValidationError);
          expect((thrown as Error).message).toBe(INVALID_CURSOR_MESSAGE);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keysetPaginate rejects a malformed cursor and produces NO page rows (query never executed)', async () => {
    // Fixed keyset-configured table; its order key drives the malformed cursors.
    const tableName = 'audit_findings';
    const orderKey = KEYSET_TABLES[tableName].orderKey;

    await fc.assert(
      fc.asyncProperty(malformedCursorArb(orderKey), async (cursor) => {
        const { db, state } = makeMockDb();

        let thrown: unknown;
        try {
          await keysetPaginate(db, tableName, { cursor });
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(ValidationError);
        expect((thrown as Error).message).toBe(INVALID_CURSOR_MESSAGE);
        // No page rows: the query is never prepared or executed.
        expect(state.prepareCalls).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it('decodeKeysetCursor is total: for ANY string it either returns the right-arity values or throws the invalid-cursor error', () => {
    // Covers arbitrary non-base64url garbage without preconditions: the only
    // permitted outcomes are a valid decode (correct length) or the canonical
    // ValidationError. It never throws anything else and never returns junk.
    const fixedOrderKey = ['created_at', 'id'] as const;
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let result: string[] | undefined;
        let thrown: unknown;
        try {
          result = decodeKeysetCursor(raw, fixedOrderKey);
        } catch (e) {
          thrown = e;
        }

        if (thrown !== undefined) {
          expect(thrown).toBeInstanceOf(ValidationError);
          expect((thrown as Error).message).toBe(INVALID_CURSOR_MESSAGE);
        } else {
          expect(result).toHaveLength(fixedOrderKey.length);
          for (const v of result as string[]) {
            expect(typeof v).toBe('string');
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

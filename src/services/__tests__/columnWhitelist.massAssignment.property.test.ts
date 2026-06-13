// @vitest-environment node
// Feature: backend-security-hardening, Property 7: Mass-assignment rejection
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  checkWhitelist,
  getColumnWhitelist,
  TABLE_WRITE_SCHEMAS,
} from '../columnWhitelist';

/**
 * Property 7: Mass-assignment rejection
 *
 * **Validates: Requirements 4.1, 4.3, 4.4**
 *
 * For any request body and target table, if the body contains one or more
 * top-level keys absent from the table's column whitelist (including restricted
 * fields such as `status`, `deleted_at`, ownership fields, and `role`), then
 * `checkWhitelist` reports rejection listing exactly those keys and no
 * whitelist-filtered write would include any non-whitelisted key; when all keys
 * are whitelisted it reports acceptance.
 */

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** All table names registered in the write-schema registry. */
const TABLE_NAMES = Object.keys(TABLE_WRITE_SCHEMAS);

/** Pick any registered target table. */
const tableArb: fc.Arbitrary<string> = fc.constantFrom(...TABLE_NAMES);

/**
 * Restricted privilege/ownership/system fields that must never be mass-assigned
 * unless a table explicitly declares them. These are the concrete fields the
 * spec calls out (Req 4.4).
 */
const RESTRICTED_FIELDS = [
  'role',
  'deleted_at',
  'deleted_by',
  'created_by',
  'created_at',
  'updated_at',
  'approved_by',
  'approved_at',
  'id',
  'is_admin',
  'permissions',
] as const;

/** An arbitrary JSON-ish value used as a key's payload; the value is irrelevant. */
const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** A name that is NOT in the given whitelist (forged / attacker-controlled key). */
function nonWhitelistedNameArb(whitelist: Set<string>): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.constantFrom(...RESTRICTED_FIELDS),
      fc.string({ minLength: 1, maxLength: 12 }),
    )
    .filter((name) => name.length > 0 && !whitelist.has(name));
}

/** Build a record from a list of keys, assigning each an arbitrary value. */
function bodyFromKeys(keys: string[]): fc.Arbitrary<Record<string, unknown>> {
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return fc.constant({});
  return fc
    .tuple(...unique.map(() => valueArb))
    .map((values) =>
      unique.reduce<Record<string, unknown>>((acc, key, i) => {
        // Use defineProperty so that special keys such as `__proto__` become
        // genuine own-enumerable properties on the body. A plain `acc[key] =`
        // assignment would, for `__proto__`, mutate the object's prototype
        // instead of adding an own key, so the forged key would be absent from
        // the body and `checkWhitelist` would (correctly) never see it.
        Object.defineProperty(acc, key, {
          value: values[i],
          enumerable: true,
          configurable: true,
          writable: true,
        });
        return acc;
      }, {}),
    );
}

describe('Feature: backend-security-hardening, Property 7: Mass-assignment rejection', () => {
  it('rejects any body containing at least one non-whitelisted key, listing exactly those keys', () => {
    fc.assert(
      fc.property(
        tableArb.chain((table) => {
          const whitelist = getColumnWhitelist(table);
          const allowedKeys = Array.from(whitelist);
          // At least one forged key guarantees the body must be rejected.
          return fc
            .tuple(
              // A subset of legitimately whitelisted keys (possibly empty).
              fc.subarray(allowedKeys),
              // One or more non-whitelisted keys.
              fc.uniqueArray(nonWhitelistedNameArb(whitelist), {
                minLength: 1,
                maxLength: 4,
              }),
            )
            .chain(([goodKeys, badKeys]) =>
              bodyFromKeys([...goodKeys, ...badKeys]).map((body) => ({
                table,
                body,
                badKeys,
              })),
            );
        }),
        ({ table, body, badKeys }) => {
          const result = checkWhitelist(table, body);
          expect(result.ok).toBe(false);
          // rejectedKeys is exactly the set of non-whitelisted keys present.
          expect(new Set(result.rejectedKeys)).toEqual(new Set(badKeys));
          // No rejected key is in the whitelist (none would be persisted).
          const whitelist = getColumnWhitelist(table);
          for (const key of result.rejectedKeys) {
            expect(whitelist.has(key)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('accepts a body whose keys are all drawn from the table whitelist', () => {
    fc.assert(
      fc.property(
        tableArb.chain((table) => {
          const allowedKeys = Array.from(getColumnWhitelist(table));
          return fc
            .subarray(allowedKeys)
            .chain((keys) => bodyFromKeys(keys).map((body) => ({ table, body })));
        }),
        ({ table, body }) => {
          const result = checkWhitelist(table, body);
          expect(result.ok).toBe(true);
          expect(result.rejectedKeys).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never reports a whitelisted key as rejected, even in a mixed body', () => {
    fc.assert(
      fc.property(
        tableArb.chain((table) => {
          const whitelist = getColumnWhitelist(table);
          const allowedKeys = Array.from(whitelist);
          return fc
            .tuple(
              fc.subarray(allowedKeys),
              fc.uniqueArray(nonWhitelistedNameArb(whitelist), {
                minLength: 0,
                maxLength: 4,
              }),
            )
            .chain(([goodKeys, badKeys]) =>
              bodyFromKeys([...goodKeys, ...badKeys]).map((body) => ({ table, body })),
            );
        }),
        ({ table, body }) => {
          const whitelist = getColumnWhitelist(table);
          const result = checkWhitelist(table, body);
          for (const key of result.rejectedKeys) {
            expect(whitelist.has(key)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects restricted privilege/ownership fields not declared as writable', () => {
    fc.assert(
      fc.property(tableArb, fc.constantFrom(...RESTRICTED_FIELDS), (table, field) => {
        const whitelist = getColumnWhitelist(table);
        // Only meaningful when the table does not explicitly declare the field.
        fc.pre(!whitelist.has(field));
        const result = checkWhitelist(table, { [field]: 'attacker-value' });
        expect(result.ok).toBe(false);
        expect(result.rejectedKeys).toContain(field);
      }),
      { numRuns: 200 },
    );
  });

  // ── Concrete regression cases called out by the spec ──────────────────────
  it('rejects a body that smuggles role/status/deleted_at into a known table', () => {
    const result = checkWhitelist('departments', {
      name: 'Internal Audit',
      role: 'admin',
      deleted_at: '2024-01-01',
    });
    expect(result.ok).toBe(false);
    expect(new Set(result.rejectedKeys)).toEqual(new Set(['role', 'deleted_at']));
  });

  it('treats every key as non-whitelisted for an unregistered table (fail closed)', () => {
    const result = checkWhitelist('no_such_table', { anything: 1, role: 'admin' });
    expect(result.ok).toBe(false);
    expect(new Set(result.rejectedKeys)).toEqual(new Set(['anything', 'role']));
  });

  it('accepts an empty body for any registered table', () => {
    for (const table of TABLE_NAMES) {
      expect(checkWhitelist(table, {})).toEqual({ ok: true, rejectedKeys: [] });
    }
  });
});

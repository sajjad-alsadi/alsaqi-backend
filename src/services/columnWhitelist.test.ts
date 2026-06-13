/**
 * Property-based tests for the schema-driven column whitelist
 * (`src/services/columnWhitelist.ts`).
 *
 * Spec: .kiro/specs/backend-security-hardening (task 5.2)
 *
 * Feature: backend-security-hardening, Property 6: Column whitelist equals schema field set
 *
 * Property 6 (Validates: Requirements 4.2):
 *   For any table registered in `TABLE_WRITE_SCHEMAS`, `getColumnWhitelist`
 *   returns exactly the set of field names declared in that table's Zod schema
 *   (`Object.keys(schema.shape)`), treating any name not declared in the schema
 *   as not whitelisted.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TABLE_WRITE_SCHEMAS,
  getColumnWhitelist,
} from './columnWhitelist';

const NUM_RUNS = 200;

// The set of registered table names. The schema field set is the source of
// truth, so the test derives expectations directly from `schema.shape`.
const REGISTERED_TABLES = Object.keys(TABLE_WRITE_SCHEMAS);

// A generator over the registered table names. Sanity-guarded so the suite
// fails loudly if the registry is ever emptied.
const registeredTable = fc.constantFrom(...REGISTERED_TABLES);

describe('Feature: backend-security-hardening, Property 6: Column whitelist equals schema field set', () => {
  it('has at least one registered table to exercise', () => {
    expect(REGISTERED_TABLES.length).toBeGreaterThan(0);
  });

  it('returns exactly the field names declared in the table Zod schema', () => {
    fc.assert(
      fc.property(registeredTable, (table) => {
        const expected = new Set(Object.keys(TABLE_WRITE_SCHEMAS[table].shape));
        const actual = getColumnWhitelist(table);

        // Same cardinality and same members in both directions => set equality.
        expect(actual.size).toBe(expected.size);
        for (const field of expected) {
          expect(actual.has(field)).toBe(true);
        }
        for (const field of actual) {
          expect(expected.has(field)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('treats any name not declared in the schema as not whitelisted', () => {
    fc.assert(
      fc.property(registeredTable, fc.string(), (table, candidate) => {
        const declared = new Set(Object.keys(TABLE_WRITE_SCHEMAS[table].shape));
        const whitelist = getColumnWhitelist(table);

        // The whitelist contains a name if and only if the schema declares it.
        expect(whitelist.has(candidate)).toBe(declared.has(candidate));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns an empty whitelist for unregistered tables (fail closed)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((name) => !(name in TABLE_WRITE_SCHEMAS)),
        (unregistered) => {
          expect(getColumnWhitelist(unregistered).size).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

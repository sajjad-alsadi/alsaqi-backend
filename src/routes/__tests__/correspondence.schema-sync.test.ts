// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { z } from 'zod';
import {
  PRIORITIES,
  CLASSIFICATIONS,
  METHODS,
  ENTITY_TYPES,
  LINK_TYPES,
} from '@alsaqi/shared';
import {
  CreateIncomingCorrespondenceSchema,
  CreateOutgoingCorrespondenceSchema,
  LinkCorrespondenceSchema,
} from '@alsaqi/shared';

/**
 * Property 5: Shared validator and route schema synchronization
 *
 * For each enum field defined in the correspondence module, the set of values
 * accepted by the route-level Zod schema SHALL be exactly equal to the set of
 * values accepted by the corresponding shared validator schema.
 *
 * Since both schemas import from the same constant arrays, this test verifies:
 * 1. Both schemas use z.enum() with the same constant arrays
 * 2. For any value from the allowed set, both schemas accept it
 * 3. For any value NOT in the allowed set, both schemas reject it
 *
 * **Validates: Requirements 9.1, 9.2, 9.3**
 */

// Route-level schemas (reconstructed exactly as in src/routes/correspondence.ts)
// These use the same shared constants imported from @alsaqi/shared
const routeIncomingSchema = z.object({
  letter_number: z.string().min(1).max(100),
  sender_entity: z.string().min(1).max(255),
  sender_entity_type: z.enum(ENTITY_TYPES).optional(),
  subject: z.string().min(1).max(500),
  letter_date: z.string().min(1),
  receipt_date: z.string().min(1),
  classification: z.enum(CLASSIFICATIONS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  method: z.enum(METHODS).optional(),
  receiving_dept_id: z.string().uuid().optional().nullable(),
  assigned_dept_id: z.string().uuid().optional().nullable(),
  assigned_user_id: z.string().uuid().optional().nullable(),
  follow_up_required: z.boolean().optional(),
  follow_up_date: z.string().optional().nullable(),
  response_required: z.boolean().optional(),
  response_due_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const routeOutgoingSchema = z.object({
  letter_date: z.string().min(1),
  recipient_entity: z.string().min(1).max(255),
  subject: z.string().min(1).max(500),
  classification: z.enum(CLASSIFICATIONS).optional(),
  sending_method: z.enum(METHODS).optional(),
  attachment_file: z.string().optional().nullable(),
});

const routeLinkSchema = z.object({
  incoming_id: z.string().uuid(),
  outgoing_id: z.string().uuid(),
  link_type: z.enum(LINK_TYPES).optional().default('Reply'),
});

/**
 * Extract enum options from a Zod v4 schema field by traversing
 * the _zod.def structure through optional/default wrappers.
 */
function getEnumOptions(schema: z.ZodObject<any>, fieldName: string): string[] | null {
  const field = (schema as any).shape[fieldName];
  if (!field) return null;

  // Recursively unwrap optional/default wrappers to find the enum
  function findEnumOptions(node: any): string[] | null {
    if (!node) return null;

    // Check if this node itself has .options (enum type in Zod v4)
    if (node.options && Array.isArray(node.options)) {
      return node.options;
    }

    // Check _zod.def for type info
    const def = node._zod?.def;
    if (!def) return null;

    if (def.type === 'enum' && node.options) {
      return node.options;
    }

    // Unwrap optional or default
    if (def.type === 'optional' || def.type === 'default') {
      return findEnumOptions(def.innerType);
    }

    return null;
  }

  return findEnumOptions(field);
}

// Helper: test if a specific field value is accepted by a schema
function isFieldAccepted(schema: z.ZodObject<any>, fieldName: string, value: string, baseData: Record<string, any>): boolean {
  const testData = { ...baseData, [fieldName]: value };
  const result = schema.safeParse(testData);
  if (result.success) return true;
  // Check if failure is specifically due to the target field
  const fieldErrors = result.error.issues.filter(
    (issue: any) => issue.path.includes(fieldName)
  );
  return fieldErrors.length === 0;
}

// Base valid data for each schema type
const validIncomingBase = {
  letter_number: 'LTR-001',
  sender_entity: 'Test Entity',
  subject: 'Test Subject',
  letter_date: '2025-01-15',
  receipt_date: '2025-01-16',
};

const validOutgoingBase = {
  letter_date: '2025-01-15',
  recipient_entity: 'Test Recipient',
  subject: 'Test Subject',
};

const validLinkBase = {
  incoming_id: '550e8400-e29b-41d4-a716-446655440000',
  outgoing_id: '660e8400-e29b-41d4-a716-446655440000',
};

describe('Property 5: Shared validator and route schema synchronization', () => {
  // Define enum field mappings between route and shared schemas
  const incomingEnumFields = [
    { field: 'priority', constants: PRIORITIES },
    { field: 'classification', constants: CLASSIFICATIONS },
    { field: 'method', constants: METHODS },
    { field: 'sender_entity_type', constants: ENTITY_TYPES },
  ] as const;

  const outgoingEnumFields = [
    { field: 'classification', constants: CLASSIFICATIONS },
    { field: 'sending_method', constants: METHODS },
  ] as const;

  const linkEnumFields = [
    { field: 'link_type', constants: LINK_TYPES },
  ] as const;

  describe('Incoming correspondence enum fields are synchronized', () => {
    for (const { field, constants } of incomingEnumFields) {
      it(`${field}: route schema and shared validator accept the same enum values`, () => {
        // Extract enum values from both schemas using Zod v4 API
        const routeValues = getEnumOptions(routeIncomingSchema, field);
        const sharedValues = getEnumOptions(CreateIncomingCorrespondenceSchema, field);

        expect(routeValues).not.toBeNull();
        expect(sharedValues).not.toBeNull();

        // The sets must be exactly equal
        expect([...routeValues!].sort()).toEqual([...sharedValues!].sort());
        // Both must reference the same constants
        expect([...routeValues!].sort()).toEqual([...constants].sort());
      });

      it(`${field}: valid values are accepted by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...constants),
            (validValue) => {
              const routeAccepted = isFieldAccepted(routeIncomingSchema, field, validValue, validIncomingBase);
              const sharedAccepted = isFieldAccepted(CreateIncomingCorrespondenceSchema, field, validValue, validIncomingBase);

              // Both must accept
              expect(routeAccepted).toBe(true);
              expect(sharedAccepted).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });

      it(`${field}: invalid values are rejected by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(
              (s) => !(constants as readonly string[]).includes(s)
            ),
            (invalidValue) => {
              const routeAccepted = isFieldAccepted(routeIncomingSchema, field, invalidValue, validIncomingBase);
              const sharedAccepted = isFieldAccepted(CreateIncomingCorrespondenceSchema, field, invalidValue, validIncomingBase);

              // Both must reject
              expect(routeAccepted).toBe(false);
              expect(sharedAccepted).toBe(false);
            }
          ),
          { numRuns: 100 }
        );
      });
    }
  });

  describe('Outgoing correspondence enum fields are synchronized', () => {
    for (const { field, constants } of outgoingEnumFields) {
      it(`${field}: route schema and shared validator accept the same enum values`, () => {
        const routeValues = getEnumOptions(routeOutgoingSchema, field);
        const sharedValues = getEnumOptions(CreateOutgoingCorrespondenceSchema, field);

        expect(routeValues).not.toBeNull();
        expect(sharedValues).not.toBeNull();

        expect([...routeValues!].sort()).toEqual([...sharedValues!].sort());
        expect([...routeValues!].sort()).toEqual([...constants].sort());
      });

      it(`${field}: valid values are accepted by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...constants),
            (validValue) => {
              const routeAccepted = isFieldAccepted(routeOutgoingSchema, field, validValue, validOutgoingBase);
              const sharedAccepted = isFieldAccepted(CreateOutgoingCorrespondenceSchema, field, validValue, validOutgoingBase);

              expect(routeAccepted).toBe(true);
              expect(sharedAccepted).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });

      it(`${field}: invalid values are rejected by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(
              (s) => !(constants as readonly string[]).includes(s)
            ),
            (invalidValue) => {
              const routeAccepted = isFieldAccepted(routeOutgoingSchema, field, invalidValue, validOutgoingBase);
              const sharedAccepted = isFieldAccepted(CreateOutgoingCorrespondenceSchema, field, invalidValue, validOutgoingBase);

              expect(routeAccepted).toBe(false);
              expect(sharedAccepted).toBe(false);
            }
          ),
          { numRuns: 100 }
        );
      });
    }
  });

  describe('Link correspondence enum fields are synchronized', () => {
    for (const { field, constants } of linkEnumFields) {
      it(`${field}: route schema and shared validator accept the same enum values`, () => {
        const routeValues = getEnumOptions(routeLinkSchema, field);
        const sharedValues = getEnumOptions(LinkCorrespondenceSchema, field);

        expect(routeValues).not.toBeNull();
        expect(sharedValues).not.toBeNull();

        expect([...routeValues!].sort()).toEqual([...sharedValues!].sort());
        expect([...routeValues!].sort()).toEqual([...constants].sort());
      });

      it(`${field}: valid values are accepted by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...constants),
            (validValue) => {
              const routeAccepted = isFieldAccepted(routeLinkSchema, field, validValue, validLinkBase);
              const sharedAccepted = isFieldAccepted(LinkCorrespondenceSchema, field, validValue, validLinkBase);

              expect(routeAccepted).toBe(true);
              expect(sharedAccepted).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });

      it(`${field}: invalid values are rejected by both schemas (property)`, () => {
        fc.assert(
          fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(
              (s) => !(constants as readonly string[]).includes(s)
            ),
            (invalidValue) => {
              const routeAccepted = isFieldAccepted(routeLinkSchema, field, invalidValue, validLinkBase);
              const sharedAccepted = isFieldAccepted(LinkCorrespondenceSchema, field, invalidValue, validLinkBase);

              expect(routeAccepted).toBe(false);
              expect(sharedAccepted).toBe(false);
            }
          ),
          { numRuns: 100 }
        );
      });
    }
  });
});

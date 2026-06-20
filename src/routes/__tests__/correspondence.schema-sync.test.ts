// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { z } from 'zod';
import {
  PRIORITIES,
  CLASSIFICATIONS,
  METHODS,
  ENTITY_TYPES,
  LINK_TYPES,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
} from '@alsaqi/shared';
import {
  CreateIncomingCorrespondenceSchema,
  CreateOutgoingCorrespondenceSchema,
  LinkCorrespondenceSchema,
} from '@alsaqi/shared';

/**
 * Schema synchronization (finding 1.7 -> 2.7)
 *
 * The route-level Zod schemas defined in `src/routes/correspondence.ts` MUST stay
 * in lock-step with the single source of truth — the `@alsaqi/shared` enum constants
 * (and, where applicable, the shared validator schemas). This test imports the REAL
 * exported route schemas rather than reconstructing local copies, so any drift in a
 * real route schema (e.g. editing a `z.enum(...)`) now fails this test (1.7 -> 2.7).
 *
 * Coverage:
 *  - incoming/outgoing/link create schemas vs the shared CREATE validators + constants
 *  - incoming/outgoing status-update schemas: `new_status` vs INCOMING_STATUSES / OUTGOING_STATUSES
 *  - attachment schema: `correspondence_type` lowercase casing (pins Task 3.1) + `file_type`
 *    vs the ALLOWED_MIME_TYPES allowlist
 *
 * Preservation (3.1): valid enum values are still accepted across every enum field.
 *
 * **Validates: Requirements 2.7, 3.1**
 */

// Keep the import of `../correspondence` side-effect-free. That module transitively pulls in
// CorrespondenceService (-> db/index, winston logger, n8n) and AuthService (-> db, key/audit
// chain services). This test only inspects the exported Zod schemas and never builds the router
// (createCorrespondenceRoutes), so both services are stubbed with empty objects (mirrors
// correspondence.integration.test.ts). The module loads, the exported schemas are the REAL ones,
// and no DB connection or logger transport is opened.
vi.mock('../../services/CorrespondenceService', () => ({ CorrespondenceService: {} }));
vi.mock('../../services/AuthService', () => ({ AuthService: {} }));

// The REAL route schemas, imported (not reconstructed) — this is the crux of finding 1.7.
// Aliased to the historical route* names to minimize churn in the existing assertions below.
import {
  incomingSchema as routeIncomingSchema,
  outgoingSchema as routeOutgoingSchema,
  linkSchema as routeLinkSchema,
  incomingStatusUpdateSchema,
  outgoingStatusUpdateSchema,
} from '../correspondence';

// The attachment schema + MIME allowlist are backend-only (there is no shared attachment
// validator), so they are imported directly from the schema module that owns them.
import { correspondenceAttachmentSchema, ALLOWED_MIME_TYPES } from '../../schemas/correspondence';

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

const validAttachmentBase = {
  correspondence_id: '550e8400-e29b-41d4-a716-446655440000',
  correspondence_type: 'incoming',
  file_name: 'document.pdf',
  file_type: 'application/pdf',
  file_data: 'base64-encoded-content',
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

  // ── Status-update schemas (finding 1.7 extension) ───────────────────────────────
  // No typed status-update validator is exported from @alsaqi/shared (only the
  // deprecated string-based CorrespondenceStatusUpdateSchema), so the single-source-of-truth
  // check asserts the route schema's `new_status` enum set equals the shared CONSTANT arrays.
  describe('Status-update schema new_status is synchronized with the shared status constants', () => {
    const statusSchemas = [
      { name: 'incoming', schema: incomingStatusUpdateSchema, constants: INCOMING_STATUSES },
      { name: 'outgoing', schema: outgoingStatusUpdateSchema, constants: OUTGOING_STATUSES },
    ] as const;

    for (const { name, schema, constants } of statusSchemas) {
      it(`${name}: new_status enum set is exactly the shared status constant`, () => {
        const routeValues = getEnumOptions(schema, 'new_status');
        expect(routeValues).not.toBeNull();
        expect([...routeValues!].sort()).toEqual([...constants].sort());
      });

      it(`${name}: every shared status value is accepted (property)`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...constants),
            (validStatus) => {
              expect(isFieldAccepted(schema, 'new_status', validStatus, {})).toBe(true);
            }
          ),
          { numRuns: 100 }
        );
      });

      it(`${name}: values outside the shared status set are rejected (property)`, () => {
        fc.assert(
          fc.property(
            fc.string({ minLength: 1, maxLength: 50 }).filter(
              (s) => !(constants as readonly string[]).includes(s)
            ),
            (invalidStatus) => {
              expect(isFieldAccepted(schema, 'new_status', invalidStatus, {})).toBe(false);
            }
          ),
          { numRuns: 100 }
        );
      });
    }
  });

  // ── Attachment schema (finding 1.7 extension, pins Task 3.1) ─────────────────────
  // correspondence_type is lowercase at the HTTP edge (matches the lowercase path params);
  // file_type must be one of the ALLOWED_MIME_TYPES allowlist.
  describe('Attachment schema casing and MIME allowlist are synchronized', () => {
    it('correspondence_type enum set is exactly the lowercase { incoming, outgoing }', () => {
      const values = getEnumOptions(correspondenceAttachmentSchema, 'correspondence_type');
      expect(values).not.toBeNull();
      expect([...values!].sort()).toEqual(['incoming', 'outgoing'].sort());
    });

    it('correspondence_type accepts lowercase incoming/outgoing and rejects the capitalized form (Task 3.1 casing)', () => {
      // Lowercase accepted
      expect(isFieldAccepted(correspondenceAttachmentSchema, 'correspondence_type', 'incoming', validAttachmentBase)).toBe(true);
      expect(isFieldAccepted(correspondenceAttachmentSchema, 'correspondence_type', 'outgoing', validAttachmentBase)).toBe(true);
      // Capitalized (the pre-fix contract) rejected — this pins the casing decision
      expect(isFieldAccepted(correspondenceAttachmentSchema, 'correspondence_type', 'Incoming', validAttachmentBase)).toBe(false);
      expect(isFieldAccepted(correspondenceAttachmentSchema, 'correspondence_type', 'Outgoing', validAttachmentBase)).toBe(false);
    });

    it('file_type enum set is exactly the ALLOWED_MIME_TYPES allowlist', () => {
      const values = getEnumOptions(correspondenceAttachmentSchema, 'file_type');
      expect(values).not.toBeNull();
      expect([...values!].sort()).toEqual([...ALLOWED_MIME_TYPES].sort());
    });

    it('file_type: every allowed MIME type is accepted (property)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALLOWED_MIME_TYPES),
          (mime) => {
            expect(isFieldAccepted(correspondenceAttachmentSchema, 'file_type', mime, validAttachmentBase)).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('file_type: values outside the allowlist are rejected (property)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter(
            (s) => !(ALLOWED_MIME_TYPES as readonly string[]).includes(s)
          ),
          (badMime) => {
            expect(isFieldAccepted(correspondenceAttachmentSchema, 'file_type', badMime, validAttachmentBase)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

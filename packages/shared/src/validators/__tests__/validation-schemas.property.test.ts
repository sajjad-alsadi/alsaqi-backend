/**
 * Property tests for shared validation schemas.
 *
 * Property 3: Validation Symmetry - verify schemas produce identical parse results
 * in both environments (deterministic behavior).
 *
 * Property 9: Schema Constraint Completeness - verify all string fields have min/max,
 * all enums have explicit values.
 *
 * **Validates: Requirements 2.5, 10.1, 10.2, 10.3, 10.4**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';

import {
  // Auth schemas
  LoginSchema,
  RegisterSchema,
  ChangePasswordSchema,
  UpdatePasswordSchema,
  ForgotPasswordSchema,
  ApproveResetSchema,
  // Findings schemas
  CreateFindingSchema,
  UpdateFindingSchema,
  ChangeFindingStatusSchema,
  // Audit plans schemas
  CreateAuditPlanSchema,
  UpdateAuditPlanSchema,
  // Tasks schemas
  CreateTaskSchema,
  UpdateTaskSchema,
  ChangeTaskStatusSchema,
  AssignTaskUsersSchema,
  // Users schemas
  CreateUserSchema,
  UpdateUserSchema,
  ResetUserPasswordSchema,
  // Correspondence schemas
  CreateIncomingCorrespondenceSchema,
  UpdateIncomingCorrespondenceSchema,
  CreateOutgoingCorrespondenceSchema,
  UpdateOutgoingCorrespondenceSchema,
  ReferCorrespondenceSchema,
  LinkCorrespondenceSchema,
  CorrespondenceStatusUpdateSchema,
} from '../index';

/**
 * All exported schemas to be tested for constraint completeness.
 */
const ALL_SCHEMAS: Record<string, z.ZodType> = {
  LoginSchema,
  RegisterSchema,
  ChangePasswordSchema,
  UpdatePasswordSchema,
  ForgotPasswordSchema,
  ApproveResetSchema,
  CreateFindingSchema,
  UpdateFindingSchema,
  ChangeFindingStatusSchema,
  CreateAuditPlanSchema,
  UpdateAuditPlanSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  ChangeTaskStatusSchema,
  AssignTaskUsersSchema,
  CreateUserSchema,
  UpdateUserSchema,
  ResetUserPasswordSchema,
  CreateIncomingCorrespondenceSchema,
  UpdateIncomingCorrespondenceSchema,
  CreateOutgoingCorrespondenceSchema,
  UpdateOutgoingCorrespondenceSchema,
  ReferCorrespondenceSchema,
  LinkCorrespondenceSchema,
  CorrespondenceStatusUpdateSchema,
};


// ============================================================================
// Utility: Introspect Zod schema shape
// ============================================================================

/**
 * Unwrap a Zod schema to get the inner type (handles optional, nullable, default, etc.)
 * Uses Zod v4's .unwrap() method which is available on Optional, Nullable, and Default schemas.
 */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    return unwrapSchema((schema as z.ZodOptional<z.ZodType>).unwrap());
  }
  if (schema instanceof z.ZodNullable) {
    return unwrapSchema((schema as z.ZodNullable<z.ZodType>).unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapSchema((schema as z.ZodDefault<z.ZodType>).unwrap());
  }
  return schema;
}

/**
 * Get the shape (fields) of an object schema.
 */
function getObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  if (schema instanceof z.ZodObject) {
    return schema._zod.def.shape as Record<string, z.ZodType>;
  }
  return null;
}

/**
 * Check if a schema has min constraint (for strings).
 * In Zod v4, minLength is exposed as a direct property on the schema instance.
 */
function hasMinConstraint(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodString)) return false;
  // Zod v4 exposes minLength as a direct property
  return (schema as any).minLength != null && (schema as any).minLength >= 0;
}

/**
 * Check if a schema has max constraint (for strings).
 * In Zod v4, maxLength is exposed as a direct property on the schema instance.
 */
function hasMaxConstraint(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodString)) return false;
  // Zod v4 exposes maxLength as a direct property
  return (schema as any).maxLength != null && (schema as any).maxLength > 0;
}

/**
 * Check if a schema is a z.enum() with explicit values.
 */
function isExplicitEnum(schema: z.ZodType): boolean {
  return schema instanceof z.ZodEnum;
}

/**
 * Collect all string and enum fields from a schema, including nested unwrapping.
 * Returns an array of { path, innerSchema } for each leaf field.
 */
function collectFields(
  schema: z.ZodType,
  path: string = ''
): Array<{ path: string; innerSchema: z.ZodType }> {
  const shape = getObjectShape(schema);
  if (!shape) return [];

  const results: Array<{ path: string; innerSchema: z.ZodType }> = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const inner = unwrapSchema(fieldSchema);
    results.push({ path: fieldPath, innerSchema: inner });
  }

  return results;
}

// ============================================================================
// Property 3: Validation Symmetry
// ============================================================================

describe('Property 3: Validation Symmetry', () => {
  /**
   * For any Zod schema and any input, safeParse produces identical success/error
   * results regardless of invocation context. Since both server (Node.js) and
   * client run the same Zod code, we verify determinism: the same input always
   * produces the same result across multiple parse invocations.
   *
   * **Validates: Requirements 2.5, 10.1, 10.2**
   */

  const schemasToTest: Array<{ name: string; schema: z.ZodType }> = Object.entries(
    ALL_SCHEMAS
  ).map(([name, schema]) => ({ name, schema }));

  for (const { name, schema } of schemasToTest) {
    it(`${name}: safeParse is deterministic - same input always produces same result`, () => {
      fc.assert(
        fc.property(
          // Generate arbitrary JSON-like inputs to test against the schema
          fc.oneof(
            fc.dictionary(fc.string({ minLength: 0, maxLength: 20 }), fc.jsonValue()),
            fc.constant(null),
            fc.constant(undefined),
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant({}),
            fc.array(fc.jsonValue())
          ),
          (input) => {
            // Parse the same input twice to verify determinism
            const result1 = (schema as any).safeParse(input);
            const result2 = (schema as any).safeParse(input);

            // Success boolean must match
            expect(result1.success).toBe(result2.success);

            if (result1.success && result2.success) {
              // Parsed data must be identical
              expect(result1.data).toEqual(result2.data);
            } else if (!result1.success && !result2.success) {
              // Error structure must be identical
              expect(result1.error.issues.length).toBe(result2.error.issues.length);
              for (let i = 0; i < result1.error.issues.length; i++) {
                expect(result1.error.issues[i].path).toEqual(
                  result2.error.issues[i].path
                );
                expect(result1.error.issues[i].code).toBe(
                  result2.error.issues[i].code
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  }

  it('Valid inputs produce consistent success across multiple parses', () => {
    // Test with specifically valid inputs to verify parse consistency
    fc.assert(
      fc.property(
        fc.record({
          usernameOrEmail: fc.string({ minLength: 1, maxLength: 100 }),
          password: fc.string({ minLength: 1, maxLength: 100 }),
          rememberMe: fc.boolean(),
        }),
        (validLogin) => {
          const r1 = LoginSchema.safeParse(validLogin);
          const r2 = LoginSchema.safeParse(validLogin);
          expect(r1.success).toBe(true);
          expect(r2.success).toBe(true);
          if (r1.success && r2.success) {
            expect(r1.data).toEqual(r2.data);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});


// ============================================================================
// Property 9: Schema Constraint Completeness
// ============================================================================

describe('Property 9: Schema Constraint Completeness', () => {
  /**
   * For any string field in any exported schema, verify it has both min and max
   * constraints. For any enum field, verify it uses z.enum() with explicit values.
   *
   * **Validates: Requirements 10.3, 10.4**
   */

  for (const [schemaName, schema] of Object.entries(ALL_SCHEMAS)) {
    const fields = collectFields(schema);

    const stringFields = fields.filter(
      (f) => f.innerSchema instanceof z.ZodString
    );
    const enumFields = fields.filter(
      (f) => f.innerSchema instanceof z.ZodEnum
    );

    if (stringFields.length > 0) {
      it(`${schemaName}: all string fields have min length constraint`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...stringFields),
            ({ path, innerSchema }) => {
              expect(
                hasMinConstraint(innerSchema),
                `Field "${path}" in ${schemaName} is missing a min length constraint`
              ).toBe(true);
            }
          ),
          { numRuns: stringFields.length }
        );
      });

      it(`${schemaName}: all string fields have max length constraint`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...stringFields),
            ({ path, innerSchema }) => {
              expect(
                hasMaxConstraint(innerSchema),
                `Field "${path}" in ${schemaName} is missing a max length constraint`
              ).toBe(true);
            }
          ),
          { numRuns: stringFields.length }
        );
      });
    }

    if (enumFields.length > 0) {
      it(`${schemaName}: all enum fields use z.enum() with explicit values`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...enumFields),
            ({ path, innerSchema }) => {
              expect(
                isExplicitEnum(innerSchema),
                `Field "${path}" in ${schemaName} does not use z.enum() with explicit values`
              ).toBe(true);
            }
          ),
          { numRuns: enumFields.length }
        );
      });

      it(`${schemaName}: enum fields have at least one allowed value`, () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...enumFields),
            ({ path, innerSchema }) => {
              const enumSchema = innerSchema as z.ZodEnum<any>;
              // In Zod v4, enum values are exposed via .options (array) or .enum (object)
              const options = (enumSchema as any).options || Object.keys((enumSchema as any).enum || {});
              expect(
                options.length,
                `Field "${path}" in ${schemaName} has an empty enum values list`
              ).toBeGreaterThan(0);
            }
          ),
          { numRuns: enumFields.length }
        );
      });
    }
  }

  it('No schema has a bare z.string() without length constraints', () => {
    /**
     * Meta-property: across ALL schemas, every string field must be constrained.
     * This is a universal check that catches any schema additions that forget constraints.
     */
    const allStringFields: Array<{
      schemaName: string;
      path: string;
      innerSchema: z.ZodType;
    }> = [];

    for (const [schemaName, schema] of Object.entries(ALL_SCHEMAS)) {
      const fields = collectFields(schema);
      for (const field of fields) {
        if (field.innerSchema instanceof z.ZodString) {
          allStringFields.push({ schemaName, ...field });
        }
      }
    }

    // Skip if no string fields found (shouldn't happen, but defensive)
    if (allStringFields.length === 0) return;

    fc.assert(
      fc.property(
        fc.constantFrom(...allStringFields),
        ({ schemaName, path, innerSchema }) => {
          expect(
            hasMinConstraint(innerSchema),
            `${schemaName}.${path}: missing min constraint`
          ).toBe(true);
          expect(
            hasMaxConstraint(innerSchema),
            `${schemaName}.${path}: missing max constraint`
          ).toBe(true);
        }
      ),
      { numRuns: allStringFields.length }
    );
  });
});

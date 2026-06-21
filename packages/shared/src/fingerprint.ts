/**
 * @alsaqi/shared - Public surface fingerprint
 *
 * Design: production-launch-readiness, Region (و) — توحيد Shared_Package + Parity_Check بالبصمة.
 * Requirements: 8.3, 8.6
 *
 * `computeSharedSurfaceFingerprint` produces a deterministic SHA-256 (hex) hash over a
 * stable canonicalization of the package's PUBLIC SURFACE. The fingerprint is the same
 * for two identical surfaces, and any change to an exported constant, enum value, or
 * endpoint contract (Zod schema shape) produces a different fingerprint.
 *
 * ── What is included in the surface ───────────────────────────────────────────
 * TypeScript `interface`/`type` declarations are erased at runtime and cannot be
 * introspected, so the canonical surface is built from the exported RUNTIME values
 * that back the public contracts:
 *
 *   1. Constants (`./constants`):
 *      ErrorCodes, ModuleNames, MODULE_NAME_LIST, API_VERSION,
 *      ADMIN_ROLES, COMPLIANCE_ROLES, STAFF_ROLES, PERMISSION_MODULE_MAP, and the
 *      correspondence enum arrays (INCOMING_STATUSES, OUTGOING_STATUSES, PRIORITIES,
 *      CLASSIFICATIONS, METHODS, ENTITY_TYPES, REFERRAL_STATUSES, LINK_TYPES).
 *
 *   2. Enums (`./types/enums`):
 *      every exported enum object (UserRole, AuditStatus, ModuleName, TaskStatus, ...).
 *      Enum members are part of the public surface; their string values are hashed.
 *
 *   3. Endpoint contracts as runtime Zod schemas (`./validators` and `./types/api`):
 *      every exported `ZodType` schema (request/response validators and the response
 *      envelope schemas). Each schema is canonicalized via its JSON-Schema projection
 *      so structural changes (added/removed fields, type or constraint changes) alter
 *      the fingerprint. Schema factory functions (e.g. `SuccessResponseSchema`) are
 *      represented by name.
 *
 * Pure type-only modules (`./types/endpoints`, `./types/models`) contribute no runtime
 * values and therefore are not directly introspectable; their observable public contract
 * is represented through the Zod validators that mirror those endpoint shapes.
 *
 * Canonicalization is order-independent: object keys are sorted recursively, so the
 * representation depends only on surface content, not declaration/import order.
 */
import { createHash } from 'node:crypto';

import * as constants from './constants';
import * as enums from './types/enums';
import * as apiTypes from './types/api';
import * as validators from './validators';
import { z } from 'zod';

/** A value that has been reduced to a JSON-serializable, order-stable form. */
type CanonicalValue =
  | null
  | string
  | number
  | boolean
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Duck-type detection of a Zod schema across zod versions. */
function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function' &&
    typeof (value as { parse?: unknown }).parse === 'function'
  );
}

/**
 * Reduce a Zod schema to a stable structural descriptor.
 * Prefers the JSON-Schema projection (captures fields, types, and constraints); falls
 * back to a minimal structural descriptor for schemas that cannot be projected
 * (e.g. those containing transforms/refinements that JSON Schema cannot express).
 */
function canonicalizeZod(schema: z.ZodType): CanonicalValue {
  try {
    const jsonSchema = z.toJSONSchema(schema, { unrepresentable: 'any' });
    return { __zodSchema__: canonicalize(jsonSchema) };
  } catch {
    const def = (schema as unknown as { _def?: { typeName?: unknown } })._def;
    const typeName =
      def && typeof def.typeName === 'string' ? def.typeName : 'unknown';
    return { __zodSchema__: { __unrepresentable__: typeName } };
  }
}

/**
 * Recursively normalize an arbitrary runtime value into an order-stable canonical form.
 * Object keys are sorted so the output is independent of property insertion order.
 *
 * Exported so the deterministic canonicalize+hash logic that backs
 * `computeSharedSurfaceFingerprint` can be exercised over generated surfaces by the
 * Property 5 property test (determinism + sensitivity).
 */
export function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return null;

  const valueType = typeof value;

  switch (valueType) {
    case 'string':
      return value as string;
    case 'number':
      // Normalize -0 and non-finite values to stable string tokens.
      if (Number.isNaN(value as number)) return '__nan__';
      if (!Number.isFinite(value as number)) {
        return (value as number) > 0 ? '__+inf__' : '__-inf__';
      }
      return Object.is(value, -0) ? 0 : (value as number);
    case 'boolean':
      return value as boolean;
    case 'bigint':
      return `__bigint__:${(value as bigint).toString()}`;
    case 'undefined':
      return '__undefined__';
    case 'symbol':
      return `__symbol__:${(value as symbol).toString()}`;
    case 'function':
      // Schema factories / helper functions: represent by name (stable identifier).
      return { __function__: (value as { name?: string }).name ?? '' };
  }

  if (isZodSchema(value)) {
    return canonicalizeZod(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  // Plain object (includes enum objects and const maps): sort keys for determinism.
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: { [key: string]: CanonicalValue } = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(record[key]);
  }
  return result;
}

/**
 * Build the canonical representation of one exported module namespace.
 * Only own enumerable runtime exports are considered; the keys are sorted.
 */
function canonicalizeNamespace(
  namespace: Record<string, unknown>,
  excludeKeys: ReadonlySet<string> = new Set(),
): { [key: string]: CanonicalValue } {
  const result: { [key: string]: CanonicalValue } = {};
  const sortedKeys = Object.keys(namespace)
    .filter((key) => !excludeKeys.has(key))
    .sort();
  for (const key of sortedKeys) {
    result[key] = canonicalize(namespace[key]);
  }
  return result;
}

/**
 * Compute a deterministic SHA-256 (hex) fingerprint over an arbitrary surface value by
 * canonicalizing it (recursive key sort, stable value normalization) and hashing the
 * canonical JSON.
 *
 * This is the deterministic core that backs `computeSharedSurfaceFingerprint`. It is
 * exported so the determinism + sensitivity property (Property 5) can be exercised over
 * generated surfaces: identical canonical forms must yield identical fingerprints, and
 * any structural change must yield a different fingerprint.
 */
export function fingerprintSurface(surface: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(surface));
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Compute a deterministic SHA-256 (hex) fingerprint over the canonicalized public
 * surface of `@alsaqi/shared`.
 *
 * Two identical surfaces yield the same fingerprint; any change to an exported
 * constant, enum value, or endpoint contract (Zod schema shape) yields a different one.
 */
export function computeSharedSurfaceFingerprint(): string {
  // Exclude the fingerprint function itself so the surface description is self-contained
  // and stable even once this module is re-exported from the package barrel.
  const surface: { [key: string]: CanonicalValue } = {
    constants: canonicalizeNamespace(constants),
    enums: canonicalizeNamespace(enums),
    apiContracts: canonicalizeNamespace(apiTypes),
    validators: canonicalizeNamespace(validators),
  };

  return fingerprintSurface(surface);
}

/**
 * OpenAPI ↔ Route Bidirectional Equivalence Check
 * (Design → Components → Area ز, Requirements 10.2, 10.3, 10.4)
 *
 * Provides a pure, deterministic comparison between the set of registered API
 * routes and the set of operations described in the OpenAPI document. The check
 * is bidirectional:
 *   - `missingInSpec`   → a registered route that has no matching OpenAPI operation.
 *   - `missingInRoutes` → a documented OpenAPI operation that has no matching route.
 *
 * Two operations match when they share the same HTTP method (case-insensitive)
 * and the exact same path template. The `Docs_Endpoint` itself (`/api/v1/docs`)
 * is excluded from the comparison on both sides, since it serves the spec rather
 * than being described by it.
 *
 * This module is intentionally side-effect free: it performs NO I/O, NO logging,
 * and never reads the filesystem. Route extraction from the Express stack and
 * OpenAPI parsing happen in the integration layer; this function operates purely
 * on the already-extracted `Operation[]` lists. The CI gate that fails the build
 * on divergence is layered on top of this function.
 *
 * Validates: Requirements 10.2, 10.3, 10.4
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single API operation identified by its HTTP method and path template. */
export interface Operation {
  method: string;
  pathTemplate: string;
}

/**
 * The result of comparing registered routes against documented operations.
 * `equivalent` is true if and only if both divergence lists are empty.
 */
export interface EquivalenceReport {
  /** Registered routes with no matching documented operation. */
  missingInSpec: Operation[];
  /** Documented operations with no matching registered route. */
  missingInRoutes: Operation[];
  /** True ⇔ `missingInSpec` and `missingInRoutes` are both empty. */
  equivalent: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** The Docs_Endpoint path template, excluded from comparison (Requirement 10.2). */
const DOCS_ENDPOINT_PATH = '/api/v1/docs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a canonical key for an operation: normalized (upper-case) method plus
 * the verbatim path template. Used for bidirectional set membership comparison.
 */
function operationKey(op: Operation): string {
  return `${op.method.toUpperCase()} ${op.pathTemplate}`;
}

/** Determine whether an operation refers to the excluded Docs_Endpoint. */
function isDocsEndpoint(op: Operation): boolean {
  return op.pathTemplate === DOCS_ENDPOINT_PATH;
}

// ─── Equivalence Check ─────────────────────────────────────────────────────

/**
 * Compute the bidirectional equivalence report between registered `routes` and
 * documented `spec` operations.
 *
 * Operations are compared by `(method, pathTemplate)` where the method is
 * normalized to be case-insensitive. The Docs_Endpoint (`/api/v1/docs`) is
 * excluded from both sides before comparison.
 *
 * Returns `equivalent: true` if and only if every registered route has a matching
 * documented operation AND every documented operation has a matching registered
 * route (after the Docs_Endpoint exclusion).
 *
 * Pure function: no side effects.
 */
export function checkOpenApiRouteEquivalence(
  routes: Operation[],
  spec: Operation[]
): EquivalenceReport {
  const filteredRoutes = routes.filter((op) => !isDocsEndpoint(op));
  const filteredSpec = spec.filter((op) => !isDocsEndpoint(op));

  const specKeys = new Set(filteredSpec.map(operationKey));
  const routeKeys = new Set(filteredRoutes.map(operationKey));

  // Registered routes with no matching documented operation.
  const missingInSpec: Operation[] = filteredRoutes.filter(
    (op) => !specKeys.has(operationKey(op))
  );

  // Documented operations with no matching registered route.
  const missingInRoutes: Operation[] = filteredSpec.filter(
    (op) => !routeKeys.has(operationKey(op))
  );

  return {
    missingInSpec,
    missingInRoutes,
    equivalent: missingInSpec.length === 0 && missingInRoutes.length === 0,
  };
}

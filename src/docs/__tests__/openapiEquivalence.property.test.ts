// @vitest-environment node
// Feature: production-launch-readiness, Property 6: Bidirectional OpenAPI ↔ route equivalence
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property 6: التكافؤ ثنائي الاتجاه بين OpenAPI والمسارات
 *
 * For ANY pair of operation sets (registered routes vs documented spec):
 *   - `equivalent` is true IFF both `missingInSpec` and `missingInRoutes` are empty.
 *   - Every registered route with no matching documented operation appears in
 *     `missingInSpec`; every documented operation with no matching route appears
 *     in `missingInRoutes` (compared by method case-insensitively + exact pathTemplate).
 *   - The Docs_Endpoint (`/api/v1/docs`) is excluded from comparison on both
 *     sides: injecting it into either side never causes divergence.
 *
 * The expected report is computed via an INDEPENDENT oracle that performs a set
 * difference after excluding the docs endpoint and normalizing method case.
 *
 * Validates: Requirements 10.2, 10.3, 10.4
 */

import {
  checkOpenApiRouteEquivalence,
  type Operation,
} from '../openapiEquivalence.js';

// ─── Constants mirrored from the module under test ───────────────────────────

const DOCS_ENDPOINT_PATH = '/api/v1/docs';

// ─── Independent reference oracle ────────────────────────────────────────────

/** Canonical key: normalized (upper-case) method + verbatim path template. */
function oracleKey(op: Operation): string {
  return `${op.method.toUpperCase()} ${op.pathTemplate}`;
}

function isDocs(op: Operation): boolean {
  return op.pathTemplate === DOCS_ENDPOINT_PATH;
}

/**
 * Independent computation of the equivalence report using set difference.
 * Deliberately implemented differently from the production code path to act as
 * a trustworthy oracle.
 */
function oracleEquivalence(routes: Operation[], spec: Operation[]) {
  const filteredRoutes = routes.filter((op) => !isDocs(op));
  const filteredSpec = spec.filter((op) => !isDocs(op));

  const specKeys = new Set(filteredSpec.map(oracleKey));
  const routeKeys = new Set(filteredRoutes.map(oracleKey));

  const missingInSpec = filteredRoutes.filter((op) => !specKeys.has(oracleKey(op)));
  const missingInRoutes = filteredSpec.filter((op) => !routeKeys.has(oracleKey(op)));

  return { missingInSpec, missingInRoutes };
}

// ─── Generators spanning the documented input space ──────────────────────────

/** HTTP methods in mixed case (incl. lower/upper/mixed) to exercise case-insensitivity. */
const methodArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('get', 'post', 'put', 'patch', 'delete', 'options', 'head'),
  fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
  fc.constantFrom('Get', 'Post', 'PuT', 'pAtCh', 'Delete')
);

/** Random path templates, drawn from a small pool to encourage collisions/overlap. */
const pathArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '/api/v1/users',
    '/api/v1/users/{id}',
    '/api/v1/audits',
    '/api/v1/audits/{auditId}/findings',
    '/api/v1/fraud',
    '/api/v1/health',
    '/api/v1/reports/{reportId}'
  ),
  // also generate fully random path-ish strings
  fc
    .array(fc.constantFrom('a', 'b', 'users', 'id', '{x}', 'v2', 'data'), {
      minLength: 1,
      maxLength: 4,
    })
    .map((segs) => '/' + segs.join('/'))
);

const operationArb: fc.Arbitrary<Operation> = fc.record({
  method: methodArb,
  pathTemplate: pathArb,
});

const operationsArb: fc.Arbitrary<Operation[]> = fc.array(operationArb, {
  minLength: 0,
  maxLength: 12,
});

const docsOp: Operation = { method: 'get', pathTemplate: DOCS_ENDPOINT_PATH };

// ─── Properties ───────────────────────────────────────────────────────────────

describe('Property 6: التكافؤ ثنائي الاتجاه بين OpenAPI والمسارات (checkOpenApiRouteEquivalence)', () => {
  it('equivalent === true IFF both divergence lists are empty', () => {
    fc.assert(
      fc.property(operationsArb, operationsArb, (routes, spec) => {
        const report = checkOpenApiRouteEquivalence(routes, spec);
        const emptyBoth =
          report.missingInSpec.length === 0 && report.missingInRoutes.length === 0;
        expect(report.equivalent).toBe(emptyBoth);
      }),
      { numRuns: 200 }
    );
  });

  it('matches the independent set-difference oracle on both sides', () => {
    fc.assert(
      fc.property(operationsArb, operationsArb, (routes, spec) => {
        const report = checkOpenApiRouteEquivalence(routes, spec);
        const expected = oracleEquivalence(routes, spec);

        // Compare as multisets of canonical keys (order-independent).
        const keysOf = (ops: Operation[]) => ops.map(oracleKey).sort();
        expect(keysOf(report.missingInSpec)).toEqual(keysOf(expected.missingInSpec));
        expect(keysOf(report.missingInRoutes)).toEqual(
          keysOf(expected.missingInRoutes)
        );
      }),
      { numRuns: 200 }
    );
  });

  it('every unmatched route appears in missingInSpec; every unmatched op in missingInRoutes (case-insensitive method, exact path)', () => {
    fc.assert(
      fc.property(operationsArb, operationsArb, (routes, spec) => {
        const report = checkOpenApiRouteEquivalence(routes, spec);

        const specKeys = new Set(
          spec.filter((o) => !isDocs(o)).map(oracleKey)
        );
        const routeKeys = new Set(
          routes.filter((o) => !isDocs(o)).map(oracleKey)
        );

        // Direction 1: a registered route lacking a documented op must be reported.
        for (const op of routes) {
          if (isDocs(op)) continue;
          if (!specKeys.has(oracleKey(op))) {
            expect(report.missingInSpec.map(oracleKey)).toContain(oracleKey(op));
          }
        }

        // Direction 2: a documented op lacking a route must be reported.
        for (const op of spec) {
          if (isDocs(op)) continue;
          if (!routeKeys.has(oracleKey(op))) {
            expect(report.missingInRoutes.map(oracleKey)).toContain(oracleKey(op));
          }
        }

        // Conversely, nothing matched should be reported as missing.
        for (const op of report.missingInSpec) {
          expect(specKeys.has(oracleKey(op))).toBe(false);
        }
        for (const op of report.missingInRoutes) {
          expect(routeKeys.has(oracleKey(op))).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('the Docs_Endpoint is excluded on both sides and never causes divergence', () => {
    fc.assert(
      fc.property(
        operationsArb,
        operationsArb,
        fc.boolean(),
        fc.boolean(),
        (routes, spec, injectIntoRoutes, injectIntoSpec) => {
          // Baseline report without any docs endpoint injected.
          const routesNoDocs = routes.filter((o) => !isDocs(o));
          const specNoDocs = spec.filter((o) => !isDocs(o));
          const baseline = checkOpenApiRouteEquivalence(routesNoDocs, specNoDocs);

          // Inject the docs endpoint into either/both sides.
          const injectedRoutes = injectIntoRoutes
            ? [...routesNoDocs, docsOp]
            : routesNoDocs;
          const injectedSpec = injectIntoSpec ? [...specNoDocs, docsOp] : specNoDocs;
          const withDocs = checkOpenApiRouteEquivalence(injectedRoutes, injectedSpec);

          // Injecting the docs endpoint must not change the outcome.
          expect(withDocs.equivalent).toBe(baseline.equivalent);
          const keysOf = (ops: Operation[]) => ops.map(oracleKey).sort();
          expect(keysOf(withDocs.missingInSpec)).toEqual(
            keysOf(baseline.missingInSpec)
          );
          expect(keysOf(withDocs.missingInRoutes)).toEqual(
            keysOf(baseline.missingInRoutes)
          );

          // The docs endpoint must never appear in any divergence list.
          expect(withDocs.missingInSpec.some(isDocs)).toBe(false);
          expect(withDocs.missingInRoutes.some(isDocs)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('identical route/spec sets (modulo method case) are equivalent', () => {
    fc.assert(
      fc.property(operationsArb, (ops) => {
        // Spec is the same operations with method case flipped.
        const flipped = ops.map((o) => ({
          method:
            o.method === o.method.toUpperCase()
              ? o.method.toLowerCase()
              : o.method.toUpperCase(),
          pathTemplate: o.pathTemplate,
        }));
        const report = checkOpenApiRouteEquivalence(ops, flipped);
        expect(report.equivalent).toBe(true);
        expect(report.missingInSpec).toEqual([]);
        expect(report.missingInRoutes).toEqual([]);
      }),
      { numRuns: 200 }
    );
  });
});

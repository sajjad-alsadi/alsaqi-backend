# Implementation Plan: Backend Consistency Fixes

## Overview

This plan implements six backend-only consistency and cleanup fixes (FIX-BE-1 through FIX-BE-6) for the `alsaqi-backend` repository, plus the cross-cutting no-regression gate. The work is sequenced per the design's execution ordering: synchronize the shared models first (FIX-BE-1), then perform dead/duplicate code cleanup (FIX-BE-2, FIX-BE-3, FIX-BE-4), then expand the typed-contract coverage (FIX-BE-5), and finally produce the unification strategy document (FIX-BE-6). Each destructive step is gated by a reference-before-delete check, and every fix ends with the same gate: `npm run build` (zero errors) and the full test suite (zero failures), with the runtime API contract (envelope `{ success, data, meta }` and `X-API-Version: 1.0`) preserved throughout.

## Tasks

- [x] 1. Synchronize the shared Models_File (FIX-BE-1)
  - [x] 1.1 Append the Dashboard Stats and User Management interface blocks to `packages/shared/src/types/models.ts`
    - Append `AuditProgressByType`, `RiskLevelBreakdown`, `DashboardStats`, `Role`, `Permission`, `UserSession`, `JobTitle`, `UserManagementSettings` verbatim, with exact field names, types, optionality, comments, declaration ordering, and whitespace from `docs/consistency-fixes-backend.md` / the Frontend copy
    - Preserve all pre-existing declarations without removal or modification (the new blocks are purely additive)
    - Confirm the 8 interfaces are re-exported via the existing `export * from './types/models'` in `packages/shared/src/index.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12_

  - [x] 1.2 Write unit tests for the synchronized Models_File
    - Import test asserting all 8 new interfaces are exported from the package root
    - Byte-for-byte comparison test asserting the Backend `models.ts` is identical to the Frontend copy (comments, ordering, whitespace included)
    - _Requirements: 1.11_

- [x] 2. Delete the dead Setup_Routes code (FIX-BE-2)
  - [x] 2.1 Migrate `apiVersioning.test.ts` off `setupRoutes` and relocate version constants
    - Perform a workspace-wide static search of production sources (excluding `*.test.ts` and `__tests__/`) for imports of `setupRoutes`, `CURRENT_API_VERSION`, `SUPPORTED_VERSIONS`; if any production reference exists, abort and report the paths
    - Rebuild the test app in `src/routes/__tests__/apiVersioning.test.ts` from `createV1Router` (mount under `/api/v1`, replicate the version-fallback / `X-API-Version` middleware), preserving all existing assertions
    - Move `CURRENT_API_VERSION` / `SUPPORTED_VERSIONS` to a non-deleted constants module (or inline them in the test) so zero references to the dead module remain
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 Delete `src/routes/index.ts` after confirming zero references
    - Verify zero production and zero test references to `setupRoutes` remain, then delete the Dead_Routes_File
    - Run a static-search smoke check confirming no remaining references to the deleted symbols/file
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 2.3 Write guard test for the abort-on-reference branch
    - Test asserting that when a production reference to `setupRoutes` is present, the deletion aborts and the file is retained
    - _Requirements: 2.2_

- [x] 3. Remove the orphaned regulatory route file (FIX-BE-3)
  - [x] 3.1 Verify the CRUD path and delete `regulatory.ts` plus `RegulatoryService.ts`
    - Confirm `central-bank-instructions` is served by `createCrudRoutes` (`generateRoutes("central_bank_instructions", ...)`) with non-`501` success responses
    - Verify no router mounts `createRegulatoryRoutes`; if any router mounts it, abort and report which router
    - Delete `src/routes/regulatory.ts` and `src/services/RegulatoryService.ts` (used only by the orphaned route), leaving zero references to either; run a static-search smoke check
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7_

  - [x] 3.2 Write integration test for central-bank-instructions via the live router
    - Drive `GET`/`POST /central-bank-instructions` through `createV1Router` and assert a non-`501` success response inside the API_Envelope
    - _Requirements: 3.1_

  - [x] 3.3 Write guard test for the abort-on-mount branch
    - Test asserting that when a router still mounts the orphaned file, the deletion aborts and the file is retained
    - _Requirements: 3.3_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Resolve the duplicate `/roles/:id/permissions` registration (FIX-BE-4)
  - [x] 5.1 Consolidate route ownership into `permissionAdmin.ts`
    - In `src/routes/permissionAdmin.ts`, expose the write op as `POST /roles/:id/permissions` only (remove the `PUT` variant), preserving the existing permission-matrix update logic, `ModuleRegistry` validation, audit logging, and rollback; keep the matrix-read `GET /roles/:id/permissions`
    - In `src/routes/roles.ts`, remove the `GET` and `POST /roles/:id/permissions` registrations; retain other routes (`GET /roles`, `GET /permissions`)
    - Ensure valid id + valid payload persists and returns success in the envelope; non-existent id returns a not-found error in the envelope without modifying stored permissions; invalid payload returns a validation error in the envelope retaining existing permissions
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10_

  - [x] 5.2 Write route-registry tests for the consolidated route
    - Assert `GET` and the write op for `/roles/:id/permissions` each resolve to exactly one source and that `PUT` is no longer registered; assert `logDuplicateRoutes` / `routeRegistry` reports zero duplicates
    - _Requirements: 4.1, 4.2, 4.3, 4.8_

  - [x] 5.3 Write behavior tests for the consolidated `POST` handler
    - Cover valid update (persist + success envelope), non-existent role id (not-found, no mutation), and invalid payload (validation error, permissions unchanged); confirm the preserved matrix/audit logic path executes
    - _Requirements: 4.4, 4.5, 4.6, 4.7_

- [x] 6. Close the typed-contract coverage gap (FIX-BE-5)
  - [x] 6.1 Add the missing `/v1/risk-register` validator
    - Create `packages/shared/src/validators/risk-register.ts` (Zod schema + inferred input type) authored against the live `risk-register` response shape; retain the existing endpoint contract
    - _Requirements: 5.1_

  - [x] 6.2 Add the `/v1/central-bank-instructions` contract and validator
    - Create the endpoint contract (`'METHOD /path'`-keyed interface) and the Zod validator schema + inferred type against the CRUD generator's response shape
    - _Requirements: 5.2_

  - [x] 6.3 Add the `/v1/dashboard-stats` contract and validator
    - Create the endpoint contract typing `GET /dashboard-stats` with `response: DashboardStats`, and a response-validation Zod schema matching `DashboardService` output
    - _Requirements: 5.3_

  - [x] 6.4 Add contracts and validators for the user-management endpoints
    - Create endpoint contract + Zod validator for each of `/v1/users/init`, `/v1/users/summary`, `/v1/user-management-settings`, `/v1/login-history`, `/v1/audit-trail`, `/v1/permissions`, `/v1/roles/:id/permissions` (none omitted), authored against their live response shapes (e.g., `Permission[]`, `UserManagementSettings`, `UserSession[]`, the permission-matrix object)
    - _Requirements: 5.4_

  - [x] 6.5 Wire up exports for all new contracts and validators
    - Re-export each new endpoint contract from `packages/shared/src/types/endpoints/index.ts` and each new validator schema (plus inferred type) from `packages/shared/src/validators/index.ts` so both repositories can import them by name
    - _Requirements: 5.5, 5.6, 5.9, 5.10_

  - [x] 6.6 Write property test: valid response bodies satisfy their validator schema
    - **Property 1: Valid response bodies satisfy their validator schema**
    - **Validates: Requirements 5.7**
    - Use `fast-check` + Vitest, minimum 100 iterations; for each new validator generate valid response objects (optional fields present/absent, arbitrary array sizes) and assert `schema.safeParse(obj).success === true`
    - Tag with `// Feature: backend-consistency-fixes, Property 1`

  - [x] 6.7 Write property test: malformed bodies are rejected with the offending field identified
    - **Property 2: Malformed response bodies are rejected with the offending field identified**
    - **Validates: Requirements 5.8**
    - Use `fast-check` + Vitest, minimum 100 iterations; take a valid object, drop a required field or replace a field with a mismatched type, and assert the parse fails with an issue whose `path` points at the mutated field
    - Tag with `// Feature: backend-consistency-fixes, Property 2`

  - [x] 6.8 Write import tests for the new contracts and validators
    - Assert each new endpoint contract and validator schema is importable by name from the package root
    - _Requirements: 5.5, 5.6_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Document the unified single-source strategy (FIX-BE-6)
  - [x] 8.1 Write the shared-package unification strategy document
    - Create `docs/shared-package-unification-strategy.md` as an architectural decision record: list advantages/disadvantages of all three approaches (published versioned package, git submodule, monorepo) relative to one another; select exactly one with rationale for choosing it over the other two; specify the consumption mechanism for both Backend and Frontend repos; provide an ordered cross-repo migration sequence; state explicitly that adopting it supersedes the FIX-BE-1 manual sync
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 9. Cross-cutting no-regression verification (Requirement 7)
  - [x] 9.1 Extend the backward-compatibility test suite
    - Extend `src/__tests__/backwardCompat.property.test.ts` / `responseEnvelope.property.test.ts` to confirm pre-existing endpoints keep the same path/method/status/shape, the `success` flag (`true` on success, `false` on error), and the `X-API-Version: 1.0` header inside the API_Envelope
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Run `npm run build` (zero errors) and the full test suite (zero failures); ensure all tests pass, ask the user if questions arise.
  - _Requirements: 7.5, 7.6_

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster path, but they validate the design's correctness properties and the no-regression gate.
- Each task references specific granular requirements for traceability.
- The two property tests (6.6, 6.7) cover the only universal "for all inputs" logic in this feature — the FIX-BE-5 validator schemas. All other criteria are compile-time checks, one-shot file operations, route-registry assertions, or middleware-driven behavior, verified by unit/integration/smoke tests.
- Destructive steps (2.2, 3.1) are gated by reference-before-delete checks that abort and retain the file if a blocking reference is found.
- Checkpoints (4, 7, 10) enforce the build + test gate at reasonable breaks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "5.1", "6.1", "6.2", "6.3", "6.4", "8.1"] },
    { "id": 1, "tasks": ["2.2", "6.5"] },
    { "id": 2, "tasks": ["1.2", "2.3", "3.2", "3.3", "5.2", "5.3", "6.6", "6.7", "6.8", "9.1"] }
  ]
}
```

# Requirements Document

## Introduction

This feature covers backend-only consistency and cleanup fixes for the `alsaqi-backend` repository, derived from a frontend ↔ backend consistency review (documented in `docs/consistency-fixes-backend.md`). The goal is to eliminate drift between the manually-copied `packages/shared` package across the two repositories, remove dead and misleading route code, resolve a duplicate route registration, close the typed-contract coverage gap, and define a long-term strategy for unifying the shared package.

These are cleanup and synchronization changes, not behavioral changes. Every endpoint the frontend currently calls must continue to work without regression. All changes must preserve the unified API response envelope (`{ success, data, meta }`) and the `X-API-Version: 1.0` contract that the frontend depends on. Builds (`tsc` / `npm run build`) and existing test suites must pass after each change.

The scope maps to six fixes (FIX-BE-1 through FIX-BE-6), each addressed by one or more requirements below.

## Glossary

- **Backend**: The `alsaqi-backend` repository and its running API server.
- **Frontend**: The `alsaqi-frontend` repository that consumes the Backend API.
- **Shared_Package**: The `packages/shared` package, manually copied (duplicated) in both the Backend and Frontend repositories.
- **Models_File**: The TypeScript file `packages/shared/src/types/models.ts` within the Shared_Package.
- **Live_Router**: The active route tree, entered via `src/main.ts` → `createApiServer` (`src/index.ts`) → `createV1Router` (`src/routes/v1/index.ts`).
- **Dead_Routes_File**: The unused file `src/routes/index.ts` that exports `setupRoutes` and is not part of the Live_Router runtime path.
- **Setup_Routes**: The `setupRoutes` export defined in the Dead_Routes_File.
- **Orphaned_Regulatory_File**: The file `src/routes/regulatory.ts`, which is not mounted in any router and contains a `POST /central-bank-instructions` handler returning `501 Not Implemented`.
- **Crud_Generator**: The generic CRUD route generator `createCrudRoutes` → `generateRoutes`, which serves the `central_bank_instructions` entity at `central-bank-instructions`.
- **Roles_Module**: The route module `src/routes/roles.ts`, which registers `GET` and `POST /roles/:id/permissions`.
- **PermissionAdmin_Module**: The route module `src/routes/permissionAdmin.ts`, which registers `GET` and `PUT /roles/:id/permissions`.
- **Endpoint_Contract**: A typed contract under `packages/shared/src/types/endpoints/*`.
- **Validator_Schema**: A validation schema (Zod) under `packages/shared/src/validators/*`.
- **API_Envelope**: The unified API response structure `{ success, data, meta }`.
- **API_Version_Header**: The HTTP response header `X-API-Version: 1.0`.
- **Build_Process**: The Backend compilation/build step (`tsc` / `npm run build`).
- **Test_Suite**: The existing automated test suites in the Backend repository.

## Requirements

### Requirement 1: Synchronize the shared Models_File (FIX-BE-1)

**User Story:** As a backend developer, I want the Backend copy of the Models_File to contain the same types as the Frontend copy, so that the Shared_Package is a true single source of truth and type drift is eliminated.

#### Acceptance Criteria

1. THE Backend SHALL define and export the interface `DashboardStats` in the Models_File.
2. THE Backend SHALL define and export the interface `AuditProgressByType` in the Models_File.
3. THE Backend SHALL define and export the interface `RiskLevelBreakdown` in the Models_File.
4. THE Backend SHALL define and export the interface `Role` in the Models_File.
5. THE Backend SHALL define and export the interface `Permission` in the Models_File.
6. THE Backend SHALL define and export the interface `UserSession` in the Models_File.
7. THE Backend SHALL define and export the interface `JobTitle` in the Models_File.
8. THE Backend SHALL define and export the interface `UserManagementSettings` in the Models_File.
9. THE Backend SHALL define each added interface with the exact field names, field types, and per-field optionality (`?`) specified in `docs/consistency-fixes-backend.md` (FIX-BE-1), including the nested structure of `DashboardStats` and its references to `AuditProgressByType` and `RiskLevelBreakdown`.
10. THE Backend SHALL preserve all pre-existing types in the Models_File without removal or modification.
11. WHEN the Backend Models_File is compared byte-for-byte with the Frontend Models_File, THE Backend Models_File SHALL have zero differing bytes from the Frontend Models_File, including comments, declaration ordering, and whitespace.
12. WHEN the Shared_Package TypeScript build (`tsc`) is executed after the interfaces are added, THE Build_Process SHALL complete with zero compilation errors.

### Requirement 2: Delete the dead Setup_Routes code (FIX-BE-2)

**User Story:** As a backend developer, I want the unused Setup_Routes code removed, so that there is no risk of editing the wrong (non-live) router file.

#### Acceptance Criteria

1. WHEN the Dead_Routes_File deletion task is initiated, THE Backend SHALL perform a workspace-wide static search of all production source files (all files excluding files matching test patterns such as `*.test.ts` and `__tests__` directories) for any import or require reference to Setup_Routes, and record the complete list of matching file paths.
2. IF the production source search returns one or more files referencing Setup_Routes, THEN THE Backend SHALL abort the deletion, retain the Dead_Routes_File unchanged, and report an error indicating that production references still exist along with the referencing file paths.
3. WHEN the production source search returns zero references AND any Test_Suite file (e.g., `src/routes/__tests__/apiVersioning.test.ts`) imports Setup_Routes, THE Backend SHALL migrate each such test to use `createV1Router` before the Dead_Routes_File is deleted, preserving the existing test assertions and resulting in zero remaining references to Setup_Routes across all test files.
4. WHEN zero production source files and zero test files reference Setup_Routes, THE Backend SHALL delete the Dead_Routes_File.
5. WHEN the Build_Process is executed after the Dead_Routes_File is deleted, THE Build_Process SHALL complete with zero compilation errors.
6. WHEN the Test_Suite is executed after the Dead_Routes_File is deleted, THE Test_Suite SHALL complete with zero failed tests and zero unresolved module-resolution errors referencing the deleted Dead_Routes_File.

### Requirement 3: Remove the orphaned regulatory route file (FIX-BE-3)

**User Story:** As a backend developer, I want the misleading Orphaned_Regulatory_File removed, so that the `central_bank_instructions` entity has a single unambiguous implementation through the Crud_Generator.

#### Acceptance Criteria

1. THE Backend SHALL continue to serve the `central_bank_instructions` entity at the path `central-bank-instructions` through the Crud_Generator, returning a successful (non-`501`) response for supported methods.
2. WHEN the Orphaned_Regulatory_File removal task is initiated, THE Backend SHALL verify that no router mounts the Orphaned_Regulatory_File and record the verification result.
3. IF any router still mounts the Orphaned_Regulatory_File, THEN THE Backend SHALL abort the deletion, retain the file unchanged, and report an error indicating which router mounts it.
4. WHEN the Orphaned_Regulatory_File is removed, THE Backend SHALL also remove any service code that becomes unused as a result, such that there are zero remaining references to the removed file and the removed service code.
5. WHERE a dedicated regulatory route is intended to replace the Crud_Generator path, THE Backend SHALL mount the regulatory route in `createV1Router` and implement the `POST /central-bank-instructions` handler to return a success response within the API_Envelope instead of `501 Not Implemented`.
6. WHEN the Build_Process is executed after the Orphaned_Regulatory_File is removed, THE Build_Process SHALL complete with zero compilation errors.
7. WHEN the Test_Suite is executed after the Orphaned_Regulatory_File is removed, THE Test_Suite SHALL complete with zero failing tests.

### Requirement 4: Resolve the duplicate `/roles/:id/permissions` registration (FIX-BE-4)

**User Story:** As a backend developer, I want a single module to own the `/roles/:id/permissions` route, so that there is one unambiguous source of truth for role permission updates.

#### Acceptance Criteria

1. THE Backend SHALL register the `GET /roles/:id/permissions` route in exactly one route module.
2. THE Backend SHALL register the write operation for `/roles/:id/permissions` in exactly one route module.
3. THE Backend SHALL expose the `/roles/:id/permissions` write operation using the `POST` verb only, matching the verb the Frontend calls, and SHALL NOT expose a second verb (such as `PUT`) for the same write operation.
4. THE Backend SHALL preserve the permission-matrix update logic currently in `permissionAdmin.ts` within the consolidated `POST` route, such that the consolidated route applies the same permission resolution behavior that existed before consolidation.
5. WHEN a Frontend `POST /roles/:id/permissions` request supplies a valid role id and a valid permissions payload, THE Backend SHALL persist the updated permissions and return a success response within the API_Envelope.
6. IF a `POST /roles/:id/permissions` request references a role id that does not exist, THEN THE Backend SHALL reject the request with an error response within the API_Envelope indicating the role was not found, and SHALL NOT modify any stored permissions.
7. IF a `POST /roles/:id/permissions` request supplies an invalid or malformed permissions payload, THEN THE Backend SHALL reject the request with an error response within the API_Envelope indicating the validation failure, and SHALL retain the role's existing permissions unchanged.
8. WHEN the duplicate-route detection utility (`logDuplicateRoutes` / `routeRegistry`) runs after consolidation, THE Backend SHALL report zero duplicate registrations for both `GET /roles/:id/permissions` and `POST /roles/:id/permissions`.
9. WHEN the Build_Process is executed after consolidation, THE Build_Process SHALL complete with zero compilation errors.
10. WHEN the Test_Suite is executed after consolidation, THE Test_Suite SHALL complete with zero failing tests.

### Requirement 5: Close the typed-contract coverage gap (FIX-BE-5)

**User Story:** As a backend developer, I want shared Endpoint_Contracts and Validator_Schemas for the endpoints currently lacking them, so that both repositories consume a single documented contract instead of locally-defined schemas.

#### Acceptance Criteria

1. THE Backend SHALL add an Endpoint_Contract and a Validator_Schema for `/v1/risk-register` in the Shared_Package.
2. THE Backend SHALL add an Endpoint_Contract and a Validator_Schema for `/v1/central-bank-instructions` in the Shared_Package.
3. THE Backend SHALL add an Endpoint_Contract and a Validator_Schema for `/v1/dashboard-stats` in the Shared_Package.
4. THE Backend SHALL add an Endpoint_Contract and a Validator_Schema for each of the user-management endpoints `/v1/users/init`, `/v1/users/summary`, `/v1/user-management-settings`, `/v1/login-history`, `/v1/audit-trail`, `/v1/permissions`, and `/v1/roles/:id/permissions` in the Shared_Package, with no endpoint in this list omitted.
5. THE Backend SHALL export each added Endpoint_Contract from the Shared_Package endpoints index such that both repositories can import it by name.
6. THE Backend SHALL export each added Validator_Schema from the Shared_Package validators index such that both repositories can import it by name.
7. WHEN a corresponding live endpoint's successful HTTP 200 response body is validated against its added Validator_Schema, THE Validator_Schema SHALL produce zero validation errors.
8. IF a response body is missing a required field or contains a field with a mismatched type, THEN the corresponding Validator_Schema SHALL produce a validation error identifying the failing field.
9. WHEN the Build_Process is executed after the contracts and schemas are added, THE Build_Process SHALL terminate with a success exit status and report zero compilation errors.
10. WHEN the Test_Suite is executed after the contracts and schemas are added, THE Test_Suite SHALL complete with zero failing tests.

### Requirement 6: Define a unified single-source strategy for the Shared_Package (FIX-BE-6)

**User Story:** As a backend maintainer, I want a documented decision for unifying the Shared_Package as a single source of truth, so that manual-copy drift is eliminated at the root in the long term.

#### Acceptance Criteria

1. THE Backend SHALL produce a documented recommendation that selects exactly one unification approach from the set of three candidate approaches (a published versioned package, a git submodule, or a monorepo) and that states the evaluation rationale justifying why the selected approach was chosen over the other two.
2. THE Backend recommendation SHALL document, for each of the three candidate approaches, its advantages and its disadvantages relative to the other two approaches.
3. THE Backend recommendation SHALL specify, for both the Backend repository and the Frontend repository, the mechanism by which each repository consumes the Shared_Package under the selected approach.
4. THE Backend recommendation SHALL provide the migration steps required to adopt the selected approach as an ordered sequence that covers both the Backend repository and the Frontend repository.
5. THE Backend recommendation SHALL state that, once the selected approach is adopted, it eliminates the manual synchronization of the Shared_Package performed in Requirement 1.

### Requirement 7: Preserve the API contract and prevent regressions (cross-cutting constraint)

**User Story:** As a frontend developer, I want the Backend cleanup changes to leave the runtime API contract unchanged, so that the Frontend continues to work without any behavioral regression.

#### Acceptance Criteria

1. WHEN the Backend returns a successful API response after all fixes are applied, THE Backend SHALL wrap it in the API_Envelope with the `success` flag set to `true`.
2. THE Backend SHALL set the API_Version_Header to `X-API-Version: 1.0` on every API response after all fixes are applied.
3. WHEN the Frontend calls any endpoint that existed before these fixes, THE Backend SHALL respond with the same route path, the same HTTP method, the same HTTP status code, and the same response shape (field names, field types, and nesting within the API_Envelope) as before the fixes.
4. IF a request results in an error after all fixes are applied, THEN THE Backend SHALL wrap the error response in the API_Envelope with the `success` flag set to `false` and SHALL include the API_Version_Header.
5. WHEN the Build_Process is executed after each fix is applied, THE Build_Process SHALL complete with zero compilation errors.
6. WHEN the Test_Suite is executed after each fix is applied, THE Test_Suite SHALL complete with zero failing tests.

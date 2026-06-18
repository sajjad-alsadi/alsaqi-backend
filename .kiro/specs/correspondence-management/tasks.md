# Implementation Plan: Correspondence Management

## Overview

This plan hardens the Correspondence module API by introducing centralized enum constants in the shared package, updating route-level and shared validator Zod schemas to use `z.enum()`, adding 404 detection in the service layer for update/delete operations, and implementing type-aware status validation. The implementation is incremental — shared constants first, then route schemas, then service-layer 404 handling, then tests.

## Tasks

- [x] 1. Create shared enum constants
  - [x] 1.1 Create `packages/shared/src/constants/correspondence.ts` with all enum constant arrays
    - Export `INCOMING_STATUSES`, `OUTGOING_STATUSES`, `PRIORITIES`, `CLASSIFICATIONS`, `METHODS`, `ENTITY_TYPES`, `REFERRAL_STATUSES`, `LINK_TYPES` as `const` tuples
    - Export derived TypeScript types (`IncomingStatus`, `OutgoingStatus`, `Priority`, etc.)
    - _Requirements: 9.1, 9.2_

  - [x] 1.2 Re-export correspondence constants from `packages/shared/src/constants/index.ts`
    - Add `export * from './correspondence'` to the shared constants barrel file
    - Verify the constants are accessible via `@alsaqi/shared`
    - _Requirements: 9.1, 9.3_

- [x] 2. Update shared package validators to use enum constants
  - [x] 2.1 Update `packages/shared/src/validators/correspondence.ts` to use `z.enum()` with shared constants
    - Replace `z.string().min(1).max(50).optional()` for `sender_entity_type` with `z.enum(ENTITY_TYPES).optional()`
    - Replace `z.string()` for `classification` with `z.enum(CLASSIFICATIONS).optional()`
    - Replace `z.string()` for `priority` with `z.enum(PRIORITIES).optional()`
    - Replace `z.string()` for `method` with `z.enum(METHODS).optional()`
    - Replace `z.string()` for `sending_method` in outgoing schema with `z.enum(METHODS).optional()`
    - Replace `z.string()` for `link_type` in link schema with `z.enum(LINK_TYPES).optional().default('Reply')`
    - _Requirements: 9.3, 1.6, 2.4, 4.2_

  - [ ]* 2.2 Write unit tests for shared validators
    - Test that valid enum values pass validation
    - Test that invalid enum values are rejected with appropriate error messages
    - Test that optional enum fields can be omitted
    - _Requirements: 1.6, 2.4, 9.3_

- [x] 3. Update route-level Zod schemas with enum constraints
  - [x] 3.1 Update `src/routes/correspondence.ts` — incoming and outgoing schemas
    - Import enum constants from `@alsaqi/shared`
    - Replace `incomingSchema` enum fields to use `z.enum(ENTITY_TYPES)`, `z.enum(CLASSIFICATIONS)`, `z.enum(PRIORITIES)`, `z.enum(METHODS)`
    - Replace `outgoingSchema` enum fields to use `z.enum(CLASSIFICATIONS)`, `z.enum(METHODS)`
    - Replace `linkSchema.link_type` with `z.enum(LINK_TYPES).optional().default('Reply')`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 4.1_

  - [x] 3.2 Update `src/routes/correspondence.ts` — type-aware status update schemas
    - Replace single `statusUpdateSchema` with `incomingStatusUpdateSchema` using `z.enum(INCOMING_STATUSES)` and `outgoingStatusUpdateSchema` using `z.enum(OUTGOING_STATUSES)`
    - Update the `PUT /status/:type/:id` handler to select the correct schema based on `req.params.type`
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ]* 3.3 Write property test for invalid enum rejection (Property 1)
    - **Property 1: Invalid enum values are rejected**
    - Generate random strings NOT in each enum set and verify HTTP 400 with `error.code === 'VALIDATION_ERROR'` and field-level details
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 4.1**

  - [ ]* 3.4 Write property test for valid enum acceptance (Property 2)
    - **Property 2: Valid enum values are accepted**
    - Generate values from each enum's allowed set and verify no enum validation failure occurs
    - **Validates: Requirements 1.6, 2.4, 3.3, 4.2**

- [x] 4. Checkpoint - Validate enum schemas
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement service-layer 404 detection
  - [x] 5.1 Update `CorrespondenceService.updateIncoming` to throw `NotFoundError` when zero rows affected
    - Check the result of the UPDATE query for affected row count
    - Throw `NotFoundError('Incoming correspondence record not found')` when result indicates no rows updated
    - _Requirements: 5.1_

  - [x] 5.2 Update `CorrespondenceService.deleteIncoming` to throw `NotFoundError` when zero rows affected
    - Check the result of the soft-delete UPDATE for affected row count
    - Throw `NotFoundError('Incoming correspondence record not found')` when no rows are soft-deleted
    - _Requirements: 5.2_

  - [x] 5.3 Update `CorrespondenceService.updateOutgoing` to throw `NotFoundError` when zero rows affected
    - Check the result of the UPDATE query for affected row count
    - Throw `NotFoundError('Outgoing correspondence record not found')` when result indicates no rows updated
    - _Requirements: 6.1_

  - [x] 5.4 Update `CorrespondenceService.deleteOutgoing` to throw `NotFoundError` when zero rows affected
    - Check the result of the soft-delete UPDATE for affected row count
    - Throw `NotFoundError('Outgoing correspondence record not found')` when no rows are soft-deleted
    - _Requirements: 6.2_

  - [x] 5.5 Verify `CorrespondenceService.getDetails` already throws `NotFoundError` for missing records
    - Confirm the existing `if (!record) throw new NotFoundError(...)` in `getDetails` covers both incoming and outgoing types
    - _Requirements: 5.3, 6.3_

  - [ ]* 5.6 Write property test for 404 response structure (Property 3)
    - **Property 3: 404 response structure invariant**
    - For any request targeting a non-existent UUID, verify HTTP 404 with `success === false`, `error.code === 'NOT_FOUND'`, and non-empty `error.message`
    - **Validates: Requirements 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3**

  - [ ]* 5.7 Write property test for validation error structure (Property 4)
    - **Property 4: Validation error response structure invariant**
    - For any request failing enum validation, verify HTTP 400 with `success === false`, `error.code === 'VALIDATION_ERROR'`, non-empty `error.message`, and `error.details` array with `path`, `message`, and `code` fields
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [x] 6. Checkpoint - Validate 404 handling
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Synchronization verification
  - [x] 7.1 Write property test for shared validator and route schema synchronization (Property 5)
    - **Property 5: Shared validator and route schema synchronization**
    - For each enum field, assert the set of values accepted by the route-level schema equals the set accepted by the shared validator schema
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 7.2 Rebuild the shared package and run type checking
    - Run `npm run typecheck` to confirm no type errors from the refactored schemas
    - Verify `@alsaqi/shared` dist output includes the new constants
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The design uses TypeScript throughout — all code examples use TypeScript
- The existing `NotFoundError` class and global error handler already produce the correct envelope; only the service methods need row-count checks
- The shared package must be rebuilt (`packages/shared`) after changes so that `@alsaqi/shared` re-exports are available to the backend

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "3.2"] },
    { "id": 4, "tasks": ["3.3", "3.4"] },
    { "id": 5, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 6, "tasks": ["5.6", "5.7"] },
    { "id": 7, "tasks": ["7.1", "7.2"] }
  ]
}
```

# Implementation Plan: Backend Security Hardening

## Overview

This plan converts the design into incremental TypeScript coding steps for the `alsaqi-backend`
service. Work proceeds concern-by-concern (database safety → auth gating → CRUD safety → audit
integrity → auth service → secure files → resilience → error handling & consolidation), building
pure, testable helpers first and wiring them into the existing services and middleware after.
Each property from the design's Correctness Properties section is implemented as a single
`fast-check` + Vitest property test (≥ 100 iterations) and tagged with its property number.
Optional sub-tasks (marked `*`) are tests that can be deferred for a faster MVP.

## Tasks

- [x] 1. Establish configuration model foundation
  - [x] 1.1 Add typed environment-config accessors
    - Create a typed config module exposing the environment variables from the design's
      Configuration model (`DB_POOL_MAX`, `DB_POOL_ACQUIRE_TIMEOUT_MS`, `FILE_ACCESS_SECRET`,
      `FILE_SIGNED_URL_MAX_TTL_S`, `FILE_STREAM_THRESHOLD_BYTES`, `AUTH_RATE_LIMIT_MAX`,
      `AUTH_RATE_LIMIT_WINDOW_S`, `API_PREFIX`, `QUEUE_FAILED_RETENTION`, `PDF_JOB_TIMEOUT_S`,
      `SHUTDOWN_DRAIN_TIMEOUT_MS`) with documented defaults
    - No `any` in public signatures; export explicit interfaces
    - _Requirements: 2.1, 2.2, 9.1, 11.4, 12.3, 18.1, 19.1, 21.1, 22.1, 23.2_

- [x] 2. Harden the database layer (fail-fast config and configurable pool)
  - [x] 2.1 Implement pure pool/URL config helpers
    - Create `src/db/poolConfig.ts` with `classifyDatabaseUrl`, `parsePoolConfig`, and
      `isEmbeddedDbAllowed` as pure functions returning typed success/error results
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3_

  - [x] 2.2 Write property test for DATABASE_URL classification
    - **Property 1: DATABASE_URL classification**
    - **Validates: Requirements 1.1, 1.4**

  - [x] 2.3 Write property test for embedded-DB permission
    - **Property 2: Embedded-DB permission is independent of environment**
    - **Validates: Requirements 1.2, 1.3**

  - [x] 2.4 Write property test for pool configuration parsing
    - **Property 3: Pool configuration parsing and validation**
    - **Validates: Requirements 1.6, 2.1, 2.2, 2.3**

  - [x] 2.5 Wire fail-fast startup and configurable pool into `initDb`
    - Use `classifyDatabaseUrl`/`isEmbeddedDbAllowed` to refuse PGlite in production, exit non-zero
      on invalid `DATABASE_URL`, enforce the 30s external-connect budget, and build `pg.Pool` from
      `parsePoolConfig`; surface pool-acquisition timeouts as returned errors
    - Invert the production dependency check so unset/whitespace `DATABASE_URL`/`REDIS_URL` fail
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.3, 2.4_

  - [x] 2.6 Add explicit types to the DB client and query wrapper
    - Declare `IDBWrapper`, `DBWrapper`, `getPool`, and prepared-statement shapes with no `any` in
      public signatures
    - _Requirements: 26.1, 26.3, 26.4_

  - [x] 2.7 Write integration tests for DB fail-fast and pool timeout
    - Verify non-zero exit on failed external connect within budget and pool-acquisition-timeout error
    - _Requirements: 1.5, 2.4_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement path-safe authentication gating
  - [x] 4.1 Implement pure path-gate helpers
    - Create `src/middleware/pathGate.ts` with `canonicalizePath` (percent-decode, resolve `.`/`..`,
      strip single trailing slash) and `isPathAllowed` (exact or segment-boundary prefix only)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Write property test for path canonicalization
    - **Property 4: Path canonicalization**
    - **Validates: Requirements 3.3**

  - [x] 4.3 Write property test for allowed-path matching
    - **Property 5: Allowed-path matching is exact or segment-boundary prefix only**
    - **Validates: Requirements 3.1, 3.2, 3.4**

  - [x] 4.4 Integrate the path gate into `Auth_Middleware`
    - Gate on `req.path` only (never `originalUrl`/query); allow password-change and `/auth/logout`;
      deny non-allowed routes with `PASSWORD_CHANGE_REQUIRED`; use typed `Request`/`Response`/
      `NextFunction` and `AuthenticatedRequest` (no `any`)
    - _Requirements: 3.1, 3.2, 3.5, 3.6, 26.2_

  - [x] 4.5 Write unit tests for query-string and segment-boundary bypass attempts
    - Cover `?x=/auth/logout` and `/auth/logout-evil` denial cases
    - _Requirements: 3.4, 3.5, 3.6_

- [x] 5. Implement CRUD safety in `Base_Service`
  - [x] 5.1 Implement schema-driven column whitelist
    - Create `src/services/columnWhitelist.ts` with `TABLE_WRITE_SCHEMAS`, `getColumnWhitelist`
      (derived from Zod `schema.shape`), and pure `checkWhitelist`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.2 Write property test for column whitelist derivation
    - **Property 6: Column whitelist equals schema field set**
    - **Validates: Requirements 4.2**

  - [x] 5.3 Write property test for mass-assignment rejection
    - **Property 7: Mass-assignment rejection**
    - **Validates: Requirements 4.1, 4.3, 4.4**

  - [x] 5.4 Implement configurable search columns
    - Create `src/services/searchColumns.ts` with `TABLE_SEARCH_COLUMNS`, `getSearchColumns`, and
      `buildSearchClause` returning `null` when no columns/empty term; remove the
      `title`/`name`/`description` fallback
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 5.5 Write property test for search clause column restriction
    - **Property 8: Search clause uses only configured columns**
    - **Validates: Requirements 5.1, 5.2, 5.4**

  - [x] 5.6 Extend keyset pagination
    - Extend `cursorPagination.ts` with composite deterministic order keys, `KEYSET_TABLES`,
      page-size clamping (1..100, default 25), opaque base64url cursor encode/decode, and
      invalid-cursor rejection
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_

  - [x] 5.7 Write property test for keyset pagination round-trip
    - **Property 9: Keyset pagination round-trip**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x] 5.8 Write property test for malformed cursor rejection
    - **Property 10: Malformed cursor rejection**
    - **Validates: Requirements 6.6**

  - [x] 5.9 Implement consistent soft-delete in `Base_Service`
    - Change default `delete` to `deleted_at = now()` UPDATE for tables with the column; add an
      `includeDeleted` option and a distinctly named `hardDelete` never called by the default path
    - _Requirements: 25.1, 25.2, 25.3, 25.5_

  - [x] 5.10 Write property test for the soft-delete invariant
    - **Property 33: Soft-delete invariant**
    - **Validates: Requirements 25.1, 25.2, 25.3**

  - [x] 5.11 Wire whitelist, search, and keyset pagination into `Base_Service`
    - `create`/`update` reject the entire request (naming non-permitted keys) on any non-whitelisted
      top-level key; `findAll` uses `buildSearchClause` and keyset pagination for configured tables
      and an estimated/cached total count (≤ 60s) instead of per-request `COUNT(*)`
    - _Requirements: 4.3, 4.4, 4.5, 5.2, 5.3, 6.5_

  - [x] 5.12 Write unit tests for soft-delete and count edge cases
    - Already-soft-deleted delete returns not-found and preserves `deleted_at`; large-table count
      uses an estimate/cache rather than `COUNT(*)`
    - _Requirements: 6.5, 25.4, 25.5_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Consolidate and harden the audit hash-chain
  - [x] 7.1 Implement the single `AuditChainService`
    - Create `src/services/AuditChainService.ts` with `append` (advisory-lock/serialized
      read-prev-hash → compute → insert in one transaction) and `verifyChain`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 7.2 Write property test for chain linearity under concurrency
    - **Property 11: Audit chain remains linear under concurrency**
    - **Validates: Requirements 7.2, 7.3**

  - [x] 7.3 Write property test for append-then-verify round trip
    - **Property 12: Append-then-verify round trip**
    - **Validates: Requirements 7.4**

  - [x] 7.4 Write property test for corruption detection
    - **Property 13: Corruption detection identifies the first offender**
    - **Validates: Requirements 7.6**

  - [x] 7.5 Write property test for append atomicity
    - **Property 14: Append atomicity**
    - **Validates: Requirements 7.5**

  - [x] 7.6 Delegate all audit appends to `AuditChainService`
    - Replace `BaseService.logAudit` and `AuthService.logAudit` hash-chain writers with calls to the
      single `AuditChainService.append`; remove the duplicated writers
    - _Requirements: 7.1, 27.1, 27.4_

  - [x] 7.7 Write a guard test for a single audit-append implementation
    - Static-analysis test failing the build if more than one audit-append implementation exists
    - _Requirements: 27.1, 27.5_

- [x] 8. Harden the `Auth_Service` and auth middleware
  - [x] 8.1 Implement non-blocking password verification helpers
    - Create `src/services/passwordVerifier.ts` with async `verifyPassword` (never `compareSync`),
      `DUMMY_HASH`, and `bcryptCostFactor`
    - _Requirements: 14.1, 14.2, 15.1, 15.5_

  - [x] 8.2 Write a smoke test asserting no synchronous bcrypt in the login path
    - Assert `verifyPassword` uses async `bcrypt.compare` and `compareSync` does not appear in the path
    - _Requirements: 14.1_

  - [x] 8.3 Rework the login flow for non-blocking, anti-enumeration behavior
    - Use `await verifyPassword`; compare against `DUMMY_HASH` for unknown accounts; unify
      unknown/wrong-password/suspended/locked into one byte-identical `InvalidCredentialsError`
      response; roll back the transaction on verification rejection without crashing
    - _Requirements: 14.4, 14.5, 15.1, 15.2, 15.3, 15.5_

  - [x] 8.4 Write property test for uniform login failure response
    - **Property 23: Uniform login failure response**
    - **Validates: Requirements 15.2, 15.3**

  - [x] 8.5 Make lockout notifications parameterized and transactional
    - Bind the admin `role` query parameter; insert exactly one row per active admin inside the
      lockout transaction; zero rows without error when no active admin; roll back notification rows
      on failure while preserving lockout state
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 8.6 Write property test for lockout notification count
    - **Property 15: Lockout notification count equals active-admin count**
    - **Validates: Requirements 8.1, 8.3, 8.4**

  - [x] 8.7 Write property test for lockout notification atomicity
    - **Property 16: Lockout notification atomicity**
    - **Validates: Requirements 8.5**

  - [x] 8.8 Implement refresh-token hashing at rest
    - Add `hashRefreshToken` (SHA-256 hex); persist only the hash; validate by hashing and
      full-length comparison; reject absent/empty/>4096-char tokens without hashing; abort
      persistence on hashing failure without storing plaintext
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 8.9 Write property test for refresh-token hashing round trip
    - **Property 24: Refresh-token hashing round trip**
    - **Validates: Requirements 17.1, 17.2**

  - [x] 8.10 Write property test for refresh-token mismatch rejection
    - **Property 25: Refresh-token mismatch rejection**
    - **Validates: Requirements 17.3**

  - [x] 8.11 Implement configurable refresh-cookie path
    - Add `buildRefreshCookiePath(apiPrefix, refreshRoute)` with default-prefix fallback for
      absent/empty/whitespace values and one-leading/no-trailing-slash normalization; compute from
      the current configured prefix at issuance
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5_

  - [x] 8.12 Write property test for refresh cookie path normalization
    - **Property 27: Refresh cookie path normalization**
    - **Validates: Requirements 19.1, 19.3, 19.4**

  - [x] 8.13 Re-key the auth rate limiter to source IP
    - Re-key `authLimiter` from `ip_username` to source IP only; configurable limit (10) and window
      (900s); reject over-limit attempts without evaluating credentials and include seconds remaining
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [x] 8.14 Write property test for per-source-IP rate-limit keying
    - **Property 26: Rate-limit keying is per source IP across usernames**
    - **Validates: Requirements 18.1**

  - [x] 8.15 Consolidate auth cache invalidation
    - Add a canonical `AuthCacheInvalidator.invalidate(userId)` called from every suspend/disable and
      role/permission-change path; retry up to 3 times then force DB re-read and record an error;
      `authenticate` re-reads from the authoritative store and denies when it is unreachable
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 8.16 Write unit/integration tests for cache invalidation and rate-limit window
    - Invalidation within 1s with fresh re-read; deny on unreachable store; rate-limit blocking and
      window reset
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 18.2, 18.3, 18.4_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Secure file signing, containment, streaming, and denial logging
  - [x] 10.1 Isolate the file-access secret and tighten TTL in `Secure_File_Service`
    - Replace `getSecret()` with `assertConfigured()` + internal `requireSecret()` reading only
      `FILE_ACCESS_SECRET` (no JWT/hardcoded fallback); reduce `clampTtl` max to 900s; sign/verify
      with `FILE_ACCESS_SECRET`
    - _Requirements: 9.3, 9.4, 9.5, 11.4_

  - [x] 10.2 Write property test for file-access secret validation
    - **Property 17: File-access secret validation**
    - **Validates: Requirements 9.1, 9.2**

  - [x] 10.3 Write property test for signature binding to the current secret
    - **Property 18: Signature verification is bound to the current file-access secret**
    - **Validates: Requirements 9.4, 9.5**

  - [x] 10.4 Write property test for issued TTL bound
    - **Property 19: Issued TTL never exceeds the configured maximum**
    - **Validates: Requirements 11.4**

  - [x] 10.5 Write a smoke test for absence of a hardcoded fallback secret
    - Assert no hardcoded/default/example secret value exists in `Secure_File_Service`
    - _Requirements: 9.3_

  - [x] 10.6 Implement pure path-containment helper
    - Create `src/middleware/pathContainment.ts` with `checkContainment` (resolve canonical absolute
      path, deref symlinks, separator-aware prefix check rejecting siblings like `uploads_backup`)
    - _Requirements: 10.1, 10.2, 10.4_

  - [x] 10.7 Write property test for upload-directory containment
    - **Property 20: Upload-directory containment**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [x] 10.8 Add signer re-authorization to `Secure_File_Middleware`
    - Re-evaluate the signer's current status and required permission against live records before
      serving; deny on inactive/missing-permission even when the signature is valid; deny expired/
      invalid signatures; record a server-side security event on containment denial without
      disclosing the path
    - _Requirements: 10.3, 10.5, 11.1, 11.2, 11.3_

  - [x] 10.9 Write property test for signed-URL serving re-checks
    - **Property 21: Signed-URL serving re-checks current signer standing**
    - **Validates: Requirements 11.1, 11.2, 11.3**

  - [x] 10.10 Implement streaming encrypted-file delivery
    - Add `createDecryptStream(fileId)` and rewrite `serveEncryptedFile` to pipe
      `createReadStream → createDecipheriv → res` in ≤ 64 KB chunks; terminate the stream on chunk/
      auth-tag failure; release stream and file handle on client disconnect
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 10.11 Write integration tests for streaming decryption
    - Chunked decryption, bounded memory for large files, tampered-chunk termination, and
      client-disconnect cleanup
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 10.12 Replace the `res.json` monkey-patch with resilient denial logging
    - Remove the `res.json` override; log denials via a `res.on('finish')` listener that inspects
      `res.statusCode`, emitting exactly one categorized entry per denied request with the file
      identifier and an anonymous placeholder user id when unauthenticated; on log-write failure,
      leave status/body unchanged and write a stderr notice
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 10.13 Write property test for categorized denial logging
    - **Property 22: Exactly one categorized denial log entry per denied request**
    - **Validates: Requirements 13.2**

  - [x] 10.14 Wire `assertConfigured` into startup and finalize file middleware
    - Call `Secure_File_Service.assertConfigured()` in the fail-fast startup sequence before binding
      the port; add the `FILE_ACCESS_SECRET` rule (required, non-whitespace, ≥ 32 chars) to
      `secretsValidator`; wire containment + re-auth + streaming + denial logging into the middleware
    - _Requirements: 9.1, 9.2, 10.5, 13.1, 13.4_

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Resilience: transactional events, queues, PDF timeouts, graceful shutdown
  - [x] 12.1 Implement transactional event dispatch
    - Create `src/services/transactionalEvents.ts` (`enqueueEvent`, `flushOnCommit`,
      `discardOnRollback`) backed by `AsyncLocalStorage`; have `BaseService.create/update/delete`
      buffer events; flush after commit (in order, within 5s) and discard on rollback in the
      `DBWrapper.transaction` wrapper
    - _Requirements: 20.1, 20.2, 20.3, 20.5_

  - [x] 12.2 Write property test for transactional event buffering
    - **Property 28: Transactional event buffering**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.5**

  - [x] 12.3 Write integration test for dispatch retry after commit
    - Up to 3 additional attempts and recorded failure without rolling back the committed transaction
    - _Requirements: 20.4_

  - [x] 12.4 Bound failed-job retention in `Queue_Manager`
    - Add `parseFailedJobRetention`; set `removeOnFail: { count }`; reject invalid values, retain the
      previously applied valid limit, and return an error
    - _Requirements: 21.1, 21.3_

  - [x] 12.5 Write property test for failed-job retention parsing
    - **Property 29: Failed-job retention parsing**
    - **Validates: Requirements 21.1, 21.3**

  - [x] 12.6 Write integration test for bounded failed-job eviction
    - Oldest-first eviction down to the configured limit
    - _Requirements: 21.2_

  - [x] 12.7 Enforce PDF job timeouts in `PDF_Worker`
    - Add `parsePdfTimeout` (clamp 5..300s, default 30); race processing against the timeout; abort
      within 1s; return the browser to the pool and close the page within 1s; mark failed with
      elapsed and configured max time
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_

  - [x] 12.8 Write property test for PDF timeout parsing and clamping
    - **Property 30: PDF timeout parsing and clamping**
    - **Validates: Requirements 22.1, 22.2**

  - [x] 12.9 Write integration test for PDF timeout abort and cleanup
    - Abort within 1s, browser/page cleanup, and failure reason content
    - _Requirements: 22.3, 22.4, 22.5_

  - [x] 12.10 Implement graceful shutdown with draining
    - Add `createGracefulShutdown(server, { drainTimeoutMs })` (clamp 1000..120000, default 30000);
      stop accepting connections, drain within timeout (exit 0) or terminate and exit non-zero; route
      `uncaughtException` through the same drain-then-exit path; wire into `main.ts`
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6_

  - [x] 12.11 Write property test for drain-timeout parsing and clamping
    - **Property 31: Drain timeout parsing and clamping**
    - **Validates: Requirements 23.2**

  - [x] 12.12 Write integration test for graceful shutdown behavior
    - Stop accepting connections, drain → exit 0, exceed timeout → non-zero, and the same under
      `uncaughtException`
    - _Requirements: 23.1, 23.3, 23.4, 23.5, 23.6_

- [x] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Allowlist error sanitization and module consolidation
  - [x] 14.1 Implement allowlist-based error sanitization
    - Replace the denylist with `CLIENT_ERROR_FIELD_ALLOWLIST` and `sanitizeErrorForClient`
      (default-deny, returning only allowlisted fields); wire into `Error_Handler` and preserve the
      full unsanitized error in the server log
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_

  - [x] 14.2 Write property test for allowlist-bound error sanitization
    - **Property 32: Error sanitization is allowlist-bound (default-deny)**
    - **Validates: Requirements 24.1, 24.2, 24.3, 24.4**

  - [x] 14.3 Write unit test for server-side log detail preservation
    - Assert the complete unsanitized error is preserved in the server log
    - _Requirements: 24.5_

  - [x] 14.4 Consolidate migration and auth-route modules
    - Reduce to one migration runner + one migrations definition module; remove `routes/auth.ts` in
      favor of the `routes/auth/` tree; update all callers and wiring with zero remaining references
      to removed modules
    - _Requirements: 27.2, 27.3, 27.4_

  - [x] 14.5 Write guard test for single-implementation modules and regression
    - Static-analysis guard failing the build on duplicate migration runner/definition or auth-route
      definitions; confirm the existing automated suite passes unchanged
    - _Requirements: 27.5, 27.6_

  - [x] 14.6 Add a scoped no-explicit-any check for the core layer
    - Configure a scoped `no-explicit-any` lint/type assertion over the DB client/wrapper and
      auth-middleware handlers that fails type-check with diagnostics and produces no build artifacts
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (property, unit, integration, and smoke tests) and can be
  skipped for a faster MVP.
- Each task references specific requirement clauses for traceability.
- Property tests use the existing `fast-check` + Vitest setup at ≥ 100 iterations and are tagged
  `// Feature: backend-security-hardening, Property {number}: {property_text}`.
- Pure-logic helpers are built before the services that consume them so correctness can be
  validated early.
- Infrastructure, timing, process-lifecycle, and structural criteria are validated by integration,
  smoke, and guard tests rather than universally-quantified properties, per the design's Testing
  Strategy.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1", "5.4", "7.1", "8.1", "10.1", "10.6"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "2.5", "4.2", "4.3", "5.2", "5.3", "5.5", "5.6", "7.2", "7.3", "7.4", "7.5", "8.2", "10.2", "10.3", "10.4", "10.5"] },
    { "id": 2, "tasks": ["2.6", "2.7", "5.7", "5.8", "5.9"] },
    { "id": 3, "tasks": ["4.4", "5.10", "5.11"] },
    { "id": 4, "tasks": ["7.6", "7.7"] },
    { "id": 5, "tasks": ["5.12", "8.3"] },
    { "id": 6, "tasks": ["8.4", "8.5"] },
    { "id": 7, "tasks": ["8.6", "8.7", "8.8"] },
    { "id": 8, "tasks": ["8.9", "8.10", "8.11"] },
    { "id": 9, "tasks": ["8.12", "8.13"] },
    { "id": 10, "tasks": ["8.14", "8.15"] },
    { "id": 11, "tasks": ["8.16", "10.8"] },
    { "id": 12, "tasks": ["10.7", "10.9", "10.10"] },
    { "id": 13, "tasks": ["10.11", "10.12"] },
    { "id": 14, "tasks": ["10.13", "10.14"] },
    { "id": 15, "tasks": ["12.1"] },
    { "id": 16, "tasks": ["12.2", "12.3", "12.4", "12.7", "12.10", "14.1"] },
    { "id": 17, "tasks": ["12.5", "12.6", "12.8", "12.9", "12.11", "12.12", "14.2", "14.3", "14.4"] },
    { "id": 18, "tasks": ["14.5", "14.6"] }
  ]
}
```

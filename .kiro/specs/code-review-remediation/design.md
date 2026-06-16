# Code Review Remediation Bugfix Design

## Overview

A whole-codebase review of the `alsaqi-backend` Node.js/TypeScript service surfaced 40 numbered defects (`bugfix.md` clauses 1.1–1.40) spanning startup wiring, authorization, session/credential security, audit integrity, data correctness, resource lifecycle, and operational hardening. This document formalizes those findings using the bug-condition methodology so that each fix is **targeted, minimal, and regression-safe**.

Because the report aggregates many independent defects, this design treats the remediation as a *family* of bug fixes that share one validation contract:

- **Fix checking** — for every input `X` where a finding's bug condition `C(X)` holds, the fixed code `F'` must produce the expected behavior `P(result)` (clauses 2.1–2.40).
- **Preservation checking** — for every input `X` where no bug condition holds (`¬C(X)`), the fixed code must behave identically to the current code `F` (clauses 3.1–3.12).

The strategy is to fix each finding in isolation (so its bug condition no longer triggers) while proving via property-based preservation tests that non-triggering inputs are untouched. Two findings (1.23 Chromium-in-container, 1.30 file-upload middleware) are flagged **[INFERRED]** and MUST be reproduced before being fixed; if the behavior is already correct, the clause is closed as "not reproducible" rather than changed.

Verification against source confirmed the two highest-impact findings:
- `src/index.ts` `start()` mounts routes/middleware but never calls `redisManager.connect()`, `queueManager.initialize()`, `setupWebSocket()`, `startAutomationJobs()`, `backupScheduler.start()`, the queue workers, or the `/metrics` endpoint (confirms 1.1).
- `src/main.ts` shutdown path drains only the HTTP server and closes WebSocket clients; it never drains `queueManager`, ends the pg pool, disconnects Redis, or stops cron, and `ApiServer.stop()` is not invoked from the signal handler (confirms 1.2).

## Glossary

- **Bug_Condition (C)**: The input/condition that triggers a defect. Each finding `N` has its own `C_N(X)`. The aggregate `isBugCondition(input)` returns true when *any* finding's condition holds.
- **Property (P)**: The desired behavior for a triggering input, as defined by the matching Expected Behavior clause `2.N`.
- **Preservation**: Existing behavior for non-triggering inputs (`¬C(X)`) that must remain byte-for-byte identical after the fix — captured by clauses 3.1–3.12.
- **F**: The current (unfixed) code for a given function/route.
- **F'**: The fixed code.
- **Counterexample**: A concrete input that demonstrates a finding's defect on `F`.
- **Severity tiers**: `Critical (Blocking)` = 1.1–1.5, `Important` = 1.6–1.30, `Minor` = 1.31–1.40. Remediation is ordered Critical → Important → Minor.
- **[INFERRED]**: A finding derived from static analysis that MUST be reproduced before being treated as a confirmed bug (1.23, 1.30).
- **checkPermission / checkWhitelist**: Authorization middleware and column-whitelist guard whose absence drives several findings (1.3, 1.6, 1.20, 2.3).
- **AuditChainService**: The intended sole writer of the `audit_trail` hash chain (`hash`/`previous_hash`/`seq`), bypassed by several services (1.5).
- **session_version**: The per-user counter that invalidates refresh/access tokens after a credential change (1.4).
- **NumberingService.nextCounter**: The atomic UPSERT-RETURNING counter that correspondence numbering should use instead of `ORDER BY id DESC` (1.19).

## Bug Details

### Bug Condition

The remediation covers 40 distinct defects. Each is captured by its own predicate `C_N`; the system-level bug condition is the disjunction of all of them. A fix for finding `N` is correct when `C_N` can no longer be satisfied by any reachable input while every other behavior is preserved.

**Formal Specification (aggregate):**
```
FUNCTION isBugCondition(input)
  INPUT: input — one of {StartupEvent, ShutdownSignal, HttpRequest, WsConnect,
                         AuditWrite, ServiceCall, ConfigState, DbMigration, BuildArtifact}
  OUTPUT: boolean   // true if input triggers ANY finding 1.1–1.40

  RETURN  C_startupWiring(input)         // 1.1
       OR C_gracefulShutdown(input)      // 1.2
       OR C_bulkAuthz(input)             // 1.3
       OR C_sessionRevocation(input)     // 1.4
       OR C_auditChain(input)            // 1.5
       OR C_routePermission(input)       // 1.6
       OR C_objectLevelAuthz(input)      // 1.7
       OR C_unauthLogging(input)         // 1.8
       OR C_2faBruteForce(input)         // 1.9
       OR C_totpReplay(input)            // 1.10
       OR C_missingEncryptionKey(input)  // 1.11
       OR C_columnInjection(input)       // 1.12
       OR C_missingTransaction(input)    // 1.13
       OR C_webhookInTransaction(input)  // 1.14
       OR C_validationNotWired(input)    // 1.15
       OR C_requestLoggerUnmounted(input)// 1.16
       OR C_envelopeDoubleWrap(input)    // 1.17
       OR C_rawErrorLeak(input)          // 1.18
       OR C_correspondenceNumbering(input)//1.19
       OR C_riskWhitelist(input)         // 1.20
       OR C_employeeIdCast(input)        // 1.21
       OR C_orgEntityConflict(input)     // 1.22
       OR C_pdfChromium(input)           // 1.23 [INFERRED]
       OR C_migrationSwallow(input)      // 1.24
       OR C_redisNoRecovery(input)       // 1.25
       OR C_insecureComposeDefaults(input)//1.26
       OR C_wsTokenWeak(input)           // 1.27
       OR C_permissionDenyIgnored(input) // 1.28
       OR C_idempotencySecretCache(input)// 1.29
       OR C_fileUploadUnregistered(input)// 1.30 [INFERRED]
       OR C_softDeleteLeak(input)        // 1.31
       OR C_hardDeleteOnSoftTable(input) // 1.32
       OR C_unboundedQuery(input)        // 1.33
       OR C_csvInjection(input)          // 1.34
       OR C_paginationInconsistent(input)// 1.35
       OR C_orderByNoValidation(input)   // 1.36
       OR C_circuitBreakerLogic(input)   // 1.37
       OR C_pdfTimerLeak(input)          // 1.38
       OR C_credentialFlowWeak(input)    // 1.39
       OR C_miscHardening(input)         // 1.40
END FUNCTION
```

Representative per-finding predicates (the rest follow the same shape, derived from clauses `1.N`):
```
FUNCTION C_startupWiring(input)        // 1.1
  RETURN input is StartupEvent
     AND NOT all_of(redisManager.connect, queueManager.initialize, setupWebSocket,
                    startAutomationJobs, backupScheduler.start, queueWorkers, mount('/metrics'))
                    were invoked during start()
END FUNCTION

FUNCTION C_bulkAuthz(input)            // 1.3
  RETURN input is HttpRequest to POST /api/v1/bulk/:resource
     AND ( checkPermission was NOT enforced
        OR processCreate/processUpdate did NOT run checkWhitelist
        OR new id was read via SQLite-only info.lastInsertRowid )
END FUNCTION

FUNCTION C_sessionRevocation(input)    // 1.4
  RETURN input is password-change flow
     AND ( rotated refresh token OMITS session_version
        OR user_sessions NOT terminated
        OR refresh_tokens NOT revoked )
END FUNCTION

FUNCTION C_totpReplay(input)           // 1.10
  RETURN input is a TOTP verification with a code already used within its window
     AND TOTPService.verify does NOT reject it (last_used_at unchecked; timingSafeEqual no-op)
END FUNCTION
```

### Examples

- **1.1 Startup wiring** — Expected: on boot, WebSocket heartbeat is alive, PDF/notification queue jobs process, Redis-backed rate limiter is active, cron/backups run, `/metrics` is scrapeable. Actual: none are wired in `index.ts start()`; queues throw, WS is dead, rate limiter degrades to per-instance memory, metrics 404.
- **1.3 Bulk authorization** — Expected: `POST /api/v1/bulk/users` by a user without `users:create` is `403`, restricted columns rejected, returned `id` defined. Actual: passes with `authenticate` only, writes restricted columns across 13 tables, `id` is `undefined` under Postgres/PGlite.
- **1.4 Session revocation** — Expected: after password change, a previously issued refresh cookie can no longer mint access tokens. Actual: rotated refresh token lacks `session_version`, sessions/tokens not revoked, so the stale cookie keeps working.
- **1.10 TOTP replay** — Expected: a valid TOTP reused within its window is rejected. Actual: `last_used_at` is written but never checked and the constant-time compare result is discarded, so the code replays.
- **Edge / [INFERRED] 1.23** — Expected: in-container PDF generation succeeds via a reachable Chromium binary with `PUPPETEER_EXECUTABLE_PATH`. Actual (to verify): no Chromium binary, `PUPPETEER_SKIP_DOWNLOAD=true`, UID 1001 cannot reach root's puppeteer cache — likely fails. Reproduce before changing.

## Expected Behavior

The expected correct behavior for each triggering input is defined authoritatively by the matching Expected Behavior clauses `2.1–2.40` in `bugfix.md` and summarized in the Correctness Properties section (Property 1). This section records what must **not** change.

### Preservation Requirements

**Unchanged Behaviors (from clauses 3.1–3.12):**
- Valid, authorized requests SHALL continue to authenticate, authorize, and be served exactly as today (3.1).
- CRUD operations with permitted, whitelisted columns SHALL continue to create/read/update/soft-delete successfully (3.2).
- A valid, unused TOTP/backup code within its window SHALL continue to be accepted (3.3).
- Still-valid, non-revoked sessions SHALL continue to honor their access/refresh tokens until expiry/revocation (3.4).
- Already-compliant audit writers SHALL continue to produce correct, verifiable chain entries (3.5).
- A fully-configured environment SHALL continue to boot and serve traffic (3.6).
- Endpoints already on the canonical envelope SHALL return the same shape and status codes for success (3.7).
- List/query endpoints with valid in-range params SHALL return the same result sets and ordering, modulo the now-applied soft-delete filter and bound limits (3.8).
- Successful webhook-dependent operations SHALL still dispatch the n8n webhook and persist DB changes; only ordering relative to the transaction changes (3.9).
- Numbering, employee-id, and org-entity operations with already-valid inputs SHALL still produce correct, unique identifiers and the same downstream records (3.10).
- Newly-wired PDF/notification/queue/cron/WebSocket features SHALL produce the same outputs/payloads they were designed to produce (3.11).
- Already-applied migrations SHALL remain idempotent on restart and not be re-applied/corrupted (3.12).

**Scope:**
All inputs where `isBugCondition` returns false SHALL be completely unaffected by these fixes. This explicitly includes:
- Authenticated, authorized requests with valid, whitelisted payloads.
- Read/list requests with in-range pagination that reference non-deleted rows.
- Existing canonical-envelope success responses and their status codes.
- Sessions and 2FA flows that have not been invalidated.

## Hypothesized Root Cause

The 40 findings cluster into a small number of recurring root causes:

1. **Missing composition / wiring in the bootstrap path** (1.1, 1.2, 1.16, 1.30): `index.ts start()` and the `main.ts` shutdown handler compose only a subset of the available subsystems. Infrastructure modules (`redisManager`, `queueManager`, `setupWebSocket`, cron, backups, `requestLogger`, `/metrics`, file-upload middleware) exist but are never `app.use`'d / invoked. **Verified for 1.1 and 1.2.**

2. **Authorization applied inconsistently** (1.3, 1.6, 1.7, 1.8, 1.27, 1.28, 1.40): routes use `authenticate` without `checkPermission`; object-level (IDOR) checks are absent; the WS handshake accepts any RS256 token; effective-permission computation omits `is_allowed=0` denies. The auth primitives exist but are not uniformly applied.

3. **Credential/session lifecycle gaps** (1.4, 1.9, 1.10, 1.11, 1.29, 1.39): rotation omits `session_version`, 2FA endpoints lack rate limiting, TOTP reuse/constant-time checks are dead code, encryption keys are not asserted at startup, and idempotency caches secrets in plaintext.

4. **Audit-chain integrity not centralized** (1.5): multiple services write `audit_trail` directly, the schema/partition manager omit `hash`/`previous_hash`/`seq`, and `logAudit` swallows errors — so the "sole writer" invariant is violated and failures are silent.

5. **DB-portability and transaction-boundary defects** (1.3 id read, 1.13, 1.14, 1.19, 1.20, 1.21, 1.22, 1.24): SQLite-isms (`lastInsertRowid`, integer casts, error-message matching) leak into a Postgres/PGlite runtime; multi-step writes lack transactions; webhooks run *inside* transactions; numbering is non-atomic.

6. **Input validation / response shaping not wired** (1.12, 1.15, 1.17, 1.18, 1.34, 1.36): schema factories and identifier validation exist but are not imported by routes; the response envelope double-wraps; raw `err.message` leaks; CSV export is not neutralized.

7. **Resource-lifecycle and operational hardening** (1.23, 1.25, 1.26, 1.31, 1.32, 1.33, 1.35, 1.37, 1.38, 1.40): unbounded queries, hard-deletes on soft-delete tables, soft-delete leaks, inconsistent pagination defaults, Redis non-recovery, insecure compose defaults, leaked PDF timers, and assorted hardening items.

For the two **[INFERRED]** findings (1.23, 1.30) the root cause is provisional and MUST be confirmed by reproduction before any change.

## Correctness Properties

Property 1: Bug Condition — Each finding is remediated to its expected behavior

_For any_ input where the bug condition holds (`isBugCondition` returns true for some finding `N`), the fixed code SHALL produce the expected behavior defined by the matching Expected Behavior clause `2.N` — e.g., startup wires all infrastructure (2.1); shutdown fully drains queues/pool/Redis/cron (2.2); bulk routes enforce `checkPermission` + `checkWhitelist` and return a portable `id` (2.3); password change includes `session_version` and revokes sessions/tokens (2.4); audit writes funnel through `AuditChainService` with `hash`/`previous_hash`/`seq` (2.5); and so on through 2.40 (with 2.23 and 2.30 gated on reproduction).

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 2.26, 2.27, 2.28, 2.29, 2.30, 2.31, 2.32, 2.33, 2.34, 2.35, 2.36, 2.37, 2.38, 2.39, 2.40**

Property 2: Preservation — Non-triggering behavior is unchanged

_For any_ input where the bug condition does NOT hold (`isBugCondition` returns false), the fixed code SHALL produce the same observable result as the original code, preserving valid auth/authorization outcomes, successful whitelisted CRUD, accepted unused 2FA codes, still-valid sessions, compliant audit entries, successful boot in a configured environment, canonical-envelope success responses and status codes, in-range list results and ordering, successful webhook dispatch + persistence, valid identifier generation, designed feature outputs, and migration idempotency.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12**

## Fix Implementation

### Changes Required

Fixes are grouped by root-cause cluster and ordered by severity (Critical → Important → Minor). Each change is scoped to remove a finding's bug condition without altering `¬C(X)` behavior.

**Cluster 1 — Bootstrap wiring**

**Files**: `src/index.ts`, `src/main.ts`, `src/server/gracefulShutdown.ts`
1. **Startup wiring (1.1 → 2.1)**: In `start()`, invoke `redisManager.connect()`, `queueManager.initialize()`, `setupWebSocket()`, `startAutomationJobs()`, `backupScheduler.start()`, and the notification/PDF queue workers, and mount `/metrics` — or gate each behind explicit config flags. Mount `requestLogger` (1.16 → 2.16) and register file-upload middleware once verified (1.30 → 2.30).
2. **Graceful shutdown (1.2 → 2.2)**: Have the signal handler call `ApiServer.stop()` and drain `queueManager.shutdown()`, end the pg pool, disconnect Redis, and stop cron, all within the bounded `SHUTDOWN_DRAIN_TIMEOUT_MS`.

**Cluster 2 — Authorization**

**Files**: `src/routes/bulk.ts`, `auditTasks.ts`, `auditPrograms.ts`, `recommendations.ts`, `correspondence.ts`, `reports.ts`, `comments.ts`, `coi.ts`, `logs.ts`, `src/ws/auth.ts`, `src/services/AuthService.ts`, `/me` handler
3. **Route permissions (1.3, 1.6 → 2.3, 2.6)**: Add `checkPermission(resource, action)` to every listed mutating/custom route; run `checkWhitelist` in `BulkOperationsService.processCreate/processUpdate`.
4. **Object-level authz / IDOR (1.7 → 2.7)**: Enforce ownership/entitlement checks on `reports GET /:reportId/status`, `comments GET /:type/:id`, and `coi GET /coi`.
5. **Logging endpoints (1.8 → 2.8)**: Require auth on `/system-errors` + `/log-error`, sanitize+rate-limit broadcast content, gate `DELETE /system-errors` behind delete-level permission, read JWT public key from injected config.
6. **WS handshake (1.27 → 2.27)**: Require `type==='ws'`, re-check `session_version`/`status`, accept token via header/subprotocol not query string.
7. **Effective permissions (1.28, 1.40 → 2.28, 2.40)**: Subtract `is_allowed=0` denies in `/me` and `AuthService.login`; authorize `changeFindingStatus`/`approveProgram` against effective DB permissions.

**Cluster 3 — Credential/session lifecycle**

**Files**: `src/services/SessionService.ts`, `PasswordService.ts`, `routes/auth/twoFactor.ts`, `TOTPService.ts`, `src/config/*`, `src/middleware/idempotency.ts`, `routes/auth/password.ts`, `src/utils/keyStore.ts`
8. **Session revocation (1.4 → 2.4)**: Include `session_version` in rotated refresh tokens; terminate `user_sessions` and revoke `refresh_tokens` on password change/update.
9. **2FA brute force (1.9 → 2.9)**: Apply rate limiting/lockout to `/2fa/validate` and `/2fa/backup`.
10. **TOTP replay (1.10 → 2.10)**: Check `last_used_at` before accepting; fix the constant-time comparison to actually gate the result.
11. **Key assertions (1.11 → 2.11)**: Fail fast at startup if `FILE_ENCRYPTION_KEY`/`TOTP_ENCRYPTION_KEY` are missing.
12. **Idempotency cache (1.29 → 2.29)**: Redact/omit secrets (e.g., `tempPassword`) before caching; document cross-instance dedup behavior.
13. **Credential hardening (1.39 → 2.39)**: Environment-aware cookie `secure`/`sameSite`, HKDF in `KeyStore`, higher-entropy temp passwords, async bcrypt, remove/ wire dead `validatePasswordPolicy`.

**Cluster 4 — Audit chain**

**Files**: audit-writing services (`RecommendationService`, `CoiService`, `DepartmentService`, `JobTitleService`, `PolicyService`, `ProfileService`), `database/schema.sql`, `PartitionManager`, `BaseService.logAudit`
14. **Audit integrity (1.5 → 2.5)**: Funnel all audit writes through `AuditChainService`; add `hash`/`previous_hash`/`seq` to schema and partition rebuild; surface (not swallow) append failures.

**Cluster 5 — DB portability & transactions**

**Files**: `BulkOperationsService`, `AuditService`, `RecommendationService`, `NotificationService`, `CorrespondenceService`, `UserService`, `RiskService`, `OrgService`, `DepartmentService`, `db/migrations.ts`
15. **Portable id / casts / conflict detection (1.3, 1.21, 1.22 → 2.3, 2.21, 2.22)**: Use `RETURNING id`; fix employee-id generation to avoid integer-cast failures; detect unique-constraint conflicts portably; fix the `parseInt(uuid)` self-parent guard; reconcile org/department delete semantics.
16. **Transactions (1.13 → 2.13)**: Wrap multi-step writes in a single transaction.
17. **Webhook ordering (1.14 → 2.14)**: Move n8n webhook calls outside the transaction (after commit) with try/catch; dispatch `flushOnCommit` after commit; enforce `FLUSH_DEADLINE_MS`.
18. **Numbering (1.19 → 2.19)**: Use `NumberingService.nextCounter`.
19. **Risk whitelist (1.20 → 2.20)**: Compute/whitelist `risk_score_calc`/`risk_level_calc` so create/update passes.
20. **Migrations (1.24 → 2.24)**: Make `runMigrations()` throw on DDL error; reconcile the two migration systems into one tracked path.

**Cluster 6 — Validation & response shaping**

**Files**: `src/schemas/*`, `src/middleware/validate.ts`, `crudGenerator`, `responseWrapper`, `DepartmentService`, `QueryBuilder`, `logs.ts`, route error handlers
21. **Wire validation (1.12, 1.15, 1.36 → 2.12, 2.15, 2.36)**: Import schema/`validate` factories into routes; validate identifiers in `DepartmentService.update` and `QueryBuilder.orderBy`; whitelist `crudGenerator GET` filter keys; enforce attachment schema.
22. **Envelope + error sanitization (1.17, 1.18, 1.34 → 2.17, 2.18, 2.34)**: Single canonical envelope (no double-wrap / `error.error`), single field-error shape; route manual errors through the global sanitizer; neutralize CSV formula injection.

**Cluster 7 — Resource lifecycle & hardening**

**Files**: dashboard/task/recommendation/finding services, `AuditService`, `CorrespondenceService`, `SOFT_DELETE_TABLES`, list/export queries, pagination utils, `CircuitBreaker`, `PdfEngine`, `redisManager`, `docker-compose.yml`, `Dockerfile`, misc (`caching.ts`, `health.ts`, `SettingsService`, etc.)
23. **Soft-delete + bounds (1.31, 1.32, 1.33 → 2.31, 2.32, 2.33)**: Add `deleted_at IS NULL` filters; soft-delete on soft-delete tables; fix `SOFT_DELETE_TABLES` to `outgoing_letters`; bound unbounded queries.
24. **Consistency/operational (1.25, 1.26, 1.35, 1.37, 1.38, 1.40 → 2.25, 2.26, 2.35, 2.37, 2.38, 2.40)**: Redis backoff recovery; remove insecure compose defaults; unify pagination defaults; fix CircuitBreaker retry/health logic; clear PDF timers and sanitize style interpolation; apply the misc 2.40 hardening list.
25. **[INFERRED] reproduction-gated (1.23, 1.30 → 2.23, 2.30)**: Reproduce first. If confirmed, provide a reachable Chromium binary + `PUPPETEER_EXECUTABLE_PATH` with UID-1001 cache permissions, and register `app.use(fileUpload(...))`. If already correct, close as "not reproducible."

## Testing Strategy

### Validation Approach

Two phases per finding: first surface a counterexample that demonstrates the defect on the **unfixed** code, then verify the fix produces the expected behavior (fix checking) and leaves non-triggering inputs unchanged (preservation checking). Because the codebase already has a Vitest suite under `src/__tests__`, tests are added there. Run a single execution (no watch mode) with the project's test runner (e.g., `npm test` / `vitest --run`); the user should run any long-lived dev/build watchers manually.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate each finding BEFORE implementing the fix, confirming or refuting the root-cause hypothesis. If refuted (especially for [INFERRED] 1.23/1.30), re-hypothesize before changing code.

**Test Plan**: For each finding, write a focused test that drives the triggering input against current code and asserts the *defective* outcome so we can watch it flip after the fix.

**Test Cases (representative)**:
1. **Startup wiring (1.1)**: Boot the server in test and assert that Redis/queue/WS/cron/backup initializers and `/metrics` are invoked/mounted (will fail on unfixed code).
2. **Graceful shutdown (1.2)**: Send a shutdown signal and assert queue drain / pool end / Redis disconnect / cron stop are called (will fail on unfixed code).
3. **Bulk authz (1.3)**: `POST /api/v1/bulk/:resource` as a permission-less user and assert it is *not* `403` and writes restricted columns / returns `undefined` id (will fail on unfixed code).
4. **Session revocation (1.4)**: Change password, then reuse the prior rotated refresh cookie and assert it still mints an access token (will fail on unfixed code).
5. **TOTP replay (1.10)**: Submit a valid code twice in-window and assert the second is accepted (will fail on unfixed code).
6. **[INFERRED] PDF-in-container (1.23) / file-upload (1.30)**: Reproduce in the container/runtime; record whether the defect manifests (may pass on unfixed code → close as not reproducible).

**Expected Counterexamples**:
- Uninvoked initializers, dead WS/queues, `403`-less bulk writes, replayable tokens/TOTP codes, double-wrapped envelopes, unbounded result sets.
- Possible causes per cluster: missing wiring, missing `checkPermission`/`checkWhitelist`, missing `session_version`, unchecked `last_used_at`, SQLite-isms under Postgres.

### Fix Checking

**Goal**: Verify that for all inputs where a finding's bug condition holds, the fixed function produces the expected behavior (clauses 2.N).

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedCode(input)
  ASSERT expectedBehavior_2N(result)   // the matching 2.N clause for the triggered finding
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where no bug condition holds, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalCode(input) = fixedCode(input)
END FOR
```

**Testing Approach**: Property-based testing (fast-check, matching the existing TypeScript/Vitest stack) is recommended for preservation because it generates many inputs across the domain, catches edge cases manual tests miss, and gives strong guarantees that `¬C(X)` behavior is unchanged. Capture the baseline by observing behavior on the UNFIXED code first, then assert the fixed code matches.

**Test Cases**:
1. **Valid authorized request preservation (3.1, 3.2)**: Generate authorized requests with whitelisted columns; assert identical responses/status before and after.
2. **Session/2FA preservation (3.3, 3.4)**: Generate valid unused TOTP codes and still-valid sessions; assert they continue to be accepted.
3. **Envelope/list preservation (3.7, 3.8)**: Generate canonical-envelope success responses and in-range list queries (referencing non-deleted rows); assert same shape, status, result set, and ordering.
4. **Webhook/identifier/migration preservation (3.9, 3.10, 3.12)**: For successful webhook ops and valid identifier inputs, assert same persisted records; assert restart remains idempotent over already-applied migrations.

### Unit Tests

- Per-finding handler/service tests for triggering inputs (one per cluster minimum: auth, session, audit, transaction, validation, lifecycle).
- Edge cases: out-of-range pagination, missing config keys, Postgres-specific id/cast paths, empty/oversized upload payloads.
- Confirm mouse-equivalent "happy path" callers (authorized CRUD, valid 2FA) keep working.

### Property-Based Tests

- Preservation of authorized CRUD across randomly generated whitelisted column sets and roles.
- Preservation of response-envelope shape across random success payloads.
- Preservation of list ordering/result sets across random in-range pagination params on non-deleted data.
- Invariant: rotated refresh tokens always carry `session_version`; reused TOTP codes always rejected; bulk routes always require permission.

### Integration Tests

- Full boot → serve → graceful-shutdown flow asserting all subsystems start and drain (1.1, 1.2).
- End-to-end password change invalidating prior refresh cookie (1.4) and 2FA brute-force lockout (1.9).
- Cross-service audit-chain write verifying `hash`/`previous_hash`/`seq` continuity through `AuditChainService` (1.5).
- Webhook-dependent operations committing DB changes then dispatching n8n outside the transaction (1.14).

# Bugfix Requirements Document

## Introduction

A whole-codebase code review of the `alsaqi-backend` Node.js/TypeScript service surfaced a set of defects spanning startup wiring, authorization, session/credential security, audit integrity, data correctness, resource lifecycle, and operational hardening. This document captures each finding as a verifiable bug with a clear bug condition (current broken behavior), the expected correct behavior, and the existing behavior that must be preserved.

The findings are grouped by severity so that remediation tasks can be ordered **blocking (Critical) → Important → Minor**. Within each severity group, clauses are numbered continuously across the document so that each `1.Y` Current Behavior clause maps directly to its `2.Y` Expected Behavior clause.

Several findings were inferred by reviewers from static analysis and are flagged **[INFERRED]**. These MUST be reproduced/verified against the actual codebase before being treated as confirmed bugs. If verification shows the behavior is already correct (e.g., wiring exists in an out-of-scope bootstrap file), the corresponding clause should be closed as "not reproducible" rather than fixed.

**Bug condition methodology:** For each finding, `C(X)` is the input/condition that triggers the defect, `F` is the current (unfixed) code, and `F'` is the fixed code. Fix checking asserts the expected property holds for all `X` where `C(X)` is true; preservation checking asserts `F(X) = F'(X)` for all non-triggering inputs (Section 3).

## Bug Analysis

### Current Behavior (Defect)

The following clauses describe what currently happens when each bug is triggered.

#### Critical (Blocking)

1.1 WHEN the application starts via `src/index.ts start()` / `src/main.ts` THEN the system never invokes `redisManager.connect()`, `queueManager.initialize()`, `setupWebSocket()`, `startAutomationJobs()`, `backupScheduler.start()`, the notification/PDF queue workers, or mounts the `/metrics` endpoint, so WebSockets/heartbeat are dead, queues never initialize (PDF jobs throw), Redis never connects (rate limiter silently degrades to per-instance in-memory), cron/backups never run, and metrics are not scrapeable.

1.2 WHEN the process receives a shutdown signal THEN `gracefulShutdown.ts` (via `main.ts`) only closes the HTTP server and never drains `queueManager.shutdown()`, ends the pg pool, disconnects Redis, or stops cron, and `ApiServer.stop()` is never called.

1.3 WHEN any authenticated user calls `POST /api/v1/bulk/:resource` (`src/routes/bulk.ts`) THEN the request passes with `authenticate` only (no `checkPermission`) and `BulkOperationsService.processCreate/processUpdate` never call `checkWhitelist`, allowing create/update/soft-delete across 13 sensitive tables and setting restricted columns; additionally `processCreate` reads `info.lastInsertRowid` (SQLite) so `id` is `undefined` under Postgres/PGlite.

1.4 WHEN a user changes their password THEN `SessionService.refresh` mints a rotated refresh token WITHOUT `session_version` (so the revocation check is permanently skipped after the first rotation), and `PasswordService.changePassword/updatePassword` bump `session_version` but do NOT terminate `user_sessions` or revoke `refresh_tokens`, so an attacker holding a rotated refresh cookie keeps minting access tokens after the victim changes their password.

1.5 WHEN audit events are written THEN `RecommendationService`, `CoiService`, `DepartmentService`, `JobTitleService`, `PolicyService`, and `ProfileService` write `audit_trail` directly without `hash`/`previous_hash`, `database/schema.sql` defines `audit_trail` WITHOUT `hash`/`previous_hash`/`seq` columns, `PartitionManager` rebuilds `audit_trail` without those columns, and `BaseService.logAudit` swallows append errors, so the documented hash-chain integrity (sole writer `AuditChainService`) is violated and may be silently failing.

#### Important

1.6 WHEN an authenticated user calls mutating/custom routes that use `authenticate` only THEN any logged-in user may perform privileged actions across all of `src/routes/auditTasks.ts`, `auditPrograms.ts` duplicate/approve, `recommendations.ts` `GET /` and `PATCH /:id/resolve`, `correspondence.ts` create/refer/archive/status/attachments, and `reports.ts` `POST /generate` and `GET /:reportId/status` (missing `checkPermission`).

1.7 WHEN an authenticated user requests another user's resources THEN object-level authorization is broken (IDOR): `reports.ts GET /:reportId/status` returns a presigned download URL for any `reportId`, `comments.ts GET /:type/:id` is readable by any authenticated user, and `coi.ts GET /coi` returns all COI records to any authenticated user.

1.8 WHEN clients call `logs.ts POST /system-errors` or `POST /log-error` THEN they run unauthenticated (`optionalAuthenticate`), `/system-errors` broadcasts client-supplied content to all WebSocket clients and writes DB rows (content injection + DoS), `DELETE /system-errors` (clear all) is gated by a `View` permission instead of a delete/edit-level permission, and the route reads `process.env.JWT_PUBLIC_KEY` directly instead of injected config.

1.9 WHEN an attacker submits repeated guesses to the 2FA verification endpoints (`routes/auth/twoFactor.ts` `/2fa/validate`, `/2fa/backup`) THEN there is no rate limiting/lockout, enabling TOTP/backup-code brute force (`authLimiter` is only on `/login`).

1.10 WHEN a valid TOTP code is reused within its validity window THEN `TOTPService.verify` updates `last_used_at` but never checks it, and the `timingSafeEqual` block is a no-op (result discarded in `catch`), so codes can be replayed.

1.11 WHEN the service runs in production without `FILE_ENCRYPTION_KEY` THEN file encryption is silently disabled (files written plaintext) because the missing key is only a warning, and `TOTP_ENCRYPTION_KEY`/`FILE_ENCRYPTION_KEY` are not asserted at startup like `FILE_ACCESS_SECRET` is.

1.12 WHEN `DepartmentService.update` builds its SQL THEN it interpolates raw object keys into the statement (column-name injection) without `db.validateIdentifier`, unlike every other dynamic-SET path.

1.13 WHEN `AuditService.changeFindingStatus`, `RecommendationService.update` (cascading auto-close finding), or `NotificationService.create` (per-recipient loop + duplicate legacy inserts) execute THEN the multi-step writes run without a transaction, risking partial writes.

1.14 WHEN `AuditService.updateFinding`, `CorrespondenceService.updateStatus`, or `UserService.createUser/updateUser` run THEN external n8n webhook calls execute INSIDE `db.transaction` and without try/catch, so a webhook failure rolls back valid DB changes and holds the connection/PGlite write-lock across the HTTP round-trip; `transactionalEvents.flushOnCommit` also dispatches while still inside the transaction wrapper, and `FLUSH_DEADLINE_MS` is declared but never enforced.

1.15 WHEN requests hit CRUD/list/query routes THEN the designed validation layer is not wired: `src/schemas/*` and `validate.ts` factories (`validateQuery`/`validateParams`/`validate`) are not imported by any route, list filters/query params are unvalidated, `correspondence POST /attachments` ignores its schema (no size/MIME/UUID validation), and `crudGenerator GET` passes arbitrary `req.query` keys as `where` filters.

1.16 WHEN requests are served in production THEN `requestLogger.ts` is never mounted in `index.ts` (only referenced in tests), so `request_logs` are never written and slow-request warnings never fire.

1.17 WHEN responses are produced THEN the response envelope is inconsistent and double-wrapped: `responseWrapper` re-wraps bodies lacking `meta`, nesting payloads under `error.error` (affects `authenticate`/`checkPermission` 403s, `validate.ts`, `routeRegistry` 405, `versionRewrite` 404, `bodySizeLimit` 413, `users.ts` 403s, `reports`/`pdfTemplates` 404/400), and field-error shapes diverge (`validate.ts` `error.errors {field,rule,message}` vs envelope `error.details {path,message,code}`).

1.18 WHEN errors are thrown in `auditTasks.ts PATCH /:id/status`, `recommendations.ts PATCH /:id/resolve`, or `adminBackup.ts POST /backup` THEN manual error responses leak raw `err.message`, bypassing the global sanitizer.

1.19 WHEN `CorrespondenceService.createIncoming/createOutgoing` assigns a number THEN it computes the next number via `SELECT ... ORDER BY id DESC LIMIT 1` where `id` is a UUID (arbitrary row, duplicable) and non-atomic, instead of using the existing atomic `NumberingService.nextCounter` (UPSERT RETURNING).

1.20 WHEN `RiskService.create/update` is called with scoring inputs THEN it injects non-whitelisted columns `risk_score_calc`/`risk_level_calc` which `checkWhitelist` then rejects, breaking risk create/update.

1.21 WHEN `UserService.createUser` generates an employee id after a new-format id (`EMP-1001-A1B2C3`) exists THEN `ORDER BY CAST(SUBSTR(employee_id, LENGTH(?)+1) AS INTEGER) DESC` throws an invalid-integer error in Postgres/PGlite (create fails), and `getUserSummary` counts `status='Archived'` while archived users persist as `'Inactive'` (always 0).

1.22 WHEN org entities are created/updated THEN `OrgService.createOrgEntity` matches the SQLite unique-constraint message (Postgres emits different text) so `ConflictError` never fires (raw 500 leaks), `updateOrgEntity`'s self-parent guard `parseInt(uuid) === parseInt(uuid)` is `NaN===NaN` (false, never triggers), and `OrgService` vs `DepartmentService` duplicate `org_entities` logic with divergent delete semantics.

1.23 [INFERRED] WHEN PDF generation runs in-container THEN the `Dockerfile` installs Chromium shared libs but no Chromium binary, sets `PUPPETEER_SKIP_DOWNLOAD=true` with no `PUPPETEER_EXECUTABLE_PATH`, and runtime UID 1001 cannot reach root's puppeteer cache, so PDF generation likely fails. (Requires reproduction/verification.)

1.24 WHEN `runMigrations()` (`db/migrations.ts`) encounters a DDL error THEN it swallows the error (`console.error`, no throw) so a failed base-schema migration does not stop startup (contradicting `MigrationRunner` throw-on-failure), and two overlapping migration systems coexist (legacy untracked re-run every boot + tracked versioned).

1.25 WHEN `redisManager` exhausts `maxReconnectAttempts` (3×5s) THEN it never recovers (permanent degraded state until restart).

1.26 WHEN `docker-compose.yml` is used without overrides THEN it falls back to insecure default secrets (`POSTGRES_PASSWORD:-alsaqi`, `REDIS_PASSWORD:-changeme`).

1.27 WHEN a WebSocket connection authenticates THEN `ws/auth.ts` accepts any RS256 token with an `id` (a 15-min access token works as well as a 30s ws token), never checks `type==='ws'` nor re-checks `session_version`/`status`, and the token is passed via `?token=` query string (logged by proxies).

1.28 WHEN effective permissions are computed in `/me` and `AuthService.login` THEN they union role+allow grants but never subtract `is_allowed=0` denies, disagreeing with `PermissionService.resolvePermission`.

1.29 WHEN the idempotency middleware caches a response THEN it stores and replays full response bodies (which may include secrets like `tempPassword`) in plaintext for 24h, and the in-flight dedup `Set` is per-instance only.

1.30 [INFERRED] WHEN routes read `req.files` THEN file-upload middleware appears unregistered (`express-fileupload` imported only as a type; no `app.use(fileUpload(...))` found in `src`), so upload paths may silently no-op. (Requires verification that it is not registered in an out-of-scope bootstrap file.)

#### Minor

1.31 WHEN reads/aggregates run in `DashboardService.getDashboardStats/getMyTasks`, `AuditTaskService.getTasks`, `RecommendationService.getRecommendations/getAll`, and `AuditService.getFindings/getFindingsByPlan` THEN soft-deleted rows leak in because there is no `deleted_at IS NULL` filter.

1.32 WHEN `AuditService.deleteFinding` (recommendations+findings) or `CorrespondenceService.deleteIncoming/deleteOutgoing` run THEN they hard-delete rows on soft-delete tables, and `SOFT_DELETE_TABLES` lists `outgoing_correspondence`/`correspondence_attachments` while the real table is `outgoing_letters` (wrong name; `outgoing_letters` absent).

1.33 WHEN queries run in `lookups.ts` (all `risk_register`/`compliance_items`), `archive.ts GET /archived-plans` (`SELECT *` no limit), `auditFindings` evidence list, `RecommendationService.getAll`, `CoiService.getAll`, `LogService` export, `OrgService.getOrgEntities`, and `DepartmentService.getAll` THEN they are unbounded (DoS risk).

1.34 WHEN `logs.ts /system-errors/export` generates CSV THEN leading `=`, `+`, `-`, `@` are not neutralized (CSV/formula injection).

1.35 WHEN pagination defaults are applied THEN they are inconsistent across `utils/pagination.ts` (25/max100), `utils/paginationService.ts` (20/max100), `responseEnvelope.computePagination` (20), `schemas/crudFilters` (50/max200), and `BaseService.findAll` offset path (10).

1.36 WHEN `QueryBuilder.orderBy` is called THEN there is no identifier validation (latent injection; current callers pass literals), and `NotificationService.getAdminIds`/`fraud.ts` interpolate `UserRole` enum constants (not injectable but should be parameterized for consistency).

1.37 WHEN `CircuitBreaker` handles errors THEN `isRetryableError` is defined but unused (retries all errors incl 4xx), the `status>=500` branch is dead (axios rejects 5xx by default), and `performHealthProbe` HALF_OPEN re-entry is unguarded.

1.38 WHEN PDF rendering runs THEN `PdfEngine.timeout()`'s `setTimeout` is never cleared on race resolve (lingering 30s timer / unhandledRejection), and `pdfHelpers.wrapWithStyles` interpolates settings (`arabic_font_name`, margins) into `<style>` AFTER `sanitizeHtml` (low-impact markup breakout).

1.39 WHEN auth/credential flows run THEN `routes/auth/password.ts` hardcodes `secure:true`/`sameSite:'none'` cookies (dropped on HTTP/dev; routes don't rotate the refresh cookie), `KeyStore` uses `SHA-256(JWT_SECRET+'_rsa_enc')` instead of HKDF, `approveReset` temp password is only `crypto.randomBytes(6)`, multiple `bcrypt.compareSync` (sync) block the event loop, and `PasswordService.validatePasswordPolicy` is dead code.

1.40 WHEN miscellaneous paths run THEN: `caching.ts` is unmounted (would set `Cache-Control: public` on authenticated responses if enabled); `X-Request-Id` is duplicated (`correlationId` + `responseWrapper`); `userSchema` reused for PUT requires `name`/`email` on partial updates; `OrgService` create race / consumed plan-code on failure (`AuditPlanService`); `health.ts` is unauthenticated infra disclosure and the enhanced health router is shadowed by a simple route in `index.ts`; `console.*` in `db/index.ts`, `main.ts`, `dependencyCheck.ts`, `gracefulShutdown.ts` bypass Winston; `dependencyCheck.checkPostgres` opens a pool without SSL; metrics `collectDefaultMetrics` runs at import and `/metrics` has no auth; `AuditService.changeFindingStatus` & `AuditProgramService.approveProgram` authorize against the static `DEFAULT_PERMISSIONS` map instead of effective DB permissions; and `SettingsService` positional full-row updates write `NULL` on omitted fields with no upsert.

### Expected Behavior (Correct)

The following clauses define what should happen instead. Each `2.Y` maps to the `1.Y` defect above.

#### Critical (Blocking)

2.1 WHEN the application starts THEN the system SHALL wire infrastructure into startup so that `redisManager.connect()`, `queueManager.initialize()`, `setupWebSocket()`, `startAutomationJobs()`, `backupScheduler.start()`, and notification/PDF queue workers are invoked and the `/metrics` endpoint is mounted (or each is explicitly and intentionally disabled via config), so WebSockets/heartbeat, queues, Redis-backed rate limiting, cron/backups, and metrics all function.

2.2 WHEN the process receives a shutdown signal THEN the system SHALL perform a full graceful shutdown that drains `queueManager.shutdown()`, ends the pg pool, disconnects Redis, stops cron, and closes the HTTP server (via `ApiServer.stop()`), within a bounded timeout.

2.3 WHEN a user calls `POST /api/v1/bulk/:resource` THEN the system SHALL enforce `checkPermission` for the resource/action, SHALL run `checkWhitelist` in `processCreate/processUpdate` to reject restricted columns, and SHALL obtain the new id portably (e.g., `RETURNING id`) so it is defined under Postgres/PGlite.

2.4 WHEN a user changes their password THEN the system SHALL include `session_version` in rotated refresh tokens (so revocation checks keep working) and SHALL terminate `user_sessions` and revoke `refresh_tokens` for the user (matching `approveReset`), so previously issued refresh/access tokens stop working.

2.5 WHEN any audit event is written THEN the system SHALL funnel all audit writes through `AuditChainService` (or remove the chain entirely), and the `audit_trail` schema in `database/schema.sql` and `PartitionManager` SHALL include `hash`/`previous_hash`/`seq` columns; `BaseService.logAudit` SHALL surface (not swallow) append failures so chain breaks are detectable.

#### Important

2.6 WHEN a user calls the listed mutating/custom routes THEN the system SHALL require an appropriate `checkPermission` in addition to `authenticate` for every route in `auditTasks.ts`, the `auditPrograms.ts` duplicate/approve actions, `recommendations.ts GET /` and `PATCH /:id/resolve`, `correspondence.ts` create/refer/archive/status/attachments, and `reports.ts POST /generate` and `GET /:reportId/status`.

2.7 WHEN a user requests a resource THEN the system SHALL enforce object-level authorization so that `reports.ts GET /:reportId/status` only returns a presigned URL to a user authorized for that report, `comments.ts GET /:type/:id` only returns comments the user may view, and `coi.ts GET /coi` only returns COI records the user is entitled to.

2.8 WHEN clients call logging endpoints THEN the system SHALL require authentication for `POST /system-errors` and `POST /log-error`, SHALL sanitize/escape and rate-limit any content before broadcasting or persisting it, SHALL gate `DELETE /system-errors` behind a delete/edit-level permission, and SHALL read the JWT public key from injected config rather than `process.env` directly.

2.9 WHEN repeated guesses hit `/2fa/validate` or `/2fa/backup` THEN the system SHALL apply rate limiting and account lockout (comparable to `authLimiter`) to prevent TOTP/backup-code brute force.

2.10 WHEN a TOTP code is presented THEN the system SHALL reject reuse within the validity window by checking `last_used_at`, and SHALL use a working constant-time comparison (no discarded result).

2.11 WHEN the service starts in production THEN it SHALL assert presence of `FILE_ENCRYPTION_KEY` and `TOTP_ENCRYPTION_KEY` (failing fast like `FILE_ACCESS_SECRET`), so files are never written plaintext due to a missing key.

2.12 WHEN `DepartmentService.update` builds dynamic SQL THEN it SHALL validate column identifiers via `db.validateIdentifier` (consistent with every other dynamic-SET path).

2.13 WHEN `AuditService.changeFindingStatus`, `RecommendationService.update`, or `NotificationService.create` perform multi-step writes THEN the system SHALL wrap them in a single transaction so partial writes cannot occur.

2.14 WHEN `AuditService.updateFinding`, `CorrespondenceService.updateStatus`, or `UserService.createUser/updateUser` run THEN external n8n webhook calls SHALL execute OUTSIDE the DB transaction (e.g., after commit) with try/catch error handling, `transactionalEvents.flushOnCommit` SHALL dispatch only after commit, and `FLUSH_DEADLINE_MS` SHALL be enforced.

2.15 WHEN requests hit CRUD/list/query routes THEN the system SHALL wire the `src/schemas/*` + `validate.ts` factories so query/params/body are validated, `correspondence POST /attachments` SHALL enforce its schema (size/MIME/UUID), and `crudGenerator GET` SHALL only accept whitelisted filter keys.

2.16 WHEN requests are served in production THEN `requestLogger.ts` SHALL be mounted in `index.ts` so `request_logs` are written and slow-request warnings fire.

2.17 WHEN responses are produced THEN the system SHALL apply a single consistent response envelope (no double-wrapping, no nesting under `error.error`) across all the listed middleware/routes, with a single canonical field-error shape.

2.18 WHEN errors are thrown in `auditTasks.ts PATCH /:id/status`, `recommendations.ts PATCH /:id/resolve`, or `adminBackup.ts POST /backup` THEN responses SHALL route through the global sanitizer and SHALL NOT leak raw `err.message`.

2.19 WHEN `CorrespondenceService.createIncoming/createOutgoing` assigns a number THEN it SHALL use the atomic `NumberingService.nextCounter` (UPSERT RETURNING) so numbers are unique and race-free.

2.20 WHEN `RiskService.create/update` is called with scoring inputs THEN it SHALL compute/persist `risk_score_calc`/`risk_level_calc` in a way that passes `checkWhitelist` (whitelist the derived columns or compute server-side), so risk create/update succeeds.

2.21 WHEN `UserService.createUser` generates an employee id THEN it SHALL work correctly under Postgres/PGlite regardless of id format (no invalid-integer cast failure), and `getUserSummary` SHALL count archived users by their actual persisted status.

2.22 WHEN org entities are created/updated THEN `createOrgEntity` SHALL detect unique-constraint conflicts portably (raising `ConflictError`, not a raw 500), the self-parent guard SHALL compare UUIDs correctly, and `OrgService`/`DepartmentService` `org_entities` logic SHALL be reconciled to consistent delete semantics.

2.23 [INFERRED] WHEN PDF generation runs in-container THEN it SHALL succeed: the container SHALL provide a reachable Chromium binary with `PUPPETEER_EXECUTABLE_PATH` set and cache permissions appropriate for UID 1001. (Verify reproduction before fixing.)

2.24 WHEN `runMigrations()` encounters a DDL error THEN it SHALL throw and stop startup (consistent with `MigrationRunner`), and the overlapping migration systems SHALL be reconciled into one tracked, versioned system.

2.25 WHEN `redisManager` exhausts reconnect attempts THEN it SHALL continue attempting recovery (e.g., backoff retry) so Redis can reconnect without a process restart.

2.26 WHEN `docker-compose.yml` is used THEN it SHALL NOT provide insecure default secrets; secrets SHALL be required (no `:-alsaqi`/`:-changeme` fallbacks).

2.27 WHEN a WebSocket connection authenticates THEN `ws/auth.ts` SHALL require a dedicated ws token (`type==='ws'`), SHALL re-check `session_version`/`status`, and SHALL accept the token via a header/subprotocol rather than a query string.

2.28 WHEN effective permissions are computed in `/me` and `AuthService.login` THEN they SHALL subtract `is_allowed=0` denies (agreeing with `PermissionService.resolvePermission`).

2.29 WHEN the idempotency middleware caches a response THEN it SHALL NOT persist secrets in plaintext (omit/redact sensitive fields or avoid caching such responses), and dedup SHALL behave correctly across instances (or be documented as best-effort).

2.30 [INFERRED] WHEN routes read `req.files` THEN file-upload middleware SHALL be registered (`app.use(fileUpload(...))`) so uploads are parsed. (Verify it is not already registered elsewhere before changing.)

#### Minor

2.31 WHEN reads/aggregates run in the listed dashboard/task/recommendation/finding services THEN they SHALL exclude soft-deleted rows via a `deleted_at IS NULL` filter.

2.32 WHEN deletions run in `AuditService.deleteFinding` and `CorrespondenceService.deleteIncoming/deleteOutgoing` THEN they SHALL soft-delete (not hard-delete) on soft-delete tables, and `SOFT_DELETE_TABLES` SHALL reference the correct table name (`outgoing_letters`).

2.33 WHEN the listed list/export queries run THEN they SHALL be bounded with pagination/limits to prevent DoS.

2.34 WHEN `logs.ts /system-errors/export` generates CSV THEN it SHALL neutralize leading `=`, `+`, `-`, `@` to prevent CSV/formula injection.

2.35 WHEN pagination defaults are applied THEN the system SHALL use one consistent default/max page size across `pagination.ts`, `paginationService.ts`, `responseEnvelope.computePagination`, `schemas/crudFilters`, and `BaseService.findAll`.

2.36 WHEN `QueryBuilder.orderBy` is called THEN it SHALL validate identifiers, and `NotificationService.getAdminIds`/`fraud.ts` SHALL parameterize role constants for consistency.

2.37 WHEN `CircuitBreaker` handles errors THEN it SHALL use `isRetryableError` (not retry 4xx), SHALL handle 5xx via axios rejection correctly, and SHALL guard HALF_OPEN re-entry in `performHealthProbe`.

2.38 WHEN PDF rendering runs THEN `PdfEngine.timeout()` SHALL clear its `setTimeout` on race resolve, and `pdfHelpers.wrapWithStyles` SHALL sanitize/escape interpolated settings so they cannot break out of `<style>`.

2.39 WHEN auth/credential flows run THEN cookie `secure`/`sameSite` SHALL be environment-aware (and refresh cookies rotated where appropriate), `KeyStore` SHALL derive keys via HKDF, `approveReset` temp passwords SHALL use sufficient entropy, bcrypt comparisons SHALL be async (non-blocking), and dead `validatePasswordPolicy` SHALL be removed or wired in.

2.40 WHEN the miscellaneous paths run THEN each SHALL be corrected: `caching.ts` SHALL not set `Cache-Control: public` on authenticated responses; `X-Request-Id` SHALL be set once; PUT validation SHALL allow partial updates; plan-code generation SHALL avoid consuming codes on failure/race; `health.ts` SHALL not disclose infra unauthenticated and the enhanced health router SHALL not be shadowed; logging SHALL use Winston (no `console.*`); `dependencyCheck.checkPostgres` SHALL respect SSL config; `/metrics` SHALL be access-controlled; `AuditService.changeFindingStatus` & `AuditProgramService.approveProgram` SHALL authorize against effective DB permissions; and `SettingsService` SHALL update only provided fields (no NULL clobbering / proper upsert).

### Unchanged Behavior (Regression Prevention)

The following existing behaviors MUST be preserved. For all inputs that do not trigger the bugs above, the fixed code must behave identically to the current code.

3.1 WHEN a user makes a request with valid credentials and sufficient permissions THEN the system SHALL CONTINUE TO authenticate and authorize them and serve the request as it does today.

3.2 WHEN a user performs a CRUD operation with permitted, whitelisted columns THEN the system SHALL CONTINUE TO create/read/update/soft-delete the record successfully.

3.3 WHEN a valid, unused TOTP or backup code is presented within its window THEN the system SHALL CONTINUE TO accept it and complete 2FA.

3.4 WHEN a user with a still-valid, non-revoked session makes a request THEN the system SHALL CONTINUE TO honor their access/refresh tokens until expiry or revocation.

3.5 WHEN audit events are recorded for already-compliant writers THEN the system SHALL CONTINUE TO persist correct, verifiable audit entries.

3.6 WHEN the application starts in an environment where all required configuration is present THEN it SHALL CONTINUE TO boot successfully and serve traffic.

3.7 WHEN responses are returned for endpoints that already use the canonical envelope THEN the system SHALL CONTINUE TO return the same response shape and status codes for successful requests.

3.8 WHEN list/query endpoints receive valid, in-range parameters THEN the system SHALL CONTINUE TO return the same result sets and ordering (modulo the now-applied soft-delete and bound limits).

3.9 WHEN webhook-dependent operations succeed THEN the system SHALL CONTINUE TO dispatch the n8n webhook and persist the DB changes (only the ordering relative to the transaction changes).

3.10 WHEN numbering, employee-id, and org-entity operations run for already-valid inputs THEN the system SHALL CONTINUE TO produce correct, unique identifiers and the same downstream records.

3.11 WHEN PDF/notification/queue/cron/WebSocket features are exercised after wiring THEN the system SHALL CONTINUE TO produce the same outputs those features were designed to produce, with no change to their public behavior or payloads.

3.12 WHEN existing migrations have already been applied successfully THEN re-running startup SHALL CONTINUE TO be idempotent and SHALL NOT corrupt or re-apply tracked migrations.

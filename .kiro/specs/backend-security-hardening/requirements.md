# Requirements Document

## Introduction

This specification defines the remediation work required to close the findings of the
production-readiness audit of the `alsaqi-backend` service. The audit identified 7 critical
issues, 14 warnings, and 6 notes spanning database safety, authentication, secure file
serving, audit-trail integrity, queue resilience, performance, and code structure.

The goal of this effort is to harden the backend so that misconfiguration cannot cause silent
data loss, authentication and authorization controls cannot be bypassed, signed artifacts
cannot be forged, the tamper-evident audit chain cannot fork, and the service degrades
gracefully under load and failure. Each requirement below maps to one or more audit findings
(referenced by their finding ID, e.g. `DB-001`) and is written so that compliance can be
verified by automated tests.

The project already uses RS256 JWTs, parameterized queries, a permission registry, Zod
schemas in `src/schemas/`, and property-based tests. These existing capabilities are treated
as building blocks for the requirements rather than as items to be re-implemented.

## Glossary

- **System**: The `alsaqi-backend` service as a whole.
- **Database_Layer**: The database access wrapper in `src/db/index.ts` and its initialization in `src/main.ts`.
- **Config_Validator**: The startup configuration and secret validation logic (`src/config/envValidator.ts`, `src/utils/secretsValidator.ts`, `src/startup/dependencyCheck.ts`).
- **Auth_Middleware**: The authentication and gating middleware in `src/middleware/auth.ts`.
- **Auth_Service**: The authentication service in `src/services/AuthService.ts`.
- **Base_Service**: The generic CRUD service in `src/services/BaseService.ts`.
- **Audit_Service**: The component responsible for appending tamper-evident audit-log entries (the hash-chain writer, to be unified from the duplicated implementations in `BaseService` and `AuthService`).
- **Secure_File_Service**: The signed-URL and secret provider in `src/services/SecureFileService.ts`.
- **Secure_File_Middleware**: The file-serving middleware in `src/middleware/secureFile.ts`.
- **Queue_Manager**: The BullMQ queue configuration in `src/queues/queueManager.ts`.
- **PDF_Worker**: The Puppeteer-based PDF generation worker in `src/queues/workers/`.
- **Error_Handler**: The error-sanitization and response middleware in `src/middleware/error.ts`.
- **Event_Dispatcher**: The component that emits external events via `src/utils/n8nService.ts` (`N8nService.sendEvent`).
- **ALLOW_EMBEDDED_DB**: An explicit boolean environment flag that, when `true`, permits use of the embedded PGlite database.
- **PGlite**: The embedded WASM PostgreSQL engine used for development only.
- **FILE_ACCESS_SECRET**: A dedicated secret, distinct from the JWT signing secret, used only to sign and verify file-access URLs.
- **Signed_File_URL**: A time-limited, HMAC-signed URL granting access to a stored file for a specific user.
- **Audit_Chain**: The ordered, hash-linked sequence of audit-log rows where each entry's hash incorporates the previous entry's hash.
- **Soft_Delete**: Marking a row as deleted by setting `deleted_at` rather than removing it, as implemented by `SoftDeleteService`.
- **Column_Whitelist**: The set of column names a table accepts for write operations, derived from the relevant Zod schema in `src/schemas/`.

## Requirements

### Requirement 1: Fail-Fast Production Database Configuration

**User Story:** As a platform operator, I want the service to refuse to start in production without a valid external database, so that a misconfigured deployment cannot silently run on an ephemeral embedded database and lose all data on restart.

_Addresses finding DB-001._

#### Acceptance Criteria

1. WHILE `NODE_ENV` equals `production` AND `DATABASE_URL` is unset, contains only whitespace, or begins with `http://` or `https://` (matched case-insensitively after trimming surrounding whitespace), THE Database_Layer SHALL log a fatal configuration error message indicating the invalid `DATABASE_URL` value and SHALL terminate the process with a non-zero exit code before binding to any network port or serving any request.
2. WHILE `NODE_ENV` equals `production` AND `ALLOW_EMBEDDED_DB` is not exactly the string `true`, THE Database_Layer SHALL NOT initialize PGlite.
3. WHERE `ALLOW_EMBEDDED_DB` equals exactly the string `true`, THE Database_Layer SHALL permit PGlite initialization regardless of the value of `NODE_ENV`.
4. WHEN `DATABASE_URL` references an external PostgreSQL instance, THE Database_Layer SHALL attempt to establish a connection to that instance and SHALL NOT create a PGlite instance.
5. IF the Database_Layer cannot establish a connection to the external PostgreSQL instance referenced by `DATABASE_URL` within 30 seconds of process startup, THEN THE Database_Layer SHALL log a fatal connection error message indicating the failed database connection and SHALL terminate the process with a non-zero exit code without creating a PGlite instance.
6. IF the production dependency check runs WHILE `DATABASE_URL` or `REDIS_URL` is unset or contains only whitespace, THEN THE Config_Validator SHALL treat the empty value as a failed dependency and SHALL NOT skip the check.

### Requirement 2: Configurable Database Connection Pool

**User Story:** As a platform operator, I want connection pool sizing and timeouts to be configurable per environment, so that the service can absorb traffic bursts without pool exhaustion.

_Addresses finding PERF-003._

#### Acceptance Criteria

1. WHEN the Database_Layer creates the PostgreSQL connection pool, THE Database_Layer SHALL read the maximum pool size from an environment variable, SHALL accept only an integer value in the range 1 to 1000 inclusive, and SHALL use a documented default of 20 WHERE that variable is unset.
2. WHEN the Database_Layer creates the PostgreSQL connection pool, THE Database_Layer SHALL read the connection acquisition timeout in milliseconds from an environment variable, SHALL accept only an integer value in the range 1 to 60000 inclusive, and SHALL use a documented default of 2000 WHERE that variable is unset.
3. IF a pool configuration environment variable is present but is not an integer within its defined accepted range, THEN THE Database_Layer SHALL NOT create the connection pool, SHALL emit a startup error indicating which variable was rejected and its accepted range, and SHALL terminate with a non-zero exit code.
4. IF a caller requests a connection while all pooled connections are in use and a connection does not become available within the configured connection acquisition timeout, THEN THE Database_Layer SHALL abort the acquisition attempt and SHALL return an error indicating pool acquisition timeout without terminating the process.

### Requirement 3: Path-Safe Authentication Gating

**User Story:** As a security engineer, I want the password-change gate to match routes by canonical path only, so that an authenticated user who must change their password cannot bypass the gate by crafting query strings.

_Addresses finding SEC-001._

#### Acceptance Criteria

1. WHILE a user account has `requires_password_change` set to true, THE Auth_Middleware SHALL permit access only to routes whose canonical path either exactly matches an entry in the allowed-paths list or matches an entry as a path-segment-boundary prefix, and SHALL deny access to all other routes.
2. WHEN the Auth_Middleware evaluates the allowed-paths list, THE Auth_Middleware SHALL compare against `req.path` using exact match or path-segment-boundary prefix match, and SHALL NOT use substring matching and SHALL NOT evaluate `req.originalUrl` or any query-string component.
3. WHEN the Auth_Middleware derives the canonical path from `req.path`, THE Auth_Middleware SHALL percent-decode the path and normalize it by resolving `.` and `..` segments and removing any single trailing slash before comparing it against the allowed-paths list.
4. IF a normalized request path begins with an allowed-path entry but the character immediately following the entry is not a path separator `/` (for example `/auth/logout-evil` compared against `/auth/logout`), THEN THE Auth_Middleware SHALL treat the path as non-matching and SHALL deny the request WHILE `requires_password_change` is true.
5. IF a request to a non-allowed route includes a query string that contains the text of an allowed path (for example `?x=/auth/logout`), THEN THE Auth_Middleware SHALL deny the request and return an error response indicating that a password change is required, WHILE `requires_password_change` is true.
6. WHILE a user account has `requires_password_change` set to true, THE Auth_Middleware SHALL permit the password-change route and the logout route (`/auth/logout`) so that the user can resolve the required change.

### Requirement 4: CRUD Input Safety and Mass-Assignment Prevention

**User Story:** As a security engineer, I want create and update operations to accept only explicitly allowed columns, so that a client cannot tamper with status, ownership, role, or deletion fields to escalate privileges.

_Addresses finding SEC-002._

#### Acceptance Criteria

1. WHEN the Base_Service performs a create or update operation, THE Base_Service SHALL persist only those top-level keys of the request body that are present in the Column_Whitelist for the target table, where the Column_Whitelist is the exact set of writable field names derived per criterion 2.
2. WHEN the Base_Service derives a Column_Whitelist for a target table, THE Base_Service SHALL derive it as the set of field names declared in the corresponding Zod schema in `src/schemas/` for that table, and SHALL treat any field name not declared in that schema as not whitelisted.
3. IF a write request body contains one or more top-level keys that are not present in the Column_Whitelist for the target table, THEN THE Base_Service SHALL reject the entire request with a validation error that indicates which keys are not permitted, SHALL NOT create or modify any row in the database for that request, and SHALL leave any existing target row unchanged.
4. IF a write request body contains any key absent from the Column_Whitelist, including restricted fields `status`, `deleted_at`, ownership fields, and `role`, THEN THE Base_Service SHALL NOT write the value of that key to the database under any circumstance.
5. WHEN the Base_Service rejects a write request under criterion 3, THE Base_Service SHALL return the validation error to the caller within 1000 milliseconds of receiving the request.

### Requirement 5: Configurable Search Columns for List Queries

**User Story:** As a developer, I want list-search to use only columns that exist on each table, so that searching a table without `title`, `name`, or `description` does not produce a server error.

_Addresses finding DB-003._

#### Acceptance Criteria

1. WHEN the Base_Service builds a search clause for a list query with a non-empty search term, THE Base_Service SHALL restrict the search to only the search columns explicitly configured for the target table and SHALL NOT reference any column that is not in that configured set.
2. IF the target table has no configured search columns, THEN THE Base_Service SHALL execute the list query without any search clause, SHALL NOT substitute assumed or fallback columns such as `title`, `name`, or `description`, and SHALL return a successful response containing the unfiltered (non-search) result set.
3. WHEN a search request targets a table that lacks the columns `title`, `name`, or `description`, THE Base_Service SHALL return a successful response within 2000 milliseconds and SHALL NOT raise a database error referencing a missing or unknown column.
4. IF the search term is null, an empty string, or contains only whitespace characters, THEN THE Base_Service SHALL execute the list query without any search clause and SHALL return a successful response.

### Requirement 6: Scalable List Pagination

**User Story:** As an end user, I want list endpoints to remain responsive on large tables, so that paging through data does not degrade as the table grows.

_Addresses finding DB-002._

#### Acceptance Criteria

1. WHERE a list endpoint is configured for large-table access, THE Base_Service SHALL support keyset (cursor) pagination using an ordered key composed of one or more columns that together uniquely and deterministically order every row in the result set.
2. WHEN a list request supplies a valid cursor, THE Base_Service SHALL return the page of rows immediately following that cursor in the defined order, using a page size between 1 and 100 rows inclusive and defaulting to 25 rows when no page size is specified.
3. WHEN a returned page has additional rows remaining after it, THE Base_Service SHALL include a non-null next-page cursor in the response.
4. WHEN a returned page has no additional rows remaining after it, THE Base_Service SHALL return a null or omitted next-page cursor in the response.
5. WHEN a list endpoint returns a total count, THE Base_Service SHALL obtain that count from a cached or estimated source whose value is no older than 60 seconds rather than executing an unbounded `COUNT(*)` on every request for large-table-configured endpoints.
6. IF a list request supplies a cursor that is malformed or cannot be decoded to a valid ordered-key position, THEN THE Base_Service SHALL reject the request with an error response indicating that the cursor is invalid and SHALL NOT return any page rows.

### Requirement 7: Tamper-Evident Audit Trail Integrity

**User Story:** As a compliance officer, I want the audit hash chain to remain a single unforked sequence under concurrent activity, so that the audit trail stays tamper-evident as required by the central bank instructions.

_Addresses finding API-001._

#### Acceptance Criteria

1. THE System SHALL expose exactly one Audit_Service implementation as the sole code path for appending entries to the Audit_Chain, such that no other component can insert, modify, or delete Audit_Chain entries.
2. WHEN the Audit_Service appends an entry, THE Audit_Service SHALL execute reading the previous-hash, computing the new entry's hash, and inserting the new entry as one atomic, mutually-exclusive critical section, serializing concurrent appends so that no two append operations interleave any of these three steps.
3. WHEN two or more audit-generating actions are committed concurrently, THE Audit_Service SHALL produce a single linear Audit_Chain in which each entry has exactly one immediate predecessor and the entry's stored previous-hash equals the hash of exactly one prior entry, with no two entries referencing the same previous-hash.
4. WHEN the Audit_Chain is verified end to end, THE Audit_Service SHALL recompute each entry's hash from that entry's recorded content and recorded previous-hash and SHALL confirm the chain is valid only when every recomputed hash equals the entry's stored hash, every previous-hash links to exactly one existing prior entry, and no entry is unreferenced or missing.
5. IF an append operation fails at any point after reading the previous-hash and before the new entry is durably inserted, THEN THE Audit_Service SHALL roll back the operation so that the Audit_Chain remains in its pre-append state with no partial entry persisted, and SHALL return a failure indication to the caller.
6. IF end-to-end verification detects a non-reproducible hash, a fork, or a gap, THEN THE Audit_Service SHALL report a verification-failure result that identifies the first offending entry in chain order and SHALL NOT alter any Audit_Chain entry.

### Requirement 8: Admin Lockout Notification Delivery

**User Story:** As an administrator, I want to receive a notification when an account is locked out, so that I can respond to potential abuse.

_Addresses finding DATA-001._

#### Acceptance Criteria

1. WHEN an account lockout occurs, THE Auth_Service SHALL create exactly one notification row for each administrator whose status equals `Active` within 5 seconds of the lockout event.
2. WHEN the Auth_Service queries administrators for lockout notifications, THE Auth_Service SHALL supply the role value as a bound query parameter rather than by string interpolation.
3. WHEN an account lockout occurs AND at least one administrator with status `Active` exists, THE Auth_Service SHALL persist a count of notification rows equal to the count of administrators whose status equals `Active`.
4. IF an account lockout occurs AND no administrator with status `Active` exists, THEN THE Auth_Service SHALL persist zero notification rows and complete the lockout operation without raising an error.
5. IF persisting one or more lockout notification rows fails, THEN THE Auth_Service SHALL roll back all notification rows for that lockout event and record an error indication identifying the failed lockout event, while preserving the account lockout state.

### Requirement 9: Secure File URL Signing and Secret Isolation

**User Story:** As a security engineer, I want file-access URLs to be signed with a dedicated secret that is required at startup, so that signed URLs cannot be forged and never depend on the JWT secret or a hardcoded value.

_Addresses finding SEC-003._

#### Acceptance Criteria

1. WHEN the Secure_File_Service starts AND `FILE_ACCESS_SECRET` is unset, empty, or contains only whitespace, THE Secure_File_Service SHALL write a fatal configuration error to the application log identifying `FILE_ACCESS_SECRET` as the missing value and SHALL terminate the process with a non-zero exit code before accepting any request.
2. WHEN the Secure_File_Service starts AND `FILE_ACCESS_SECRET` is set to a value shorter than 32 characters, THE Secure_File_Service SHALL write a fatal configuration error to the application log indicating the secret does not meet the minimum length and SHALL terminate the process with a non-zero exit code before accepting any request.
3. THE Secure_File_Service SHALL NOT contain any hardcoded fallback, default, or example secret value used when `FILE_ACCESS_SECRET` is absent.
4. WHEN the Secure_File_Service signs or verifies a Signed_File_URL, THE Secure_File_Service SHALL use the value of `FILE_ACCESS_SECRET` and SHALL NOT use the JWT signing secret or any other configured secret.
5. IF a Signed_File_URL is presented whose signature was not produced with the current `FILE_ACCESS_SECRET`, THEN THE Secure_File_Middleware SHALL deny the request, SHALL NOT return any file content, and SHALL return a response indicating the signature is invalid.

### Requirement 10: Secure File Path Containment

**User Story:** As a security engineer, I want file serving to confine reads to the upload directory, so that a crafted path cannot traverse to sibling directories.

_Addresses finding SEC-004._

#### Acceptance Criteria

1. WHEN the Secure_File_Middleware receives a request for a file, THE Secure_File_Middleware SHALL resolve the requested path to a canonical absolute path with all parent-directory (`..`) and current-directory (`.`) segments collapsed and all symbolic links dereferenced before any file access occurs.
2. WHEN the Secure_File_Middleware has resolved the requested file path, THE Secure_File_Middleware SHALL confirm the resolved path begins with the resolved upload directory path followed immediately by the platform path separator, treating a match of the directory name without a trailing separator (for example a sibling directory such as `uploads_backup`) as not contained.
3. IF the resolved file path is not contained within the resolved upload directory, THEN THE Secure_File_Middleware SHALL deny the request, SHALL NOT read or transmit the file contents, and SHALL return a response indicating the file is unavailable without disclosing the resolved path or whether the target exists.
4. IF the requested path contains one or more parent-directory traversal segments whose resolution produces a path outside the resolved upload directory, THEN THE Secure_File_Middleware SHALL deny the request and SHALL NOT read or transmit any file outside the upload directory.
5. WHEN the Secure_File_Middleware denies a request for failing the containment check, THE Secure_File_Middleware SHALL record a security event capturing the rejection without exposing it to the requester.

### Requirement 11: Signed File URL Authorization and Revocation

**User Story:** As a security engineer, I want signed file access to be re-checked against the signer's current standing, so that suspending or de-permissioning a user revokes their file access promptly.

_Addresses finding SEC-006._

#### Acceptance Criteria

1. WHEN a Signed_File_URL is presented, THE Secure_File_Middleware SHALL re-evaluate the signer's current account status and the permission required for the requested file against the system's current records before serving any file content.
2. IF the signer's account status is not "active" OR the signer lacks the required permission for the requested file at serve time, THEN THE Secure_File_Middleware SHALL deny the request without serving any file content and return a response indicating access is denied, even WHILE the URL signature is still cryptographically valid and unexpired.
3. IF a presented Signed_File_URL has an expiry timestamp earlier than the current time OR an invalid signature, THEN THE Secure_File_Middleware SHALL deny the request without serving any file content and return a response indicating access is denied.
4. WHEN the Secure_File_Service issues a Signed_File_URL, THE Secure_File_Service SHALL set an expiry timestamp no later than the configured maximum time-to-live, where the configured maximum time-to-live SHALL not exceed 900 seconds.

### Requirement 12: Streaming Encrypted File Delivery

**User Story:** As a platform operator, I want encrypted files to be delivered as a stream, so that serving large files does not exhaust process memory.

_Addresses finding PERF-002._

#### Acceptance Criteria

1. WHEN the Secure_File_Middleware serves an encrypted file, THE Secure_File_Middleware SHALL decrypt the file content in sequential chunks of at most 64 KB each rather than decrypting the entire file in a single operation.
2. WHEN the Secure_File_Middleware produces a decrypted chunk, THE Secure_File_Middleware SHALL write that chunk to the response output before decrypting the next chunk, without holding the complete decrypted file in memory at any point.
3. WHILE serving a file larger than the configured streaming threshold (default 1 MB, configurable within the range 1 KB to 1 GB), THE Secure_File_Middleware SHALL limit additional resident memory attributable to the transfer to no more than 10 MB, independent of the total file size.
4. IF decryption of any chunk fails while streaming an encrypted file, THEN THE Secure_File_Middleware SHALL terminate the response stream and return an error indication to the caller indicating that file delivery failed.
5. IF the client disconnects before the stream completes, THEN THE Secure_File_Middleware SHALL stop reading and decrypting remaining file content and release the memory and file handles associated with the transfer.

### Requirement 13: Resilient Auth-Denial Logging

**User Story:** As a maintainer, I want authorization-denial logging to use a stable mechanism, so that logging keeps working under Express 5 without monkey-patching response methods.

_Addresses the note regarding `res.json` monkey-patching in `secureFile.ts`._

#### Acceptance Criteria

1. WHEN the Secure_File_Middleware records an authorization denial, THE Secure_File_Middleware SHALL log the denial without overriding, reassigning, or wrapping the response object's `json` method or any other response method.
2. WHEN an authorization denial occurs, THE Secure_File_Middleware SHALL emit exactly one denial log entry for that request, and the entry SHALL contain the requested file identifier and a denial reason identifying the denial category (authentication failure, expired signed URL, missing module permission, or no valid owning module).
3. WHEN the denial being logged results from an authentication failure where no authenticated user is established, THE Secure_File_Middleware SHALL record the user identifier in the denial log entry as a fixed anonymous placeholder value.
4. IF writing the denial log entry fails, THEN THE Secure_File_Middleware SHALL continue processing the request without modifying the response status code or response body, and SHALL write a failure notice to the error output stream.

### Requirement 14: Non-Blocking Password Verification

**User Story:** As an end user, I want login to remain responsive under concurrent load, so that password verification does not stall the event loop.

_Addresses finding PERF-001._

#### Acceptance Criteria

1. WHEN the Auth_Service verifies a password, THE Auth_Service SHALL invoke the asynchronous bcrypt comparison and SHALL NOT invoke the synchronous bcrypt comparison.
2. WHILE the Auth_Service verifies a password inside a database transaction, THE Auth_Service SHALL await the asynchronous bcrypt comparison and SHALL yield control of the event loop until the comparison resolves.
3. WHILE the Auth_Service is processing up to 100 concurrent password verification requests, THE Auth_Service SHALL keep the measured event loop lag at or below 50 milliseconds.
4. WHEN the asynchronous bcrypt comparison resolves, THE Auth_Service SHALL complete the verification with a result of match within 1000 milliseconds of the comparison being initiated.
5. IF the asynchronous bcrypt comparison rejects or throws an error, THEN THE Auth_Service SHALL reject the verification with an error indicating that password verification failed, SHALL NOT crash the process, and SHALL roll back the enclosing database transaction so no partial changes are persisted.

### Requirement 15: Login Anti-Enumeration and Timing Safety

**User Story:** As a security engineer, I want login responses to be uniform for valid and invalid accounts, so that attackers cannot enumerate accounts via timing or message differences.

_Addresses finding SEC-008._

#### Acceptance Criteria

1. WHEN a login request references an account that does not exist, THE Auth_Service SHALL perform a bcrypt comparison against a fixed dummy hash before returning a response, and the dummy hash SHALL use the same bcrypt cost factor configured for stored user password hashes.
2. WHEN a login attempt fails because the account is unknown, the password is wrong, the account is suspended, or the account is locked, THE Auth_Service SHALL return a single generic failure response that is byte-for-byte identical across all four conditions and that does not indicate which of the four conditions occurred.
3. WHEN a login attempt fails for any of the four conditions in criterion 2, THE Auth_Service SHALL return the same response status indicator for all four conditions.
4. WHILE measuring server-side processing time over at least 1,000 login attempts per group under identical load, THE Auth_Service SHALL keep the difference between the median processing time for unknown accounts and the median processing time for existing accounts with a wrong password within 25 milliseconds, and within 25 milliseconds at the 95th percentile.
5. IF the bcrypt comparison step cannot be executed for an unknown account due to an internal error, THEN THE Auth_Service SHALL return the same generic failure response defined in criterion 2 without revealing that the account does not exist, and SHALL not alter the stored account state.

### Requirement 16: Authentication Cache Invalidation on Status Change

**User Story:** As a security engineer, I want every account suspension or disable path to invalidate the cached authentication state, so that a suspended user loses access without waiting for the cache to expire.

_Addresses finding SEC-007._

#### Acceptance Criteria

1. WHEN an account is suspended or disabled, THE System SHALL invalidate that account's cached authentication state within 1 second of the status change being committed to the authoritative store.
2. WHEN an account's role or permission set changes, THE System SHALL invalidate that account's cached authentication state within 1 second of the change being committed to the authoritative store.
3. WHILE an account's cached authentication state has been invalidated, THE Auth_Middleware SHALL re-read the account's current status and role from the authoritative store on the next request for that account rather than serving stale cached values.
4. IF invalidation of an account's cached authentication state fails, THEN THE System SHALL retry the invalidation up to 3 times and, when all attempts fail, force re-read of that account's authentication state from the authoritative store on the next request and record an error indication identifying the affected account.
5. IF the authoritative store cannot be reached while re-reading an invalidated authentication state, THEN THE Auth_Middleware SHALL deny the request and return an error indicating that the authentication state could not be verified rather than serving stale cached values.

### Requirement 17: Refresh Token Hashing at Rest

**User Story:** As a security engineer, I want refresh tokens stored only as hashes, so that a database disclosure does not expose usable session credentials.

_Addresses finding SEC-005._

#### Acceptance Criteria

1. WHEN the Auth_Service persists a refresh token, THE Auth_Service SHALL store a SHA-256 hash of the token and SHALL NOT store, log, or transmit the refresh token in plaintext in any persistent store or log output.
2. WHEN the Auth_Service validates a presented refresh token, THE Auth_Service SHALL compute the SHA-256 hash of the presented token and compare the computed hash against the stored hash for an exact, full-length match.
3. IF the computed hash of a presented refresh token does not match any stored hash, THEN THE Auth_Service SHALL reject the refresh request, SHALL NOT issue a new access token or refresh token, SHALL leave the existing session state unchanged, and SHALL return an error response indicating the refresh token is invalid.
4. IF a presented refresh token is absent, empty, or exceeds 4096 characters, THEN THE Auth_Service SHALL reject the refresh request without computing or comparing a hash and SHALL return an error response indicating the refresh token is invalid.
5. IF the Auth_Service cannot compute the SHA-256 hash while persisting a refresh token, THEN THE Auth_Service SHALL abort persistence, SHALL NOT store the refresh token in plaintext, and SHALL return an error response indicating the token could not be persisted.

### Requirement 18: Brute-Force and Password-Spraying Rate Limiting

**User Story:** As a security engineer, I want authentication rate limiting to throttle per-source attempts across usernames, so that a password-spraying attack from one source is limited.

_Addresses the note regarding `authLimiter` keying on IP plus username._

#### Acceptance Criteria

1. WHEN an authentication attempt arrives from a source IP address, THE Auth_Middleware SHALL increment a per-source-IP counter toward a configurable limit of 10 attempts within a configurable rolling window of 900 seconds, counting the attempt regardless of which username is supplied.
2. IF the per-source-IP attempt count reaches the configured limit of 10 within the configured 900-second window, THEN THE Auth_Middleware SHALL reject all subsequent authentication attempts from that source IP address without evaluating the supplied credentials, and SHALL return a rate-limit error response indicating that the attempt limit has been exceeded.
3. WHILE a source IP address is in the rejected state, THE Auth_Middleware SHALL include in each rejection response the number of seconds remaining until that source IP may resume authentication attempts.
4. WHEN the configured 900-second window elapses for a source IP address whose attempts no longer fall within the window, THE Auth_Middleware SHALL permit authentication attempts from that source IP address and resume counting from zero.

### Requirement 19: Configurable Refresh Cookie Path

**User Story:** As a platform operator, I want the refresh cookie path to follow the configured API prefix, so that deploying under a different prefix does not break token refresh.

_Addresses the note regarding the hardcoded refresh cookie path._

#### Acceptance Criteria

1. WHEN the Auth_Service sets the refresh cookie, THE Auth_Service SHALL set the cookie path to the value of the configured API prefix combined with the refresh endpoint route, such that the resulting path exactly matches the path at which the refresh endpoint is served.
2. WHILE the API prefix is configured to a non-default value, WHEN a client sends a request to the refresh endpoint, THE Auth_Service SHALL receive the refresh cookie in that request.
3. IF the API prefix configuration value is absent, empty, or contains only whitespace, THEN THE Auth_Service SHALL apply the default API prefix value and set the refresh cookie path using that default.
4. WHEN the Auth_Service sets the refresh cookie, THE Auth_Service SHALL normalize the cookie path to begin with exactly one leading "/" character and contain no trailing "/" character, except where the path is the root "/".
5. IF the configured API prefix changes between the issuance of a refresh cookie and a subsequent refresh request, THEN THE Auth_Service SHALL set the refresh cookie path on the new request using the currently configured API prefix value.

### Requirement 20: Transactional Event Dispatch

**User Story:** As a developer, I want external events emitted only after a transaction commits, so that consumers never receive events for actions that were rolled back.

_Addresses finding API-002._

#### Acceptance Criteria

1. WHILE a database transaction is open, THE Base_Service SHALL NOT perform the external HTTP call that dispatches an event, and SHALL hold each pending event in an in-memory buffer associated with that transaction.
2. WHEN a create, update, or delete transaction commits successfully, THE Event_Dispatcher SHALL dispatch each buffered event for that transaction within 5 seconds of commit completion, in the order the events were buffered.
3. IF a create, update, or delete transaction is rolled back, THEN THE Event_Dispatcher SHALL discard all buffered events for that transaction and SHALL NOT dispatch any of them.
4. IF the external HTTP call for a buffered event fails or does not receive a response within 10 seconds, THEN THE Event_Dispatcher SHALL retry the dispatch up to 3 additional attempts and, after the final failed attempt, SHALL record the dispatch failure for the affected event without rolling back the already-committed transaction.
5. WHEN all buffered events for a committed transaction have been dispatched or have exhausted their retry attempts, THE Event_Dispatcher SHALL release the in-memory buffer associated with that transaction.

### Requirement 21: Bounded Failed-Job Retention

**User Story:** As a platform operator, I want failed jobs to be capped in the queue store, so that accumulating failures cannot exhaust Redis memory.

_Addresses finding JOB-001._

#### Acceptance Criteria

1. WHEN the Queue_Manager configures a queue, THE Queue_Manager SHALL set a failed-job retention limit to a positive integer value between 1 and 100,000, defaulting to 1,000 when no value is provided.
2. WHEN a job transitions to the failed state and the count of retained failed jobs for that queue exceeds the configured retention limit, THE Queue_Manager SHALL remove retained failed jobs in order of oldest failure timestamp first until the retained count equals the configured retention limit.
3. IF the configured retention limit is absent, non-numeric, or outside the range of 1 to 100,000, THEN THE Queue_Manager SHALL reject the queue configuration, retain the previously applied valid retention limit, and return an error indicating the retention limit is invalid.

### Requirement 22: PDF Job Timeout Enforcement

**User Story:** As a platform operator, I want PDF generation jobs to have a hard timeout, so that a hung browser cannot stall workers indefinitely.

_Addresses finding JOB-002._

#### Acceptance Criteria

1. WHEN the PDF_Worker begins processing a PDF generation job, THE PDF_Worker SHALL enforce a configured maximum execution time, defaulting to 30 seconds and constrained to a range of 5 to 300 seconds, measured from the start of job processing to its completion.
2. IF the configured maximum execution time is absent, non-numeric, or outside the 5 to 300 second range, THEN THE PDF_Worker SHALL apply the default value of 30 seconds.
3. IF a PDF generation job's elapsed execution time reaches its configured maximum execution time before the job completes, THEN THE PDF_Worker SHALL abort the job within 1 second of reaching that limit.
4. WHEN the PDF_Worker aborts a job due to timeout, THE PDF_Worker SHALL release the browser instance back to the browser pool and close the associated page within 1 second of the abort.
5. WHEN a PDF generation job is aborted due to timeout, THE PDF_Worker SHALL mark the job as failed with a failure reason indicating a timeout occurred, including the elapsed execution time and the configured maximum execution time.

### Requirement 23: Graceful Shutdown and Request Draining

**User Story:** As a platform operator, I want the service to drain in-flight requests on shutdown within a bounded time, so that deploys and crashes do not abruptly drop active work.

_Addresses the note regarding shutdown lacking a timeout and uncaughtException exiting without draining._

#### Acceptance Criteria

1. WHEN the System receives a shutdown signal, THE System SHALL stop accepting new connections.
2. WHEN the System receives a shutdown signal, THE System SHALL allow in-flight requests to complete within a configured drain timeout, where the drain timeout is a configurable value between 1 and 120 seconds with a default of 30 seconds.
3. WHEN all in-flight requests complete before the configured drain timeout elapses, THE System SHALL exit with a success exit code.
4. IF in-flight requests do not complete within the configured drain timeout, THEN THE System SHALL terminate the remaining in-flight requests and exit with a non-success exit code after the timeout elapses.
5. WHEN an uncaught exception occurs, THE System SHALL stop accepting new connections and SHALL attempt to drain in-flight requests within the configured drain timeout before exiting.
6. IF in-flight requests do not complete within the configured drain timeout after an uncaught exception, THEN THE System SHALL terminate the remaining in-flight requests and exit with a non-success exit code after the timeout elapses.

### Requirement 24: Allowlist-Based Error Sanitization

**User Story:** As a security engineer, I want error responses sanitized by an allowlist, so that internal details from new or unanticipated tables are never leaked to clients.

_Addresses the note regarding blacklist-based sanitization in `error.ts`._

#### Acceptance Criteria

1. WHEN the Error_Handler produces a client-facing error response, THE Error_Handler SHALL include only fields whose names match an entry in a statically defined allowlist, and SHALL omit every field whose name does not match an allowlist entry (default-deny).
2. IF a field's name is not present on the allowlist, THEN THE Error_Handler SHALL exclude that field from the client-facing response regardless of the field's value or origin.
3. IF an error object contains internal details, including but not limited to database table or column names, SQL statement fragments, stack traces, file system paths, or internal hostnames, THEN THE Error_Handler SHALL exclude those details from the client-facing response and SHALL return a generic error indication identifying only the error category.
4. WHEN an error references a database table, column, or identifier that was introduced after the sanitization rules were authored, THE Error_Handler SHALL exclude that identifier from the client-facing response, because exclusion is driven by absence from the allowlist rather than by matching a list of known-internal terms.
5. WHEN the Error_Handler sanitizes an error for the client-facing response, THE Error_Handler SHALL preserve the complete unsanitized error detail in the server-side log entry so that no diagnostic information is lost.

### Requirement 25: Consistent Soft-Delete Semantics

**User Story:** As a developer, I want deletion to follow one consistent soft-delete model, so that records filtered by `deleted_at` are not permanently destroyed by a conflicting hard delete.

_Addresses the note regarding `BaseService.delete` performing a hard DELETE while reads filter on `deleted_at`._

#### Acceptance Criteria

1. WHEN the Base_Service deletes a record for a table that has a `deleted_at` column, THE Base_Service SHALL set that record's `deleted_at` to the current UTC timestamp via an `UPDATE` and SHALL NOT issue a hard `DELETE`.
2. WHEN the Base_Service deletes a record through the default delete path, THE Base_Service SHALL leave the record physically present in the table such that it remains retrievable through an explicit include-deleted query option.
3. WHEN a caller requests `findAll` or `findById` without an explicit include-deleted option, THE Base_Service SHALL exclude every record whose `deleted_at` is non-null from the results.
4. IF the default delete path is invoked for a target record whose `deleted_at` is already non-null, THEN THE Base_Service SHALL make no change to the record and SHALL return a not-found error indication to the caller while preserving the existing `deleted_at` value.
5. WHERE a permanent hard delete is required for a table, THE Base_Service SHALL perform the physical row removal only through an explicit operation that is named distinctly from the default delete path and is never invoked by the default delete path.

### Requirement 26: Typed Core Data-Access Layer

**User Story:** As a maintainer, I want the core database and auth-middleware layer to be typed, so that type errors are caught at compile time rather than at runtime.

_Addresses finding STRUCT-001._

#### Acceptance Criteria

1. THE Database_Layer SHALL expose its database client and its query wrapper through explicitly declared types, with zero occurrences of the implicit or explicit `any` type in their public signatures.
2. THE Auth_Middleware SHALL declare explicitly typed request and response objects for all of its request and response handlers, with zero occurrences of the implicit or explicit `any` type in their public signatures.
3. WHEN the project is type-checked, THE System SHALL report zero occurrences of implicit or explicit `any` for the database client, the query wrapper, and the auth-middleware request and response handlers.
4. IF the type-check process detects one or more occurrences of implicit or explicit `any` in the database client, the query wrapper, or any auth-middleware request or response handler, THEN THE System SHALL terminate the type-check with a non-success result and produce a diagnostic identifying each offending location, without producing build output artifacts.
5. WHEN the project is type-checked, THE System SHALL complete the type-check process and return a success result within 180 seconds when no typing violations are present.

### Requirement 27: Consolidation of Duplicated Modules

**User Story:** As a maintainer, I want duplicated implementations consolidated, so that fixes apply once and divergent behavior cannot reappear.

_Addresses finding STRUCT-002._

#### Acceptance Criteria

1. THE System SHALL expose exactly one audit-log append implementation, and every caller requiring audit-log append SHALL invoke that single implementation.
2. THE System SHALL expose exactly one migration runner module and exactly one migrations definition module.
3. THE System SHALL expose exactly one set of authentication route definitions, with no parallel `routes/auth.ts` and `routes/auth/*` implementations coexisting.
4. WHEN a consolidated module replaces former duplicate modules, THE System SHALL update every former caller to reference the consolidated module, leaving zero remaining references to the removed duplicate modules.
5. IF a build or static analysis detects more than one implementation of audit-log append, the migration runner, the migrations definition, or the authentication route definitions, THEN THE System SHALL fail the build with an error indicating which module has multiple implementations, and no consolidation artifact SHALL be published.
6. WHEN a consolidated module replaces former duplicate modules, THE System SHALL preserve the externally observable behavior of all former callers such that the existing automated test suite passes without modification to test expectations.

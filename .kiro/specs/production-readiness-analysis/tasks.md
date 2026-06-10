# Implementation Plan: Production Readiness Analysis

## Overview

This implementation plan addresses the critical gaps identified in the production readiness analysis for the alsaqi-backend application. Tasks are ordered by priority: P0 (critical) items first, followed by P1 (high), P2 (medium), and P3 (low). Each task builds incrementally on previous work, ensuring the system progresses toward full production readiness.

## Tasks

- [ ] 1. Remove PGlite Fallback in Production & Validate Environment
  - [x] 1.1 Implement fail-fast behavior for database connection in production
    - Modify `src/db/index.ts` to detect `NODE_ENV=production` and exit with non-zero code when PostgreSQL connection fails
    - Add retry logic: 3 attempts with 2-second intervals before terminating
    - Log FATAL-level message including error type (connection refused, timeout, bad credentials) and target server address
    - Remove or guard the `createPgliteClient()` fallback so it is never invoked in production
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_

  - [x] 1.2 Implement comprehensive environment variable validation at startup
    - Create `src/config/envValidator.ts` that validates all required production environment variables on boot
    - Validate presence and type correctness (URL format for DATABASE_URL, numeric for PORT, etc.)
    - Collect all missing/invalid variables and report them in a single FATAL error message before exiting within 5 seconds
    - Classify variables as required vs optional with documented defaults
    - _Requirements: 1.5, 11.2, 11.3, 11.4_

  - [-] 1.3 Write property test for Production DB Fail-Fast
    - **Property 1: Production DB Fail-Fast**
    - **Validates: Requirements 1.1, 1.2, 1.4**
    - Test that for any configuration where NODE_ENV=production and PostgreSQL connection fails, the server exits with non-zero code and never initializes PGlite

  - [-] 1.4 Write property test for Environment Variable Validation
    - **Property 17: Environment Variable Validation**
    - **Validates: Requirement 11.2**
    - Test that for any subset of required environment variables where at least one is missing, the server refuses to start and displays an error naming the missing variable

- [ ] 2. Fix Dockerfile and Container Orchestration Setup
  - [x] 2.1 Rewrite Dockerfile to match actual project structure
    - Update multi-stage Dockerfile to build from `src/main.ts` using esbuild
    - Include `packages/shared` workspace in the build context
    - Install Chromium dependencies for Puppeteer in production stage
    - Run as non-root user (UID 1001) with restricted permissions to `/app` and `/app/uploads`
    - _Requirements: 7.1, 7.5_

  - [-] 2.2 Create docker-compose.yml for local development and production
    - Define services: api (port 3000), postgres (port 5432 with named volume), redis (port 6379)
    - Configure internal bridge network and pass environment variables via .env file
    - Add health checks for postgres (pg_isready) and redis (redis-cli ping)
    - _Requirements: 7.2_

  - [-] 2.3 Implement dependency readiness checks at application startup
    - Add startup logic to verify PostgreSQL accepts TCP connections and Redis responds to PING
    - Wait up to 30 seconds with 5-second retry intervals before accepting HTTP requests
    - Exit with code 1 and log error if dependencies are not ready within timeout
    - _Requirements: 7.3, 7.4_

  - [x] 2.4 Write property test for Dependency Readiness
    - **Property 22: Dependency Readiness**
    - **Validates: Requirement 7.3**
    - Test that the system does not accept HTTP requests until PostgreSQL and Redis are confirmed ready

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Integrate Redis for Caching and State Sharing
  - [x] 4.1 Create Redis connection manager with graceful degradation
    - Create `src/cache/redisManager.ts` using ioredis with connection to REDIS_URL
    - Implement connection timeout (5 seconds), auto-reconnect (every 5 seconds, max 3 attempts)
    - On Redis unavailable: continue processing without cache, log warn, attempt reconnection
    - Refuse startup in production if REDIS_URL is not defined
    - _Requirements: 2.1, 2.4, 2.6_

  - [x] 4.2 Migrate auth cache from in-memory Map to Redis
    - Refactor `src/middleware/auth.ts` to use Redis-backed cache instead of local Map
    - Set TTL ≤ 300 seconds for auth data entries, max 10,000 cached entries
    - Ensure session_version changes invalidate cached entries across all instances
    - Fall back to no-cache mode if Redis is unavailable
    - _Requirements: 2.2, 2.5_

  - [x] 4.3 Write property test for Cache TTL Bound
    - **Property 2: Cache TTL Bound**
    - **Validates: Requirement 2.2**
    - Test that for any entry stored in the auth cache manager, TTL is ≤ 300 seconds

  - [x] 4.4 Write property test for Graceful Redis Degradation
    - **Property 3: Graceful Redis Degradation**
    - **Validates: Requirement 2.4**
    - Test that during Redis outage, the system continues processing requests successfully without cache and logs a warning

- [x] 5. Implement Redis-backed Rate Limiting
  - [x] 5.1 Replace in-memory rate limiter with Redis-backed sliding window
    - Refactor `src/middleware/rateLimiter.ts` to use Redis as shared store
    - Implement sliding window (60s) with 100 req/min authenticated, 50 req/min unauthenticated
    - Extract real client IP from X-Forwarded-For after enabling trust proxy
    - Support per-endpoint custom limits (e.g., PDF generation: 10 req/60s)
    - Return 429 with Retry-After header when limit exceeded
    - Allow request passthrough with warning log when Redis is unavailable
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 5.2 Write property tests for Rate Limiting
    - **Property 12: Real IP Extraction** - Test X-Forwarded-For parsing extracts first trusted IP
    - **Property 13: Per-Endpoint Rate Limits** - Test custom limits override defaults
    - **Property 14: Rate Limit Exceeded Response** - Test 429 response includes positive Retry-After
    - **Validates: Requirements 8.1, 8.3, 8.4**

- [x] 6. Implement Database Migration System
  - [x] 6.1 Create migration framework with transaction support and advisory locking
    - Create `src/db/migrations/migrationRunner.ts` with transactional execution per migration
    - Implement `schema_migrations` table with version, name, type (schema/seed), and executed_at (ISO 8601)
    - Add PostgreSQL advisory lock acquisition (30s timeout) to prevent concurrent migrations
    - On lock timeout: exit with error indicating another instance is running migrations
    - _Requirements: 3.1, 3.3, 3.4_

  - [x] 6.2 Implement rollback support for migrations
    - Add `down()` function support for each migration
    - Execute rollback within a single transaction, removing the record from schema_migrations
    - Reject rollback with clear error if migration has no `down()` defined
    - On failure during migration: automatically rollback all changes and halt remaining migrations
    - _Requirements: 3.2, 3.5, 3.6, 3.7_

  - [x] 6.3 Write property tests for Migration System
    - **Property 4: Migration Atomicity** - Test that failed migrations leave DB state unchanged
    - **Property 5: Migration Audit Trail** - Test successful migrations are recorded with name, date, status
    - **Property 6: Migration Rollback Round-Trip** - Test apply then rollback restores original schema
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Set Up Monitoring and Metrics System
  - [x] 8.1 Implement Prometheus metrics endpoint
    - Create `src/monitoring/metricsServer.ts` using prom-client library
    - Expose `/metrics` endpoint returning text/plain Prometheus format within 3000ms
    - Register HTTP request duration histogram (labeled by method, route template, status code)
    - Register error counter (labeled by error type and route template)
    - Exclude /metrics and /health from operational metrics
    - _Requirements: 4.1, 4.2, 4.5, 4.6_

  - [x] 8.2 Add slow query logging and Connection Pool metrics
    - Instrument database queries to detect execution > 500ms and log with query text (max 1024 chars) and duration
    - Export pool metrics (totalCount, idleCount, waitingCount, usedCount) via /metrics endpoint
    - Log warning when waitingCount > 10 (50% of max 20), no repeat until threshold is crossed again
    - Register pool event listeners: error → log error level, connect/acquire/remove → log debug level
    - _Requirements: 4.3, 4.4, 12.1, 12.2, 12.3, 12.4_

  - [x] 8.3 Write property tests for Monitoring
    - **Property 7: Slow Query Detection** - Test queries > 500ms appear in slow query log
    - **Property 8: Request Metrics Completeness** - Test every HTTP request logs duration, status, and path
    - **Property 18: Pool Exhaustion Warning** - Test warning logged when waiting > 50% of pool max
    - **Validates: Requirements 4.2, 4.3, 4.5, 12.3**

- [x] 9. Activate BullMQ Queue System for Background Jobs
  - [x] 9.1 Set up BullMQ infrastructure and queue definitions
    - Create `src/queues/queueManager.ts` configuring BullMQ with Redis connection
    - Define queues: `pdf-generation` (concurrency: 5), `notifications` (concurrency: 20)
    - Configure retry: max 3 attempts, exponential backoff starting at 2s, max 30s
    - Configure stalled job detection: 5-minute timeout with re-queue
    - Set up dead letter queue for exhausted retries
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7_

  - [x] 9.2 Implement PDF generation worker and queue integration
    - Create `src/queues/workers/pdfWorker.ts` processing PDF jobs from the queue
    - Modify existing PDF generation endpoint to enqueue job and return 202 with job ID within 500ms
    - Implement 30-second timeout per PDF render, returning browser instance to pool on timeout
    - Log job status (success/failure) and execution duration
    - _Requirements: 5.1, 5.5, 13.2, 13.3_

  - [x] 9.3 Implement notification worker and queue integration
    - Create `src/queues/workers/notificationWorker.ts` for async notification delivery
    - Modify notification sending to enqueue instead of synchronous processing
    - Return job ID to caller immediately
    - _Requirements: 5.2, 5.5_

  - [x] 9.4 Write property tests for Queue System
    - **Property 9: Async Job Processing** - Test PDF/notification requests return job ID immediately without waiting
    - **Property 10: Failed Job Retry with Backoff** - Test failed jobs retry up to 3 times with increasing intervals
    - **Property 11: Queue Concurrency Bound** - Test concurrent jobs never exceed configured limit per queue
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5**

- [x] 10. Puppeteer Production Management
  - [x] 10.1 Implement BrowserPool with limits, recycling, and crash recovery
    - Refactor `src/services/pdf` to enforce max 3 concurrent browser instances
    - Implement browser recycling after 50 pages processed
    - On browser crash: remove from pool, create replacement, re-queue the affected job
    - Run with --no-sandbox, disable GPU, disable shared memory access in Docker
    - _Requirements: 13.1, 13.4, 13.5, 7.6_

  - [x] 10.2 Write property tests for Browser Pool
    - **Property 11: Queue Concurrency Bound (Browser)** - Test browser instances never exceed 3 concurrent
    - **Property 19: Browser Pool Recovery** - Test crashed instances are removed and replaced
    - **Validates: Requirements 13.1, 13.4**

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement Log Aggregation System
  - [x] 12.1 Configure structured JSON logging with daily rotation
    - Update Winston configuration to output JSON format with: timestamp (ISO 8601), correlation_id, level, message, service name
    - Enable `winston-daily-rotate-file` transport: max 50MB per file, 30-day retention, auto-delete old files
    - Configure LOG_LEVEL environment variable support (default: info)
    - Add stdout fallback on file write failure (disk full)
    - _Requirements: 9.1, 9.2, 9.4, 9.5_

  - [x] 12.2 Ensure correlation_id propagation across all request logs
    - Verify existing correlation ID middleware generates UUID v4 and attaches to all logs during request processing
    - Ensure all service-layer and database-layer logs include correlation_id
    - _Requirements: 9.3_

  - [x] 12.3 Write property tests for Log System
    - **Property 15: Structured Log Format** - Test all production logs are valid JSON with required fields
    - **Property 16: Log Level Filtering** - Test configured level filters out lower levels correctly
    - **Validates: Requirements 9.1, 9.3, 9.4**

- [ ] 13. Implement Performance Improvements
  - [x] 13.1 Add HTTP caching headers (ETag and Cache-Control)
    - Implement ETag middleware generating content hash for API responses
    - Set Cache-Control max-age between 60s-3600s based on resource type
    - Return 304 Not Modified when If-None-Match matches current ETag
    - _Requirements: 14.1_

  - [x] 13.2 Implement cursor-based pagination for large tables
    - Create reusable cursor-based pagination utility for queries on tables with > 10,000 records
    - Default page size: 20, max page size: 100
    - Return next cursor and hasMore flag in response
    - _Requirements: 14.2_

  - [-] 13.3 Refactor Cron jobs to use batch queries
    - Identify Cron jobs with N+1 query patterns
    - Refactor to use batch queries with max 500 items per batch
    - _Requirements: 14.3_

  - [-] 13.4 Write property test for cursor-based pagination
    - **Property 20: Cursor-based Pagination Consistency**
    - **Validates: Requirement 14.2**
    - Test that pagination produces no duplicates and no missing records across consecutive pages

- [x] 14. Enhance Health Check Endpoint
  - [x] 14.1 Extend /health to include Redis and all subsystem checks
    - Add Redis health check (PING response within 2000ms)
    - Return per-subsystem status (ok/fail/timeout) with latency in ms
    - Return unhealthy (503) if any primary subsystem (database, redis) fails
    - Return degraded (200) if primary systems ok but secondary (filesystem, websocket, memory, cron) fails
    - Include uptime (seconds) and version string in response
    - Return partial results with timeout status if total check exceeds 3000ms
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [x] 14.2 Write property test for Health Check
    - **Property 21: Health Status Correctness**
    - **Validates: Requirements 15.2, 15.3**
    - Test that unhealthy primary subsystem → 503, all primary ok with secondary down → degraded 200

- [x] 15. Set Up CI/CD Pipeline
  - [x] 15.1 Create GitHub Actions CI workflow
    - Create `.github/workflows/ci.yml` running on pull requests
    - Steps: typecheck, test, npm audit, within 15 minutes max
    - Fail PR merge if any check fails; report failing step name and error message
    - Fail if npm audit finds high/critical vulnerabilities with affected package list
    - _Requirements: 6.1, 6.3, 6.4_

  - [x] 15.2 Create GitHub Actions CD workflow for Docker build and push
    - Create `.github/workflows/cd.yml` triggered on main branch merge
    - Build Docker image, tag with short commit SHA
    - Scan image with Trivy; fail if high+ vulnerabilities found
    - Push to configured container registry
    - _Requirements: 6.2, 6.5_

  - [x] 15.3 Add security scanning to CI pipeline
    - Add npm audit step with severity-based gating (block on high/critical)
    - Add Trivy container scan (block on high+, allow moderate/low with warning)
    - Add secret detection (API keys, tokens, passwords, private keys) via pre-commit or CI step
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 16. Create Production Environment Documentation
  - [x] 16.1 Create .env.production.example with all production variables
    - Document every environment variable used in source code
    - Classify by function: server, database, auth, encryption, backup, external integrations
    - Include for each: name, one-sentence description, expected type, non-real example value
    - Mark required vs optional with defaults documented as adjacent comments
    - _Requirements: 11.1, 11.4_

- [x] 17. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation language is TypeScript throughout, matching the existing codebase
- Redis (ioredis) and BullMQ are already in package.json dependencies but unused — they need to be activated
- Priority order follows P0 → P1 → P2 → P3 as outlined in the design document

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.2", "2.3"] },
    { "id": 2, "tasks": ["2.4", "4.1", "16.1"] },
    { "id": 3, "tasks": ["4.2", "5.1", "6.1"] },
    { "id": 4, "tasks": ["4.3", "4.4", "5.2", "6.2"] },
    { "id": 5, "tasks": ["6.3", "8.1", "9.1"] },
    { "id": 6, "tasks": ["8.2", "9.2", "9.3"] },
    { "id": 7, "tasks": ["8.3", "9.4", "10.1"] },
    { "id": 8, "tasks": ["10.2", "12.1"] },
    { "id": 9, "tasks": ["12.2", "12.3", "13.1", "13.2"] },
    { "id": 10, "tasks": ["13.3", "13.4", "14.1"] },
    { "id": 11, "tasks": ["14.2", "15.1"] },
    { "id": 12, "tasks": ["15.2", "15.3"] }
  ]
}
```

# alsaqi-backend

A production-grade REST API server for an internal audit, risk, and governance management platform. Built with TypeScript, Express 5, PostgreSQL, and Redis, it powers audit programs, findings, recommendations, correspondence, compliance, and organizational governance workflows.

The server is API-only: it exposes a versioned `/api/v1` surface and does **not** serve any frontend assets.

## Features

- **Versioned REST API** under `/api/v1` with automatic fallback rewrite from `/api/*` and unsupported-version handling.
- **Authentication & Authorization** using JWT (HS256 secret + RS256 asymmetric keys), session management, and TOTP-based two-factor authentication.
- **Fine-grained RBAC** with a module/permission registry, role management, per-user permission overrides, and a permission audit trail.
- **Audit domain modules**: audit programs, audit tasks, audit findings, recommendations, risk register, compliance, fraud access requests, conflict-of-interest (COI), policies, and regulatory tracking.
- **Correspondence & document workflows** with file uploads, at-rest file encryption, and signed secure-file access URLs.
- **PDF generation** via Puppeteer (Handlebars templates) with a managed browser pool.
- **Background jobs** powered by BullMQ on Redis (notifications and async processing).
- **Real-time notifications** over WebSockets with heartbeat and authenticated connections.
- **Caching & rate limiting** backed by Redis, with idempotency-key support for safe retries.
- **Observability**: Prometheus metrics, Winston logging with daily rotation, correlation IDs, and request logging.
- **Resilience**: circuit breaker, dependency readiness checks on startup, graceful shutdown, and scheduled cron jobs (backups, partition management).
- **Hardened HTTP layer**: Helmet, CORS allow-listing, CSRF protection, compression, and body-size limits.

## Tech Stack

| Concern | Technology |
|---|---|
| Runtime | Node.js 20, ES Modules |
| Language | TypeScript ~5.9 |
| Web framework | Express 5 |
| Database | PostgreSQL (`pg`) with connection pooling |
| Cache / Queues | Redis (`ioredis`, BullMQ) |
| Validation | Zod (shared schemas) |
| Auth | `jsonwebtoken`, `bcryptjs`, `otpauth` (TOTP) |
| PDF | Puppeteer + Handlebars |
| Storage | AWS S3 SDK + local uploads |
| Monitoring | `prom-client`, Winston |
| Build | esbuild |
| Tests | Vitest, Supertest, fast-check (property-based) |

## Project Structure

```
alsaqi-backend/
├── src/
│   ├── main.ts              # Standalone entry point (env parsing, startup)
│   ├── index.ts             # createApiServer factory (middleware + lifecycle)
│   ├── routes/              # HTTP route modules (v1 router, auth, domain routes)
│   ├── services/            # Business logic (Audit, Auth, Permission, PDF, etc.)
│   ├── middleware/          # CORS, CSRF, auth, rate limiting, error handling, etc.
│   ├── db/                  # DB connection, migrations, migration runner
│   ├── queues/              # BullMQ queue manager and workers
│   ├── ws/                  # WebSocket server, auth, notifications
│   ├── permissions/         # RBAC module registry, seeder, types
│   ├── cache/               # Redis manager
│   ├── monitoring/          # Prometheus metrics server
│   ├── cron/                # Scheduled jobs
│   ├── config/              # Environment validation
│   ├── schemas/             # Zod request schemas
│   └── utils/               # Logger, CRUD generator, pagination, key store, etc.
├── packages/
│   └── shared/              # @alsaqi/shared — shared types, enums, validators, constants
├── database/                # schema.sql and DATABASE_SCHEMA.md
├── data/                    # Persistent data (encrypted RSA keys)
├── Dockerfile               # Multi-stage build (esbuild → node:20-slim)
├── docker-compose.yml       # API + PostgreSQL + Redis orchestration
└── package.json             # npm workspaces root
```

This is an npm **workspaces** monorepo: the root API package depends on the `@alsaqi/shared` package for shared types, enums, Zod validators, and constants.

## Prerequisites

- Node.js 20+
- npm 9+ (workspaces support)
- PostgreSQL 15+
- Redis 7+
- For PDF generation outside Docker: Chromium and its system libraries (bundled automatically in the Docker image)

## Getting Started

### 1. Install dependencies

```bash
npm ci --include-workspace-root
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your local values. For local development the server provides safe fallbacks (dev JWT secret, auto-generated RSA keys), so a minimal setup only needs `DATABASE_URL` for full functionality. See `.env.production.example` for the complete, documented list of variables.

### 3. Run the development server

```bash
npm run dev
```

This starts the server with `tsx --watch` on `PORT` (default `3000`). On startup the server validates environment variables, checks dependency readiness (in production), connects to PostgreSQL, and runs pending migrations automatically.

Health check: `GET http://localhost:3000/api/health`

## Environment Variables

Key variables (full reference in `.env.production.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | optional | `development` | `development` \| `production` \| `test` |
| `PORT` | optional | `3000` | HTTP listening port |
| `CORS_ORIGIN` | required (prod) | `http://localhost:5173` (dev) | Comma-separated allowed origins |
| `DATABASE_URL` | required (prod) | — | PostgreSQL connection string |
| `JWT_SECRET` | required (prod) | dev fallback | JWT signing secret (min 64 chars in prod) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | optional | auto-generated | RSA PEM keys for asymmetric JWT |
| `REDIS_URL` | required (prod) | — | Redis connection URL |
| `REDIS_PASSWORD` | required (prod) | — | Redis auth password |
| `UPLOAD_DIR` | optional | `./uploads` | Upload storage directory |
| `DATA_DIR` | optional | `./data` | Persistent data (encrypted RSA keys) |
| `FILE_ENCRYPTION_KEY` | optional | — | AES key for at-rest file encryption |
| `N8N_WEBHOOK_URL` | optional | — | n8n automation webhook (graceful if unset) |

> Note: In production, the server validates required variables on startup and will refuse to start (fast exit) if any are missing or invalid.

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (`tsx --watch`) |
| `npm run build` | Bundle `src/main.ts` → `dist/server.js` with esbuild |
| `npm start` | Run the bundled production server |
| `npm run typecheck` | Type-check the project (`tsc --noEmit`) |
| `npm test` | Run the test suite once (Vitest) |
| `npm run clean` | Remove the `dist/` directory |

## API Overview

All endpoints are served under `/api/v1`. Requests to `/api/{resource}` without a version prefix are transparently rewritten to `/api/v1/{resource}` for backward compatibility. Every `/api/` response includes an `X-API-Version` header.

- **Response envelope**: JSON responses are wrapped in a consistent `ApiResponse` envelope (success/error, data, pagination).
- **Health**: `GET /api/v1/health` (and `/api/health`) for liveness/readiness.
- **OpenAPI**: `GET /api/v1/docs` returns the OpenAPI specification (YAML).

Representative route groups:

- `auth` — login, refresh, register, 2FA
- `users`, `roles`, `job-titles`, `user-sessions`, `departments`, `org-entities`
- `audit-programs`, `audit-tasks`, `audit-findings`, `recommendations`
- `correspondence`, `compliance`, `fraud-access-requests`, `coi`, `policies`
- `analytics`, `dashboard`, `executive-reports`, `notifications`, `comments`
- `bulk`, `admin` (backups), permission administration, archive

### Security middleware

The middleware stack applies compression, Helmet security headers, CORS allow-listing, body parsing with size limits, correlation IDs, the response wrapper, Redis-backed rate limiting (100 req/60s authenticated, 50 req/60s unauthenticated), and CSRF protection on state-changing requests (login/refresh/register are exempt).

## Database & Migrations

The schema lives in `database/schema.sql` with documentation in `database/DATABASE_SCHEMA.md`. On startup the server connects to PostgreSQL and runs both base migrations and versioned migrations (via `MigrationRunner`) automatically—no manual migration step is required.

## Testing

```bash
npm test
```

The suite uses Vitest with Supertest for HTTP integration tests and fast-check for property-based testing. Tests are colocated in `__tests__/` directories and `*.test.ts` / `*.property.test.ts` files, covering services, middleware, schemas, migrations, and end-to-end deployment scenarios.

## Deployment (Docker)

The provided `docker-compose.yml` orchestrates the API alongside PostgreSQL and Redis. PostgreSQL and Redis are internal-only (no host ports); only the API exposes port `3000`.

```bash
# Build and start the full stack
docker compose up --build -d

# Tail logs
docker compose logs -f api
```

The multi-stage `Dockerfile` builds the bundle with esbuild, installs Chromium dependencies for Puppeteer, runs as a non-root user (UID 1001), and includes a `HEALTHCHECK` against `/api/health`.

Continuous integration and deployment workflows are defined in `.github/workflows/ci.yml` and `.github/workflows/cd.yml`.

## License

Private — all rights reserved.

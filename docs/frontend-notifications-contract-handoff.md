# Frontend Handoff — Notifications & Auth Contract Changes

> **AUDIENCE:** The implementing assistant/developer working in the **frontend** repository
> (`alsaqi`, the `@alsaqi/web` app). These are STRICT instructions. Implement them EXACTLY.
> Do not improvise, refactor, rename, reformat, or "improve" anything beyond what is written here.

---

## 0. Scope & Hard Rules (READ FIRST)

1. This handoff covers **four** contract changes only:
   - (a) `PUT /notifications/mark-all-read` — **BREAKING** response shape change.
   - (b) `GET /notifications` — **CLARIFICATION** (no behavior change; the shared contract was corrected).
   - (c) `PUT /notifications/mark-read` — **NEW** bulk mark-read endpoint.
   - (d) `POST /auth/register` — **NEW** admin-only user-registration endpoint.
2. **Do NOT** change any other endpoint, path, or behavior based on this document.
3. **Do NOT** change the `/api/...` prefix or the `credentials: 'include'` style already used by existing calls.
4. **Preserve** the existing code style (indentation = 2 spaces, single quotes, existing patterns).
5. Every `/api` response is wrapped in the standard **Success_Envelope** / **Error_Envelope**. The
   payload you care about lives in the top-level `data` field; list pagination lives in
   `meta.pagination`. Do NOT read list items or `updated` counts from the HTTP body root.
6. After implementing, run `npm run typecheck -w @alsaqi/web` and `npm run lint -w @alsaqi/web`.
   Both MUST pass with zero new errors/warnings.
7. Do NOT push directly to `main`. Use a feature branch and open a PR.

---

## 1. Background (why)

The backend API contract was aligned with the unified frontend contract. Two notification
endpoints changed/were added and one auth endpoint was added. The envelope convention is now
explicit across the whole `/api` surface:

```jsonc
// Success_Envelope
{ "success": true,  "data": <payload>, "meta": { "pagination": { ... } /* lists only */ } }

// Error_Envelope
{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }
```

For every endpoint below, read the payload from `response.data` (and, for `GET /notifications`,
read pagination from `response.meta.pagination`). The sections are written as
**OLD shape → NEW shape → required frontend action**.

---

## 2. Endpoint changes

### (a) `PUT /notifications/mark-all-read` — BREAKING (R13.2)

Marks all of the current user's unread notifications as read.

**OLD shape** — the `data` payload was a success flag:

```jsonc
{ "success": true, "data": { "success": true } }
```

**NEW shape** — the `data` payload is now a count of how many notifications were marked read:

```jsonc
{ "success": true, "data": { "updated": 7 } }
```

**REQUIRED FRONTEND ACTION:**
- Stop relying on `data.success` from this endpoint's payload.
- Read `data.updated` (a `number`) — the count of notifications that were marked read.
- If your UI needs to know whether the operation succeeded, rely on the HTTP status / the
  top-level envelope `success` flag, NOT on a `data.success` field (it no longer exists).

---

### (b) `GET /notifications` — CLARIFICATION (R13.3)

Returns the current user's notifications, paginated.

**OLD shape (contract illusion)** — the shared contract gave the impression of a bare top-level array:

```jsonc
// (misleading) bare array
[ { "id": "...", "title": "...", "is_read": false /* ... */ }, /* ... */ ]
```

**NEW shape (documented reality)** — it always was, and remains, a paginated Success_Envelope.
The notification items live in `data`, and pagination lives in `meta.pagination`. The shared
`@alsaqi/shared` contract was corrected to match this reality (no backend behavior changed):

```jsonc
{
  "success": true,
  "data": [ { "id": "...", "title": "...", "is_read": false /* ... */ }, /* ... */ ],
  "meta": {
    "pagination": { "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 }
  }
}
```

**REQUIRED FRONTEND ACTION:**
- Any frontend code that assumed a bare top-level `Notification[]` MUST read the items from the
  envelope `data` field.
- Read pagination (page, pageSize, total, totalPages) from `meta.pagination`, not from the body root.

---

### (c) `PUT /notifications/mark-read` — NEW bulk endpoint (R13.4)

A new bulk endpoint that marks a specific list of the current user's notifications as read in one call.

**OLD shape** — did not exist (previously you had to mark notifications one at a time via
`PUT /notifications/:id/read`).

**NEW shape:**

```jsonc
// Request body
{ "notification_ids": ["id-1", "id-2", 3, 4] }   // Array<string | number>

// Success response
{ "success": true, "data": { "updated": 3 } }

// Error response (missing or non-array notification_ids) — HTTP 400
{ "success": false, "data": null, "error": { "code": "...", "message": "..." } }
```

**REQUIRED FRONTEND ACTION:**
- Where the UI currently loops and calls `PUT /notifications/:id/read` repeatedly (e.g. a
  "mark selected as read" action), replace it with a single `PUT /notifications/mark-read` call
  passing `{ notification_ids: [...] }`.
- Send `notification_ids` as a non-empty array; sending a missing or non-array value returns HTTP 400.
- Read the number of notifications actually updated from `data.updated`.
- `PUT /notifications/:id/read` still exists and is unchanged — keep using it for single-item cases.

---

### (d) `POST /auth/register` — NEW admin-only endpoint (R13.5)

A new endpoint for creating user accounts. It is **authenticated and admin-guarded** (requires the
`UserManagement / Create` permission) and is **CSRF-protected** like other mutating endpoints.

**OLD shape** — not implemented (account creation was only available via `POST /users`).

**NEW shape:**

```jsonc
// POST /api/auth/register   (requires auth + UserManagement/Create permission + CSRF token)
// Request body (RegisterInput)
{
  "username": "jdoe",            // required, 3–50 chars
  "password": "secret123",       // required, 6–100 chars
  "name": "Jane Doe",            // required, 1–100 chars
  "email": "jane@example.com",   // required, valid email, <= 255 chars
  "role": "Manager",             // required, 1–50 chars
  "department": null,            // optional/nullable
  "job_title_id": null,          // optional/nullable
  "unit": null,                  // optional/nullable
  "reporting_manager_id": null,  // optional/nullable
  "access_scope": null,          // optional/nullable
  "phone_number": null,          // optional/nullable
  "notes": null,                 // optional/nullable
  "status": "Active"             // optional, one of "Active" | "Inactive" | "Suspended"
}

// Success response — HTTP 201
{ "success": true, "data": { "user": { /* created user */ } } }

// Error responses
// 401 — not authenticated
// 403 — authenticated but missing UserManagement/Create permission
// 400 — validation failure (Error_Envelope)
// 409 — duplicate username or email (Error_Envelope identifying the duplicate field)
```

**REQUIRED FRONTEND ACTION:**
- Only expose this endpoint to admin users who hold the `UserManagement / Create` permission;
  expect `403` otherwise.
- This is a mutating endpoint behind CSRF protection — send the CSRF token exactly as you already
  do for other mutating `/api` calls (do NOT treat it as exempt).
- Read the created user from `data.user`. Handle `409` to show a "username/email already exists"
  message, and `400` for validation errors.

---

## 3. Endpoints added to the shared contract only — NO frontend behavior change

For completeness: the following endpoints were added to the `@alsaqi/shared` contract types in this
release but their **runtime behavior did not change**. No frontend action is required beyond
benefiting from the now-typed contract:

- `GET /notifications/unread-count` → `data: { count: number }`
- `PUT /notifications/:id/read` → `data: { success: boolean }` (unchanged single-item mark-read)
- `DELETE /notifications/:id` → `data: { success: boolean }`

---

## 4. Mandatory Verification (must do before handing back)

Run from the frontend repo root:

```bash
npm run typecheck -w @alsaqi/web
npm run lint -w @alsaqi/web
```

Both MUST be clean.

### Manual smoke test
1. `mark-all-read`: trigger it and confirm the UI reads `data.updated` (a number), not `data.success`.
2. `GET /notifications`: confirm the list reads items from `data` and pagination from `meta.pagination`.
3. `mark-read`: select several notifications, fire one bulk call, confirm `data.updated` matches.
4. `POST /auth/register`: as an admin, create a user → expect `201` with `data.user`; as a
   non-admin, expect `403`; duplicate username/email → expect `409`.

---

## 5. What you MUST NOT do (explicit don'ts)

- ❌ Do not read `data.success` from `mark-all-read` (it was removed; use `data.updated`).
- ❌ Do not treat `GET /notifications` as a bare top-level array.
- ❌ Do not call `POST /auth/register` without the CSRF token or for non-admin users.
- ❌ Do not change the `/api/...` prefix, add libraries, or reformat untouched code.
- ❌ Do not push directly to `main`. Use a feature branch and open a PR.

End of instructions.

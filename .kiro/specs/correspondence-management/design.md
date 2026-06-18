# Design Document: Correspondence Management

## Overview

This design hardens the Correspondence module's API layer by introducing database-aligned enum validation via Zod schemas at the route level, proper HTTP 404 responses for missing resources, and a consistent error response format. The architecture centralizes enum constants in the shared package so that route-level schemas, shared validators, and the frontend all reference a single source of truth.

## Architecture

The solution introduces a thin validation layer between the Express route handler and the existing `CorrespondenceService`:

```
Request → authenticate → checkPermission → Zod Schema (enum-constrained) → Route Handler → Service → DB
                                              ↓ (invalid)
                                         400 JSON error envelope
```

For 404 handling, the `CorrespondenceService` already throws `NotFoundError` (which the global error handler maps to 404). The changes ensure that update/delete operations explicitly check for record existence before proceeding, rather than silently succeeding when no rows are affected.

### Key Architectural Decisions

1. **Enum constants live in `packages/shared/src/constants/correspondence.ts`** — a new file exporting typed arrays. Both the route-level schemas and the shared validator schemas import from here.
2. **Route-level schemas use `z.enum()`** with the shared constant arrays, replacing the current permissive `z.string().optional()` definitions.
3. **Status validation is type-aware** — the status update endpoint selects the correct enum array (`INCOMING_STATUSES` vs `OUTGOING_STATUSES`) based on the `:type` path parameter.
4. **404 detection in service layer** — update and delete methods check affected row count and throw `NotFoundError` when zero rows are modified.
5. **Response format reuses existing `createErrorResponse` envelope** — no new response structure needed.

## Components and Interfaces

### 1. Shared Enum Constants (`packages/shared/src/constants/correspondence.ts`)

New file exporting all correspondence enum arrays as `const` tuples:

```typescript
// packages/shared/src/constants/correspondence.ts

export const INCOMING_STATUSES = [
  'Received', 'Registered', 'Under Review', 'Referred',
  'Action Taken', 'Closed', 'Archived', 'Cancelled'
] as const;

export const OUTGOING_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Sent',
  'Delivered', 'Archived', 'Cancelled'
] as const;

export const PRIORITIES = [
  'Normal', 'Urgent', 'Very Urgent', 'Confidential', 'Restricted'
] as const;

export const CLASSIFICATIONS = [
  'General', 'Audit Related', 'Compliance',
  'Administrative', 'Financial', 'HR Related'
] as const;

export const METHODS = [
  'Official Mail', 'Hand Delivery', 'Electronic System', 'Email'
] as const;

export const ENTITY_TYPES = [
  'Government', 'Private', 'Internal', 'Regulatory'
] as const;

export const REFERRAL_STATUSES = [
  'Pending', 'Acknowledged', 'Completed', 'Returned'
] as const;

export const LINK_TYPES = [
  'Reply', 'Follow-up', 'Related'
] as const;

export type IncomingStatus = typeof INCOMING_STATUSES[number];
export type OutgoingStatus = typeof OUTGOING_STATUSES[number];
export type Priority = typeof PRIORITIES[number];
export type Classification = typeof CLASSIFICATIONS[number];
export type Method = typeof METHODS[number];
export type EntityType = typeof ENTITY_TYPES[number];
export type ReferralStatus = typeof REFERRAL_STATUSES[number];
export type LinkType = typeof LINK_TYPES[number];
```

### 2. Updated Route-Level Schemas (`src/routes/correspondence.ts`)

The existing `incomingSchema`, `outgoingSchema`, `linkSchema`, and `statusUpdateSchema` are updated to use `z.enum()` referencing the shared constants:

```typescript
import {
  PRIORITIES, CLASSIFICATIONS, METHODS, ENTITY_TYPES,
  INCOMING_STATUSES, OUTGOING_STATUSES, LINK_TYPES
} from '@alsaqi/shared';

const incomingSchema = z.object({
  // ... string fields unchanged ...
  sender_entity_type: z.enum(ENTITY_TYPES).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  method: z.enum(METHODS).optional(),
  // ... remaining fields unchanged ...
});

const outgoingSchema = z.object({
  // ... string fields unchanged ...
  classification: z.enum(CLASSIFICATIONS).optional(),
  sending_method: z.enum(METHODS).optional(),
  // ... remaining fields unchanged ...
});

const linkSchema = z.object({
  incoming_id: z.string().uuid(),
  outgoing_id: z.string().uuid(),
  link_type: z.enum(LINK_TYPES).optional().default('Reply'),
});

// Status update uses a factory that picks the right enum based on type
const incomingStatusUpdateSchema = z.object({
  new_status: z.enum(INCOMING_STATUSES),
  notes: z.string().optional().nullable(),
});

const outgoingStatusUpdateSchema = z.object({
  new_status: z.enum(OUTGOING_STATUSES),
  notes: z.string().optional().nullable(),
});
```

### 3. Updated Shared Validators (`packages/shared/src/validators/correspondence.ts`)

Replace `z.string().min(1).max(50).optional()` with `z.enum()` calls referencing the same shared constants:

```typescript
import {
  PRIORITIES, CLASSIFICATIONS, METHODS, ENTITY_TYPES, LINK_TYPES
} from '../constants/correspondence';

export const CreateIncomingCorrespondenceSchema = z.object({
  // ... unchanged string fields ...
  sender_entity_type: z.enum(ENTITY_TYPES).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  method: z.enum(METHODS).optional(),
  // ... remaining fields unchanged ...
});
```

### 4. Service Layer 404 Detection (`src/services/CorrespondenceService.ts`)

The `updateIncoming`, `deleteIncoming`, `updateOutgoing`, and `deleteOutgoing` methods are updated to check affected row count:

```typescript
static async updateIncoming(id: string | number, data: any) {
  // ... build fields/values as before ...
  const result = await this.db.prepare(
    `UPDATE incoming_correspondence SET ${fields.join(', ')} WHERE id = ?::uuid AND deleted_at IS NULL`
  ).run(...values, id);

  if (result.changes === 0) {
    throw new NotFoundError('Incoming correspondence record not found');
  }
}

static async deleteIncoming(id: string | number) {
  const result = await this.db.prepare(
    "UPDATE incoming_correspondence SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL"
  ).run(id);

  if (result.changes === 0) {
    throw new NotFoundError('Incoming correspondence record not found');
  }
  // ... cascade soft-delete attachments ...
}
```

### 5. Status Update Route Handler Enhancement

The status update route selects the schema dynamically:

```typescript
router.put("/status/:type/:id", authenticate, checkPermission('Correspondence', 'Edit'),
  validateParams(typeIdParamSchema),
  asyncHandler(async (req, res) => {
    const type = req.params.type as string;
    const schema = type === 'outgoing' ? outgoingStatusUpdateSchema : incomingStatusUpdateSchema;
    const validation = schema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid status update data", validation.error.format());
    }
    // ... proceed with service call ...
  })
);
```

### 6. Interfaces

#### Error Response Envelope (existing, reused)

```typescript
interface ErrorResponse {
  success: false;
  data: null;
  error: {
    code: string;        // e.g. 'VALIDATION_ERROR' or 'NOT_FOUND'
    message: string;     // Human-readable description
    traceId: string;     // UUID for log correlation
    details?: Array<{    // Present for validation errors
      path: string;      // Field path, e.g. 'priority'
      message: string;   // e.g. "Invalid enum value. Expected 'Normal' | 'Urgent' | ..."
      code: string;      // Zod issue code, e.g. 'invalid_enum_value'
    }>;
  };
  meta: {
    requestId: string;
    timestamp: string;
    version: string;
  };
}
```

#### Validation Error (HTTP 400) Example

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "traceId": "a1b2c3d4-...",
    "details": [
      {
        "path": "priority",
        "message": "Invalid enum value. Expected 'Normal' | 'Urgent' | 'Very Urgent' | 'Confidential' | 'Restricted', received 'InvalidValue'",
        "code": "invalid_enum_value"
      }
    ]
  },
  "meta": { "requestId": "...", "timestamp": "...", "version": "1.0.0" }
}
```

#### Not Found Error (HTTP 404) Example

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "NOT_FOUND",
    "message": "Incoming correspondence record not found",
    "traceId": "e5f6g7h8-..."
  },
  "meta": { "requestId": "...", "timestamp": "...", "version": "1.0.0" }
}
```

## Data Models

No new database tables or columns are introduced. The existing PostgreSQL CHECK constraints define the ground truth:

| Field | Table | Allowed Values |
|-------|-------|---------------|
| `priority` | `incoming_correspondence` | Normal, Urgent, Very Urgent, Confidential, Restricted |
| `classification` | `incoming_correspondence`, `outgoing_correspondence` | General, Audit Related, Compliance, Administrative, Financial, HR Related |
| `method` | `incoming_correspondence`, `outgoing_correspondence` | Official Mail, Hand Delivery, Electronic System, Email |
| `sender_entity_type` | `incoming_correspondence` | Government, Private, Internal, Regulatory |
| `status` (incoming) | `incoming_correspondence` | Received, Registered, Under Review, Referred, Action Taken, Closed, Archived, Cancelled |
| `status` (outgoing) | `outgoing_correspondence` | Draft, Pending Approval, Approved, Sent, Delivered, Archived, Cancelled |
| `link_type` | `correspondence_links` | Reply, Follow-up, Related |
| `status` (referral) | `correspondence_referrals` | Pending, Acknowledged, Completed, Returned |

## Error Handling

| Scenario | HTTP Status | Error Code | Details |
|----------|-------------|-----------|---------|
| Invalid enum value in request body | 400 | `VALIDATION_ERROR` | Field-level error with allowed values |
| Missing required field | 400 | `VALIDATION_ERROR` | Field-level error with `required` code |
| Record not found (update/delete/get) | 404 | `NOT_FOUND` | Message identifying the resource type |
| Invalid path parameter format | 400 | `VALIDATION_ERROR` | Parameter-level error |

All errors flow through the existing `createErrorResponse` envelope to ensure consistent JSON structure.

## Testing Strategy

### Unit Tests (Example-Based)
- **404 handling**: Verify that PUT, DELETE, and GET detail endpoints return 404 with correct body structure when targeting a non-existent UUID (Requirements 5.1–5.3, 6.1–6.3)
- **Schema default behavior**: Verify `link_type` defaults to `'Reply'` when omitted (Requirement 4.2)

### Property-Based Tests (fast-check, 100+ iterations)
- **Invalid enum rejection**: Generate random strings outside each enum set and verify 400 rejection across all enum-constrained fields
- **Valid enum acceptance**: Generate values sampled from allowed sets and verify no enum validation failure
- **Response structure invariants**: Verify all 404 and 400 responses conform to the canonical envelope structure
- **Validator sync**: Assert that route-level and shared-validator schemas accept/reject the same values for each enum field

### Integration Tests
- **End-to-end validation flow**: Submit actual HTTP requests via supertest to confirm the middleware pipeline (auth → permission → validation → service → response) works correctly
- **Database CHECK constraint alignment**: Confirm that the shared constant arrays match the PostgreSQL CHECK constraints (manual/seed verification)

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Invalid enum values are rejected

*For any* correspondence API endpoint that accepts an enum field (priority, classification, method, sender_entity_type, sending_method, new_status, link_type), and *for any* string value that is NOT a member of that field's defined allowed-value set, the endpoint SHALL return HTTP 400 with `error.code` equal to `'VALIDATION_ERROR'` and `error.details` containing at least one entry referencing the offending field.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 4.1**

### Property 2: Valid enum values are accepted

*For any* correspondence API endpoint that accepts an enum field, and *for any* value that IS a member of that field's defined allowed-value set (or when the optional field is omitted), the enum validation SHALL NOT reject the request (the request may still fail for other reasons, but not due to enum validation).

**Validates: Requirements 1.6, 2.4, 3.3, 4.2**

### Property 3: 404 response structure invariant

*For any* request to the correspondence module that targets a non-existent resource (by ID), the response SHALL have HTTP status 404, Content-Type `application/json`, and a body where `success === false`, `error.code === 'NOT_FOUND'`, and `error.message` is a non-empty string describing the missing resource.

**Validates: Requirements 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3**

### Property 4: Validation error response structure invariant

*For any* request to the correspondence module that fails enum validation, the response SHALL have HTTP status 400, Content-Type `application/json`, and a body where `success === false`, `error.code === 'VALIDATION_ERROR'`, `error.message` is a non-empty string, and `error.details` is a non-empty array of objects each containing `path`, `message`, and `code` string fields.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 5: Shared validator and route schema synchronization

*For any* enum field defined in the correspondence module, the set of values accepted by the route-level Zod schema SHALL be exactly equal to the set of values accepted by the corresponding shared validator schema in `packages/shared/src/validators/correspondence.ts`.

**Validates: Requirements 9.1, 9.2, 9.3**

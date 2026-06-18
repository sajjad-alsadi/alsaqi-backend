# Requirements Document

## Introduction

This feature hardens the existing Correspondence module API layer by enforcing database-level enum constraints via Zod schemas at the route level, and by returning proper HTTP 404 responses when operations target non-existent records. The goal is to prevent invalid data from reaching the database and provide meaningful error responses to API consumers.

## Glossary

- **Correspondence_API**: The Express route layer defined in `src/routes/correspondence.ts` that handles HTTP requests for the correspondence module
- **Incoming_Schema**: The Zod validation schema used for creating and updating incoming correspondence records
- **Outgoing_Schema**: The Zod validation schema used for creating and updating outgoing correspondence records
- **Status_Update_Schema**: The Zod validation schema used for status change requests
- **Link_Schema**: The Zod validation schema used for linking incoming and outgoing correspondence
- **Correspondence_Service**: The service class (`CorrespondenceService`) that executes database queries for correspondence operations
- **Incoming_Status**: The set of valid status values for incoming correspondence: 'Received', 'Registered', 'Under Review', 'Referred', 'Action Taken', 'Closed', 'Archived', 'Cancelled'
- **Outgoing_Status**: The set of valid status values for outgoing correspondence: 'Draft', 'Pending Approval', 'Approved', 'Sent', 'Delivered', 'Archived', 'Cancelled'
- **Priority_Enum**: The set of valid priority values: 'Normal', 'Urgent', 'Very Urgent', 'Confidential', 'Restricted'
- **Classification_Enum**: The set of valid classification values: 'General', 'Audit Related', 'Compliance', 'Administrative', 'Financial', 'HR Related'
- **Method_Enum**: The set of valid correspondence delivery method values: 'Official Mail', 'Hand Delivery', 'Electronic System', 'Email'
- **Entity_Type_Enum**: The set of valid sender/recipient entity type values: 'Government', 'Private', 'Internal', 'Regulatory'
- **Referral_Status_Enum**: The set of valid referral status values: 'Pending', 'Acknowledged', 'Completed', 'Returned'
- **Link_Type_Enum**: The set of valid correspondence link type values: 'Reply', 'Follow-up', 'Related'

## Requirements

### Requirement 1: Incoming Correspondence Enum Validation

**User Story:** As an API consumer, I want the incoming correspondence creation and update endpoints to reject requests with invalid enum values, so that only database-compatible data is accepted.

#### Acceptance Criteria

1. WHEN a POST request is submitted to the incoming correspondence endpoint with a `priority` value not in Priority_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
2. WHEN a POST request is submitted to the incoming correspondence endpoint with a `classification` value not in Classification_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
3. WHEN a POST request is submitted to the incoming correspondence endpoint with a `method` value not in Method_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
4. WHEN a POST request is submitted to the incoming correspondence endpoint with a `sender_entity_type` value not in Entity_Type_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
5. WHEN a PUT request is submitted to the incoming correspondence endpoint with any enum field containing an invalid value, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values for the offending field.
6. WHEN a POST or PUT request is submitted with valid enum values or with optional enum fields omitted, THE Correspondence_API SHALL accept the request and proceed with processing.

### Requirement 2: Outgoing Correspondence Enum Validation

**User Story:** As an API consumer, I want the outgoing correspondence creation and update endpoints to reject requests with invalid enum values, so that only database-compatible data is accepted.

#### Acceptance Criteria

1. WHEN a POST request is submitted to the outgoing correspondence endpoint with a `classification` value not in Classification_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
2. WHEN a POST request is submitted to the outgoing correspondence endpoint with a `sending_method` value not in Method_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values.
3. WHEN a PUT request is submitted to the outgoing correspondence endpoint with any enum field containing an invalid value, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed values for the offending field.
4. WHEN a POST or PUT request is submitted with valid enum values or with optional enum fields omitted, THE Correspondence_API SHALL accept the request and proceed with processing.

### Requirement 3: Status Update Enum Validation

**User Story:** As an API consumer, I want the status update endpoint to validate the new status value against the correct enum set for the correspondence type, so that invalid status transitions are rejected before reaching the database.

#### Acceptance Criteria

1. WHEN a PUT request is submitted to the status endpoint with type 'incoming' and a `new_status` value not in Incoming_Status, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed incoming status values.
2. WHEN a PUT request is submitted to the status endpoint with type 'outgoing' and a `new_status` value not in Outgoing_Status, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed outgoing status values.
3. WHEN a PUT request is submitted with a valid `new_status` value matching the correspondence type, THE Correspondence_API SHALL accept the request and proceed with the status change.

### Requirement 4: Link Type Enum Validation

**User Story:** As an API consumer, I want the link correspondence endpoint to validate the `link_type` field against allowed values, so that only valid link types are stored.

#### Acceptance Criteria

1. WHEN a POST request is submitted to the link endpoint with a `link_type` value not in Link_Type_Enum, THE Correspondence_API SHALL return HTTP 400 with a validation error message listing the allowed link type values.
2. WHEN a POST request is submitted with a valid `link_type` value or with `link_type` omitted (defaulting to 'Reply'), THE Correspondence_API SHALL accept the request and proceed with processing.

### Requirement 5: Proper 404 Handling for Incoming Correspondence

**User Story:** As an API consumer, I want to receive an HTTP 404 response with a meaningful error message when I attempt to update or delete an incoming correspondence record that does not exist, so that I can distinguish between a successful no-op and a missing resource.

#### Acceptance Criteria

1. WHEN a PUT request is submitted to the incoming correspondence endpoint with an `id` that does not match any existing non-deleted record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.
2. WHEN a DELETE request is submitted to the incoming correspondence endpoint with an `id` that does not match any existing non-deleted record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.
3. WHEN a GET request is submitted to the details endpoint with type 'incoming' and an `id` that does not match any existing record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.

### Requirement 6: Proper 404 Handling for Outgoing Correspondence

**User Story:** As an API consumer, I want to receive an HTTP 404 response with a meaningful error message when I attempt to update or delete an outgoing correspondence record that does not exist, so that I can distinguish between a successful no-op and a missing resource.

#### Acceptance Criteria

1. WHEN a PUT request is submitted to the outgoing correspondence endpoint with an `id` that does not match any existing non-deleted record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.
2. WHEN a DELETE request is submitted to the outgoing correspondence endpoint with an `id` that does not match any existing non-deleted record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.
3. WHEN a GET request is submitted to the details endpoint with type 'outgoing' and an `id` that does not match any existing record, THE Correspondence_API SHALL return HTTP 404 with a JSON response body containing an error message indicating the record was not found.

### Requirement 7: 404 Response Format Consistency

**User Story:** As an API consumer, I want all 404 error responses from the correspondence module to follow a consistent JSON format, so that I can handle errors uniformly in client code.

#### Acceptance Criteria

1. THE Correspondence_API SHALL return all 404 responses with the content type `application/json`.
2. THE Correspondence_API SHALL include a `success` field set to `false` and a `message` field containing a human-readable description in every 404 response body.
3. THE Correspondence_API SHALL include an `error` field with value `'NOT_FOUND'` in every 404 response body.

### Requirement 8: Validation Error Response Format Consistency

**User Story:** As an API consumer, I want all 400 validation error responses to include enough detail for me to identify and correct the invalid fields, so that I can fix my requests without guesswork.

#### Acceptance Criteria

1. THE Correspondence_API SHALL return all enum validation failure responses with HTTP status 400 and content type `application/json`.
2. THE Correspondence_API SHALL include a `success` field set to `false` and a `message` field describing the validation failure in every 400 response body.
3. WHEN an enum validation fails, THE Correspondence_API SHALL include a `details` field containing the field-level error information from the Zod validation result.

### Requirement 9: Shared Validator Synchronization

**User Story:** As a developer, I want the shared package validators to use the same enum constraints as the route-level schemas, so that frontend and backend enforce identical validation rules.

#### Acceptance Criteria

1. THE Correspondence_API SHALL define enum constants (arrays of allowed values) in the shared package that both the route-level schemas and the shared validators reference.
2. WHEN an enum value is added or removed from the database CHECK constraint, THE Correspondence_API SHALL require updating only the single shared constant definition to propagate the change to all validators.
3. THE Correspondence_API SHALL use the same enum constant arrays in both `packages/shared/src/validators/correspondence.ts` and `src/routes/correspondence.ts` route-level schemas.

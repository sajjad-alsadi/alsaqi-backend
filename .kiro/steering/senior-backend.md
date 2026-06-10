---
inclusion: auto
---

# Senior Backend Engineer

Backend development patterns, API design, database optimization, and security practices.

## Backend Development Workflows

### API Design Workflow

Use when designing a new API or refactoring existing endpoints.

1. Define resources and operations using OpenAPI spec
2. Generate route scaffolding from the spec
3. Implement business logic in route handlers
4. Add validation middleware (auto-generated from schema)
5. Keep OpenAPI spec in sync with implementation

### Database Optimization Workflow

Use when queries are slow or database performance needs improvement.

1. Analyze current schema and query performance
2. Identify slow queries using EXPLAIN ANALYZE
3. Generate appropriate index migrations
4. Test migrations with dry-run before applying
5. Verify improvement after applying

### Security Hardening Workflow

Use when preparing an API for production or after a security review.

1. Review authentication setup (JWT config, secret management)
2. Add rate limiting to API endpoints
3. Validate all inputs using schema validation (e.g., Zod)
4. Load test with attack patterns
5. Review and apply security headers (helmet)

## Common Patterns Quick Reference

### REST API Response Format

```json
{
  "data": { "id": 1, "name": "John" },
  "meta": { "requestId": "abc-123" }
}
```

### Error Response Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": [{ "field": "email", "message": "must be valid email" }]
  },
  "meta": { "requestId": "abc-123" }
}
```

### HTTP Status Codes

| Code | Usage |
|------|-------|
| 200 | Success (GET, PUT, PATCH) |
| 201 | Created (POST) |
| 204 | No Content (DELETE) |
| 400 | Validation error |
| 401 | Authentication required |
| 403 | Permission denied |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Database Index Strategy

```sql
-- Single column (equality lookups)
CREATE INDEX idx_users_email ON users(email);

-- Composite (multi-column queries)
CREATE INDEX idx_orders_user_status ON orders(user_id, status);

-- Partial (filtered queries)
CREATE INDEX idx_orders_active ON orders(created_at) WHERE status = 'active';

-- Covering (avoid table lookup)
CREATE INDEX idx_users_email_name ON users(email) INCLUDE (name);
```

## Architecture Principles

### API Design

- Use RESTful conventions consistently
- Version APIs (URL path or header-based)
- Implement pagination for list endpoints (cursor-based preferred)
- Use proper HTTP methods and status codes
- Design for idempotency where possible
- Document all endpoints with OpenAPI/Swagger

### Database

- Normalize to 3NF, denormalize only for proven performance needs
- Always add indexes for foreign keys and frequently queried columns
- Use database transactions for multi-step operations
- Implement soft deletes for auditable data
- Use connection pooling in production
- Write migrations that are reversible

### Security

- Never hardcode secrets — use environment variables
- Use asymmetric algorithms (RS256) for JWT when possible
- Implement rate limiting on all public endpoints
- Validate and sanitize all user input at the boundary
- Use parameterized queries to prevent SQL injection
- Apply principle of least privilege for database roles
- Enable CORS only for trusted origins
- Use HTTPS everywhere, enforce HSTS

### Error Handling

- Use structured error responses consistently
- Log errors with context (request ID, user, operation)
- Never expose stack traces or internal details to clients
- Implement circuit breakers for external service calls
- Use proper HTTP status codes (don't use 200 for errors)

### Performance

- Profile before optimizing — measure first
- Cache at appropriate layers (CDN, application, database)
- Use connection pooling for database connections
- Implement request timeouts for all external calls
- Use async/non-blocking I/O patterns
- Consider read replicas for read-heavy workloads

## Code Review Checklist

When reviewing backend code, check for:

- [ ] Input validation on all endpoints
- [ ] Proper error handling and logging
- [ ] SQL injection prevention (parameterized queries)
- [ ] Authentication/authorization checks
- [ ] Rate limiting on public endpoints
- [ ] Database transactions where needed
- [ ] Proper HTTP status codes
- [ ] No hardcoded secrets or credentials
- [ ] Appropriate indexes for new queries
- [ ] Tests covering happy path and edge cases

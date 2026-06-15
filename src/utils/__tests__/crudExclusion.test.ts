import { describe, it, expect } from 'vitest';
import { CRUD_EXCLUDED_ROUTES } from '../crudGenerator';

describe('CRUD Generator Exclusion', () => {
  it('excludes audit-tasks from CRUD generation', () => {
    expect(CRUD_EXCLUDED_ROUTES).toContain('audit-tasks');
  });

  it('excludes audit-programs from CRUD generation', () => {
    expect(CRUD_EXCLUDED_ROUTES).toContain('audit-programs');
  });

  it('excludes recommendations from CRUD generation', () => {
    expect(CRUD_EXCLUDED_ROUTES).toContain('recommendations');
  });

  it('excludes audit-findings from CRUD generation', () => {
    expect(CRUD_EXCLUDED_ROUTES).toContain('audit-findings');
  });

  it('excludes compliance-items from CRUD generation', () => {
    // compliance-items is served exclusively by the canonical custom route
    // /api/v1/compliance, so the generic CRUD route must be excluded.
    expect(CRUD_EXCLUDED_ROUTES).toContain('compliance-items');
  });

  it('contains exactly 5 excluded routes', () => {
    expect(CRUD_EXCLUDED_ROUTES).toHaveLength(5);
  });
});

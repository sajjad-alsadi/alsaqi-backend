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

  it('contains exactly 4 excluded routes', () => {
    expect(CRUD_EXCLUDED_ROUTES).toHaveLength(4);
  });
});

import { ValidationError } from './errors';

/**
 * Identifier pattern permitted in an ORDER BY clause. Allows a leading letter or
 * underscore followed by letters, digits, underscores, and dots so that
 * table-qualified columns existing callers rely on (e.g. `i.registration_date`,
 * `updated_at`) are accepted, while rejecting anything containing whitespace,
 * quotes, semicolons, parentheses, or other injection-capable characters.
 */
const ORDER_BY_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

export class QueryBuilder {
  private baseQuery: string;
  private whereClauses: string[] = [];
  private params: any[] = [];
  private orderByClause = '';
  private limitClause = '';
  private offsetClause = '';

  constructor(baseQuery: string) {
    this.baseQuery = baseQuery;
  }

  where(condition: string, value?: any, ...extraValues: any[]) {
    this.whereClauses.push(condition);
    if (value !== undefined) {
      this.params.push(value, ...extraValues);
    }
    return this;
  }

  whereIf(shouldApply: boolean | undefined | null | "", condition: string, value?: any, ...extraValues: any[]) {
    if (shouldApply) {
      this.where(condition, value, ...extraValues);
    }
    return this;
  }

  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC') {
    if (typeof column !== 'string' || !ORDER_BY_IDENTIFIER.test(column)) {
      throw new ValidationError(`Invalid ORDER BY identifier: ${column}`);
    }
    const dir = String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    this.orderByClause = `ORDER BY ${column} ${dir}`;
    return this;
  }

  paginate(page: any, pageSize: any) {
    const p = parseInt(page) || 1;
    const ps = parseInt(pageSize) || 10;
    const offset = (p - 1) * ps;
    this.limitClause = `LIMIT ?`;
    this.offsetClause = `OFFSET ?`;
    // We don't push these into this.params yet to allow generating COUNT queries
    // They will be appended when building the final array via buildParams()
    return { offset, limit: ps };
  }

  buildCountQuery() {
    const whereString = this.whereClauses.length > 0 ? `WHERE ${this.whereClauses.join(' AND ')}` : '';
    // Typically baseQuery for count is something like "FROM table_name"
    // So the caller would do: `SELECT COUNT(*) ${qb.buildCountQuery()}`
    return `${this.baseQuery} ${whereString}`.trim();
  }

  buildDataQuery() {
    const whereString = this.whereClauses.length > 0 ? `WHERE ${this.whereClauses.join(' AND ')}` : '';
    return `${this.baseQuery} ${whereString} ${this.orderByClause} ${this.limitClause} ${this.offsetClause}`.trim();
  }

  getWhereBlock() {
    return this.whereClauses.length > 0 ? `WHERE ${this.whereClauses.join(' AND ')}` : '';
  }

  buildParams(paginationParams?: { limit: number, offset: number }) {
    if (paginationParams) {
      return [...this.params, paginationParams.limit, paginationParams.offset];
    }
    return [...this.params];
  }
}

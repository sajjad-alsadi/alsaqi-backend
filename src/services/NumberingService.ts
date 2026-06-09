import { db } from '../db/index';

/**
 * NumberingService: Unified hierarchical numbering for audit entities.
 *
 * Generates unique, hierarchical codes using atomic UPSERT on the
 * `numbering_counters` table. Each method is designed to be called
 * within the same transaction that creates the entity, ensuring
 * automatic rollback on failure.
 *
 * Hierarchy:
 *   Plan Code:           IA-PL-{YY}-{NNN}
 *   Task Number:         {planCode}-T{NN}
 *   Finding Number:      {planCode}-F{NN}
 *   Recommendation:      {findingNumber}-R{NN}
 *   Evidence:            {findingNumber}-E{NN}
 */

/** Overflow error thrown when a numbering sequence reaches its maximum */
export class NumberingOverflowError extends Error {
  constructor(scopeType: string, scopeId: string, maxValue: number) {
    super(
      `Numbering overflow: sequence for scope '${scopeType}' (id: ${scopeId}) ` +
      `has reached the maximum value of ${maxValue}. Cannot generate a new number.`
    );
    this.name = 'NumberingOverflowError';
  }
}

const PADDING = { plan: 3, child: 2 } as const;
const MAX_PLAN_SEQ = 999;
const MAX_CHILD_SEQ = 99;

export class NumberingService {
  /**
   * Atomically increments and returns the next counter value for a given scope.
   * Uses INSERT ... ON CONFLICT ... DO UPDATE (UPSERT) to ensure thread safety.
   *
   * IMPORTANT: Must be called within a transaction. On transaction rollback,
   * the counter increment is automatically rolled back by PostgreSQL.
   *
   * @param scopeType - The type of scope (e.g., 'plan_year', 'task', 'finding', 'rec', 'evidence')
   * @param scopeId - The scope identifier (e.g., year string, planId, findingId)
   * @returns The next sequential value (starting from 1)
   */
  static async nextCounter(scopeType: string, scopeId: string): Promise<number> {
    const row = await db.prepare(`
      INSERT INTO numbering_counters (scope_type, scope_id, last_value)
      VALUES (?, ?, 1)
      ON CONFLICT (scope_type, scope_id)
      DO UPDATE SET last_value = numbering_counters.last_value + 1
      RETURNING last_value
    `).get(scopeType, scopeId) as { last_value: number } | undefined;

    if (!row) {
      throw new Error(`Failed to generate counter for scope '${scopeType}' (id: ${scopeId})`);
    }

    return row.last_value;
  }

  /**
   * Generates the next plan code for a given fiscal year.
   * Format: IA-PL-{YY}-{NNN} where YY is last 2 digits of year, NNN is 001-999.
   *
   * @param year - The fiscal year (e.g., 2025)
   * @returns Plan code string (e.g., "IA-PL-25-001")
   * @throws NumberingOverflowError if sequence exceeds 999
   */
  static async nextPlanCode(year: number): Promise<string> {
    const seq = await this.nextCounter('plan_year', String(year));

    if (seq > MAX_PLAN_SEQ) {
      throw new NumberingOverflowError('plan_year', String(year), MAX_PLAN_SEQ);
    }

    const yy = String(year).slice(-2).padStart(2, '0');
    return `IA-PL-${yy}-${String(seq).padStart(PADDING.plan, '0')}`;
  }

  /**
   * Generates the next task number within a plan.
   * Format: {planCode}-T{NN} where NN is 01-99.
   *
   * @param planId - The plan UUID
   * @param planCode - The parent plan code (e.g., "IA-PL-25-001")
   * @returns Task number string (e.g., "IA-PL-25-001-T01")
   * @throws NumberingOverflowError if sequence exceeds 99
   */
  static async nextTaskNumber(planId: string, planCode: string): Promise<string> {
    const seq = await this.nextCounter('task', planId);

    if (seq > MAX_CHILD_SEQ) {
      throw new NumberingOverflowError('task', planId, MAX_CHILD_SEQ);
    }

    return `${planCode}-T${String(seq).padStart(PADDING.child, '0')}`;
  }

  /**
   * Generates the next finding number within a plan.
   * Format: {planCode}-F{NN} where NN is 01-99.
   *
   * @param planId - The plan UUID
   * @param planCode - The parent plan code (e.g., "IA-PL-25-001")
   * @returns Finding number string (e.g., "IA-PL-25-001-F01")
   * @throws NumberingOverflowError if sequence exceeds 99
   */
  static async nextFindingNumber(planId: string, planCode: string): Promise<string> {
    const seq = await this.nextCounter('finding', planId);

    if (seq > MAX_CHILD_SEQ) {
      throw new NumberingOverflowError('finding', planId, MAX_CHILD_SEQ);
    }

    return `${planCode}-F${String(seq).padStart(PADDING.child, '0')}`;
  }

  /**
   * Generates the next recommendation number within a finding.
   * Format: {findingNumber}-R{NN} where NN is 01-99.
   *
   * @param findingId - The finding UUID
   * @param findingNumber - The parent finding number (e.g., "IA-PL-25-001-F01")
   * @returns Recommendation number string (e.g., "IA-PL-25-001-F01-R01")
   * @throws NumberingOverflowError if sequence exceeds 99
   */
  static async nextRecommendationNumber(findingId: string, findingNumber: string): Promise<string> {
    const seq = await this.nextCounter('rec', findingId);

    if (seq > MAX_CHILD_SEQ) {
      throw new NumberingOverflowError('rec', findingId, MAX_CHILD_SEQ);
    }

    return `${findingNumber}-R${String(seq).padStart(PADDING.child, '0')}`;
  }

  /**
   * Generates the next evidence number within a finding.
   * Format: {findingNumber}-E{NN} where NN is 01-99.
   *
   * @param findingId - The finding UUID
   * @param findingNumber - The parent finding number (e.g., "IA-PL-25-001-F01")
   * @returns Evidence number string (e.g., "IA-PL-25-001-F01-E01")
   * @throws NumberingOverflowError if sequence exceeds 99
   */
  static async nextEvidenceNumber(findingId: string, findingNumber: string): Promise<string> {
    const seq = await this.nextCounter('evidence', findingId);

    if (seq > MAX_CHILD_SEQ) {
      throw new NumberingOverflowError('evidence', findingId, MAX_CHILD_SEQ);
    }

    return `${findingNumber}-E${String(seq).padStart(PADDING.child, '0')}`;
  }
}

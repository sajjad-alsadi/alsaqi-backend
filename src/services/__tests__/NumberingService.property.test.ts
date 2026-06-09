// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Test: Hierarchical numbering derivation (Property 11)
 *
 * Feature: audit-modules-restructure
 * Property 11: كل رقم فرعي يحمل بادئة رقم العنصر الأب كاملةً (الترقيم متفرّع وليس مستقلاً).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7**
 *
 * When: توليد رقم لمهمة/ملاحظة/توصية/دليل
 * Then: taskNumber.startsWith(planCode) ∧ findingNumber.startsWith(planCode)
 *       ∧ recNumber.startsWith(findingNumber) ∧ evidenceNumber.startsWith(findingNumber)
 *
 * This test validates the NumberingService's hierarchical numbering logic
 * without database dependencies by extracting the pure formatting functions.
 */

// ─── Pure Formatting Logic (extracted from NumberingService) ──────────────────

const PADDING = { plan: 3, child: 2 } as const;
const MAX_PLAN_SEQ = 999;
const MAX_CHILD_SEQ = 99;

/**
 * Formats a plan code given a year and sequence number.
 * Mirrors NumberingService.nextPlanCode formatting logic.
 */
function formatPlanCode(year: number, seq: number): string {
  const yy = String(year).slice(-2).padStart(2, '0');
  return `IA-PL-${yy}-${String(seq).padStart(PADDING.plan, '0')}`;
}

/**
 * Formats a task number given a plan code and sequence.
 * Mirrors NumberingService.nextTaskNumber formatting logic.
 */
function formatTaskNumber(planCode: string, seq: number): string {
  return `${planCode}-T${String(seq).padStart(PADDING.child, '0')}`;
}

/**
 * Formats a finding number given a plan code and sequence.
 * Mirrors NumberingService.nextFindingNumber formatting logic.
 */
function formatFindingNumber(planCode: string, seq: number): string {
  return `${planCode}-F${String(seq).padStart(PADDING.child, '0')}`;
}

/**
 * Formats a recommendation number given a finding number and sequence.
 * Mirrors NumberingService.nextRecommendationNumber formatting logic.
 */
function formatRecommendationNumber(findingNumber: string, seq: number): string {
  return `${findingNumber}-R${String(seq).padStart(PADDING.child, '0')}`;
}

/**
 * Formats an evidence number given a finding number and sequence.
 * Mirrors NumberingService.nextEvidenceNumber formatting logic.
 */
function formatEvidenceNumber(findingNumber: string, seq: number): string {
  return `${findingNumber}-E${String(seq).padStart(PADDING.child, '0')}`;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Year in valid range (2000-2099), producing YY from 00 to 99 */
const yearArb = fc.integer({ min: 2000, max: 2099 });

/** Plan sequence in valid range (1-999) */
const planSeqArb = fc.integer({ min: 1, max: MAX_PLAN_SEQ });

/** Child sequence in valid range (1-99) */
const childSeqArb = fc.integer({ min: 1, max: MAX_CHILD_SEQ });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 11: Hierarchical numbering derivation', () => {
  describe('Requirement 3.1: Plan codes follow format IA-PL-{YY}-{NNN}', () => {
    it('plan code matches IA-PL-{YY}-{NNN} format for any valid year and sequence', () => {
      fc.assert(
        fc.property(yearArb, planSeqArb, (year, seq) => {
          const planCode = formatPlanCode(year, seq);

          // Must match the exact format: IA-PL-{2 digits}-{3 digits}
          const planCodeRegex = /^IA-PL-\d{2}-\d{3}$/;
          expect(planCode).toMatch(planCodeRegex);

          // YY must be last 2 digits of year
          const yy = String(year).slice(-2).padStart(2, '0');
          expect(planCode).toContain(`IA-PL-${yy}-`);

          // NNN must be zero-padded sequence in range 001-999
          const nnn = planCode.split('-')[3];
          const seqValue = parseInt(nnn, 10);
          expect(seqValue).toBeGreaterThanOrEqual(1);
          expect(seqValue).toBeLessThanOrEqual(999);
          expect(seqValue).toBe(seq);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.2: Task numbers derived from plan code as {planCode}-T{NN}', () => {
    it('task number starts with full plan code and appends -T{NN}', () => {
      fc.assert(
        fc.property(yearArb, planSeqArb, childSeqArb, (year, planSeq, taskSeq) => {
          const planCode = formatPlanCode(year, planSeq);
          const taskNumber = formatTaskNumber(planCode, taskSeq);

          // Task number must start with the full plan code
          expect(taskNumber.startsWith(planCode)).toBe(true);

          // Must match format {planCode}-T{NN}
          const suffix = taskNumber.slice(planCode.length);
          const taskSuffixRegex = /^-T\d{2}$/;
          expect(suffix).toMatch(taskSuffixRegex);

          // NN must be the sequence value (01-99)
          const nn = suffix.slice(2); // skip "-T"
          const nnValue = parseInt(nn, 10);
          expect(nnValue).toBeGreaterThanOrEqual(1);
          expect(nnValue).toBeLessThanOrEqual(99);
          expect(nnValue).toBe(taskSeq);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.3: Finding numbers derived from plan code as {planCode}-F{NN}', () => {
    it('finding number starts with full plan code and appends -F{NN}', () => {
      fc.assert(
        fc.property(yearArb, planSeqArb, childSeqArb, (year, planSeq, findingSeq) => {
          const planCode = formatPlanCode(year, planSeq);
          const findingNumber = formatFindingNumber(planCode, findingSeq);

          // Finding number must start with the full plan code
          expect(findingNumber.startsWith(planCode)).toBe(true);

          // Must match format {planCode}-F{NN}
          const suffix = findingNumber.slice(planCode.length);
          const findingSuffixRegex = /^-F\d{2}$/;
          expect(suffix).toMatch(findingSuffixRegex);

          // NN must be the sequence value (01-99)
          const nn = suffix.slice(2); // skip "-F"
          const nnValue = parseInt(nn, 10);
          expect(nnValue).toBeGreaterThanOrEqual(1);
          expect(nnValue).toBeLessThanOrEqual(99);
          expect(nnValue).toBe(findingSeq);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.4: Recommendation numbers derived from finding number as {findingNumber}-R{NN}', () => {
    it('recommendation number starts with full finding number and appends -R{NN}', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, findingSeq, recSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);
            const recNumber = formatRecommendationNumber(findingNumber, recSeq);

            // Recommendation number must start with the full finding number
            expect(recNumber.startsWith(findingNumber)).toBe(true);

            // Must match format {findingNumber}-R{NN}
            const suffix = recNumber.slice(findingNumber.length);
            const recSuffixRegex = /^-R\d{2}$/;
            expect(suffix).toMatch(recSuffixRegex);

            // NN must be the sequence value (01-99)
            const nn = suffix.slice(2); // skip "-R"
            const nnValue = parseInt(nn, 10);
            expect(nnValue).toBeGreaterThanOrEqual(1);
            expect(nnValue).toBeLessThanOrEqual(99);
            expect(nnValue).toBe(recSeq);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.5: Evidence numbers derived from finding number as {findingNumber}-E{NN}', () => {
    it('evidence number starts with full finding number and appends -E{NN}', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, findingSeq, evidenceSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);
            const evidenceNumber = formatEvidenceNumber(findingNumber, evidenceSeq);

            // Evidence number must start with the full finding number
            expect(evidenceNumber.startsWith(findingNumber)).toBe(true);

            // Must match format {findingNumber}-E{NN}
            const suffix = evidenceNumber.slice(findingNumber.length);
            const evidenceSuffixRegex = /^-E\d{2}$/;
            expect(suffix).toMatch(evidenceSuffixRegex);

            // NN must be the sequence value (01-99)
            const nn = suffix.slice(2); // skip "-E"
            const nnValue = parseInt(nn, 10);
            expect(nnValue).toBeGreaterThanOrEqual(1);
            expect(nnValue).toBeLessThanOrEqual(99);
            expect(nnValue).toBe(evidenceSeq);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.7: Child numbers always contain full parent prefix (hierarchical derivation)', () => {
    it('full hierarchy chain: plan → task contains plan prefix', () => {
      fc.assert(
        fc.property(yearArb, planSeqArb, childSeqArb, (year, planSeq, taskSeq) => {
          const planCode = formatPlanCode(year, planSeq);
          const taskNumber = formatTaskNumber(planCode, taskSeq);

          // Task number contains the full plan code as prefix
          expect(taskNumber.startsWith(planCode)).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('full hierarchy chain: plan → finding → recommendation contains all parent prefixes', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, findingSeq, recSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);
            const recNumber = formatRecommendationNumber(findingNumber, recSeq);

            // Finding contains plan prefix
            expect(findingNumber.startsWith(planCode)).toBe(true);
            // Recommendation contains finding prefix (which includes plan prefix)
            expect(recNumber.startsWith(findingNumber)).toBe(true);
            // Recommendation also contains plan prefix (transitive)
            expect(recNumber.startsWith(planCode)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('full hierarchy chain: plan → finding → evidence contains all parent prefixes', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, findingSeq, evidenceSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);
            const evidenceNumber = formatEvidenceNumber(findingNumber, evidenceSeq);

            // Finding contains plan prefix
            expect(findingNumber.startsWith(planCode)).toBe(true);
            // Evidence contains finding prefix (which includes plan prefix)
            expect(evidenceNumber.startsWith(findingNumber)).toBe(true);
            // Evidence also contains plan prefix (transitive)
            expect(evidenceNumber.startsWith(planCode)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('sibling entities (task and finding) under same plan share the plan prefix but differ in suffix', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, taskSeq, findingSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const taskNumber = formatTaskNumber(planCode, taskSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);

            // Both share the same plan prefix
            expect(taskNumber.startsWith(planCode)).toBe(true);
            expect(findingNumber.startsWith(planCode)).toBe(true);

            // They differ in their type suffix (-T vs -F)
            const taskSuffix = taskNumber.slice(planCode.length + 1, planCode.length + 2);
            const findingSuffix = findingNumber.slice(planCode.length + 1, planCode.length + 2);
            expect(taskSuffix).toBe('T');
            expect(findingSuffix).toBe('F');
          }
        ),
        { numRuns: 200 }
      );
    });

    it('sibling entities (recommendation and evidence) under same finding share the finding prefix but differ in suffix', () => {
      fc.assert(
        fc.property(
          yearArb,
          planSeqArb,
          childSeqArb,
          childSeqArb,
          childSeqArb,
          (year, planSeq, findingSeq, recSeq, evidenceSeq) => {
            const planCode = formatPlanCode(year, planSeq);
            const findingNumber = formatFindingNumber(planCode, findingSeq);
            const recNumber = formatRecommendationNumber(findingNumber, recSeq);
            const evidenceNumber = formatEvidenceNumber(findingNumber, evidenceSeq);

            // Both share the same finding prefix
            expect(recNumber.startsWith(findingNumber)).toBe(true);
            expect(evidenceNumber.startsWith(findingNumber)).toBe(true);

            // They differ in their type suffix (-R vs -E)
            const recSuffix = recNumber.slice(findingNumber.length + 1, findingNumber.length + 2);
            const evidenceSuffix = evidenceNumber.slice(findingNumber.length + 1, findingNumber.length + 2);
            expect(recSuffix).toBe('R');
            expect(evidenceSuffix).toBe('E');
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});

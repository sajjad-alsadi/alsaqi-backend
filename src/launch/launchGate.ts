/**
 * تجميع بوابة الإطلاق الإنتاجي (Launch_Gate).
 *
 * يطبّق منطق "الفشل المُغلق" (fail-closed): البوابة تمرّ فقط عندما يكون كل
 * معيار من معايير الأولوية القصوى (P0) حالته `pass` ومرتبطًا بمرجع دليل
 * (`evidenceRef`) غير فارغ. أي معيار P0 بحالة `fail` أو `unverified` يجعل
 * البوابة غير جاهزة. ومعيار P0 بحالة `pass` لكن دون مرجع دليل (فارغ/`null`)
 * يُعامَل كـ`unverified` ويُطبَّع في الناتج.
 *
 * Reference: design.md "Data Models" — LaunchGateResult
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6
 */

import { GateStatus, LaunchGateCriterion, LaunchGateResult } from './types.js';

/**
 * يتحقّق من أنّ مرجع الدليل (`evidenceRef`) موجود وغير فارغ بعد إزالة الفراغات.
 */
function hasEvidence(evidenceRef: string | null): boolean {
  return typeof evidenceRef === 'string' && evidenceRef.trim().length > 0;
}

/**
 * يطبّع حالة المعيار: معيار بحالة `pass` بلا مرجع دليل غير فارغ يُعامَل `unverified`.
 * تنطبق هذه التطبيع على كل المعايير حتى يعكس الناتج الأساس الفعلي للحالة.
 */
function normalizeStatus(status: GateStatus, evidenceRef: string | null): GateStatus {
  if (status === 'pass' && !hasEvidence(evidenceRef)) {
    return 'unverified';
  }
  return status;
}

/**
 * يُجمّع معايير القبول في نتيجة بوابة إطلاق واحدة.
 *
 * - `result.criteria` يشمل كل المعايير المُدخَلة (مع تطبيع الحالة عند الحاجة).
 * - `gatePassed === true` إذا وفقط إذا كان كل معيار P0 حالته (بعد التطبيع)
 *   `pass` وله `evidenceRef` غير فارغ.
 * - أي معيار P0 بحالة `fail` أو `unverified` ⇒ `gatePassed === false`.
 * - المعايير غير P0 لا تؤثّر في `gatePassed`.
 */
export function aggregateLaunchGate(criteria: LaunchGateCriterion[]): LaunchGateResult {
  const normalizedCriteria: LaunchGateCriterion[] = criteria.map((criterion) => ({
    ...criterion,
    status: normalizeStatus(criterion.status, criterion.evidenceRef),
  }));

  const gatePassed = normalizedCriteria
    .filter((criterion) => criterion.priority === 'P0')
    .every((criterion) => criterion.status === 'pass' && hasEvidence(criterion.evidenceRef));

  return {
    criteria: normalizedCriteria,
    gatePassed,
  };
}

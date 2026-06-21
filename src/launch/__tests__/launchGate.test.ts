// @vitest-environment node
// Feature: production-launch-readiness, Task 14.3
// اختبار وحدة (مبني على أمثلة) لمنطق مرجع الدليل في aggregateLaunchGate.
// متميّز عن اختبار الخاصية 10 (launchGate.property.test.ts).
import { describe, it, expect } from 'vitest';
import { aggregateLaunchGate } from '../launchGate.js';
import type { LaunchGateCriterion } from '../types.js';

/**
 * مساعد لبناء معيار P0 بحالة pass مع مرجع دليل معيّن.
 */
function p0Pass(id: string, evidenceRef: string | null): LaunchGateCriterion {
  return { id, priority: 'P0', status: 'pass', evidenceRef };
}

describe('aggregateLaunchGate — منطق مرجع الدليل (Requirements 22.5, 22.6)', () => {
  describe('معيار P0 بحالة pass دون مرجع دليل يُعامَل unverified ويُفشِل البوابة', () => {
    it('evidenceRef = null', () => {
      const result = aggregateLaunchGate([p0Pass('1.1', null)]);

      expect(result.criteria[0].status).toBe('unverified');
      expect(result.gatePassed).toBe(false);
    });

    it('evidenceRef = "" (سلسلة فارغة)', () => {
      const result = aggregateLaunchGate([p0Pass('1.2', '')]);

      expect(result.criteria[0].status).toBe('unverified');
      expect(result.gatePassed).toBe(false);
    });

    it('evidenceRef = فراغات فقط (whitespace)', () => {
      const result = aggregateLaunchGate([p0Pass('1.3', '   \t\n ')]);

      expect(result.criteria[0].status).toBe('unverified');
      expect(result.gatePassed).toBe(false);
    });
  });

  describe('معيار P0 بحالة pass مع مرجع دليل غير فارغ يُحتسَب pass', () => {
    it('مرجع دليل نصّي ذو معنى يبقى pass', () => {
      const result = aggregateLaunchGate([p0Pass('2.1', 'evidence/restore-drill.md#L12')]);

      expect(result.criteria[0].status).toBe('pass');
      expect(result.gatePassed).toBe(true);
    });

    it('مرجع دليل بفراغات محيطة لكنه غير فارغ بعد التشذيب يبقى pass', () => {
      const result = aggregateLaunchGate([p0Pass('2.2', '  doc#anchor  ')]);

      expect(result.criteria[0].status).toBe('pass');
      expect(result.gatePassed).toBe(true);
    });
  });

  describe('البوابة تمرّ عندما تكون كل معايير P0 بحالة pass ومدعومة بدليل', () => {
    it('كل معايير P0 pass + evidence ⇒ gatePassed === true', () => {
      const result = aggregateLaunchGate([
        p0Pass('3.1', 'evidence/a.md'),
        p0Pass('3.2', 'evidence/b.md'),
        p0Pass('3.3', 'evidence/c.md'),
      ]);

      expect(result.criteria.every((c) => c.status === 'pass')).toBe(true);
      expect(result.gatePassed).toBe(true);
    });

    it('معيار P0 واحد دون دليل ضمن مجموعة سليمة يُفشِل البوابة (fail-closed)', () => {
      const result = aggregateLaunchGate([
        p0Pass('4.1', 'evidence/a.md'),
        p0Pass('4.2', null), // يُطبَّع إلى unverified
        p0Pass('4.3', 'evidence/c.md'),
      ]);

      const normalized = result.criteria.find((c) => c.id === '4.2');
      expect(normalized?.status).toBe('unverified');
      expect(result.gatePassed).toBe(false);
    });

    it('معايير غير P0 دون دليل لا تؤثّر في gatePassed', () => {
      const result = aggregateLaunchGate([
        p0Pass('5.1', 'evidence/a.md'),
        { id: '5.2', priority: 'P1', status: 'pass', evidenceRef: null },
        { id: '5.3', priority: 'P2', status: 'fail', evidenceRef: null },
      ]);

      expect(result.gatePassed).toBe(true);
    });
  });
});

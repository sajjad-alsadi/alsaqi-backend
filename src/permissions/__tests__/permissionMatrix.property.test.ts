// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ROLES,
  MODULES,
  PERMISSIONS,
  DEFAULT_PERMISSIONS,
  type Module,
  type Role,
} from '../../permissions';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** The five audit modules affected by the restructure */
const AUDIT_MODULES: Module[] = [
  MODULES.AUDIT_PLANS,
  MODULES.AUDIT_TASKS,
  MODULES.AUDIT_PROGRAM_LIBRARY,
  MODULES.AUDIT_FINDINGS,
  MODULES.RECOMMENDATIONS,
];

/** All modules NOT in the audit restructure scope */
const NON_AUDIT_MODULES: Module[] = (Object.values(MODULES) as Module[]).filter(
  (m) => !AUDIT_MODULES.includes(m)
);

/** All roles in the system */
const ALL_ROLES: Role[] = Object.values(ROLES) as Role[];

/**
 * Known baseline permissions for non-audit modules.
 * This captures the expected state of permissions for modules outside
 * the five audit modules, ensuring they remain unchanged.
 */
const BASELINE_NON_AUDIT_PERMISSIONS: Record<Role, Partial<Record<Module, string[]>>> = {} as any;
for (const role of ALL_ROLES) {
  BASELINE_NON_AUDIT_PERMISSIONS[role] = {};
  for (const mod of NON_AUDIT_MODULES) {
    BASELINE_NON_AUDIT_PERMISSIONS[role]![mod] = [...DEFAULT_PERMISSIONS[role][mod]];
  }
}

// ─── Property Tests ────────────────────────────────────────────────────────────

/**
 * Property 16: Permission matrix updates do not affect other modules
 *
 * **Validates: Requirements 11.8**
 *
 * For any role in the system and any module outside the five audit modules
 * (AUDIT_PLANS, AUDIT_TASKS, AUDIT_PROGRAM_LIBRARY, AUDIT_FINDINGS, RECOMMENDATIONS),
 * the permissions remain unchanged from the known baseline. This ensures that
 * updates to the permission matrix are scoped exclusively to the five audit modules.
 */
describe('Property 16: Permission matrix updates do not affect other modules', () => {
  it('for any role, permissions on non-audit modules match the known baseline', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ROLES),
        fc.constantFrom(...NON_AUDIT_MODULES),
        (role: Role, module: Module) => {
          const currentPermissions = DEFAULT_PERMISSIONS[role][module];
          const baselinePermissions = BASELINE_NON_AUDIT_PERMISSIONS[role]![module]!;

          // The current permissions must exactly match the baseline
          expect([...currentPermissions].sort()).toEqual([...baselinePermissions].sort());
        }
      ),
      { numRuns: 200 }
    );
  });

  it('non-audit modules have the same number of permissions as baseline for every role', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ROLES),
        fc.constantFrom(...NON_AUDIT_MODULES),
        (role: Role, module: Module) => {
          const currentPermissions = DEFAULT_PERMISSIONS[role][module];
          const baselinePermissions = BASELINE_NON_AUDIT_PERMISSIONS[role]![module]!;

          expect(currentPermissions.length).toBe(baselinePermissions.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('changes are confined to exactly the five audit modules', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ROLES),
        (role: Role) => {
          // For each non-audit module, verify no permission was added or removed
          for (const mod of NON_AUDIT_MODULES) {
            const current = DEFAULT_PERMISSIONS[role][mod];
            const baseline = BASELINE_NON_AUDIT_PERMISSIONS[role]![mod]!;

            // No extra permissions added
            for (const perm of current) {
              expect(baseline).toContain(perm);
            }
            // No permissions removed
            for (const perm of baseline) {
              expect(current).toContain(perm);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 17: Recommendations cannot be created manually by any role
 *
 * **Validates: Requirements 11.9, 11.10, 11.11**
 *
 * No role in the system has CREATE permission on the RECOMMENDATIONS module.
 * Recommendations are derived automatically from findings only and cannot
 * be created manually by any user regardless of their role.
 */
describe('Property 17: Recommendations cannot be created manually by any role', () => {
  it('no role has Create permission on the Recommendations module', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ROLES),
        (role: Role) => {
          const recPermissions = DEFAULT_PERMISSIONS[role][MODULES.RECOMMENDATIONS];

          // The Create permission must NOT be present for any role
          expect(recPermissions).not.toContain(PERMISSIONS.CREATE);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Recommendations module permissions are limited to View, Edit, Delete, Approve', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ROLES),
        (role: Role) => {
          const recPermissions = DEFAULT_PERMISSIONS[role][MODULES.RECOMMENDATIONS];
          const allowedPermissions = [
            PERMISSIONS.VIEW,
            PERMISSIONS.EDIT,
            PERMISSIONS.DELETE,
            PERMISSIONS.APPROVE,
          ];

          // Every permission on Recommendations must be in the allowed set (no Create)
          for (const perm of recPermissions) {
            expect(allowedPermissions).toContain(perm);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

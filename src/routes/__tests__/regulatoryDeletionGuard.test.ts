// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { evaluateRegulatoryDeletion } from './regulatoryDeletionGuard';

/**
 * Guard test for FIX-BE-3 abort-on-mount branch.
 *
 * The orphaned regulatory route file (`src/routes/regulatory.ts`, exporting
 * `createRegulatoryRoutes`) deletion is gated: if any router still mounts
 * `createRegulatoryRoutes`, the deletion must ABORT and retain the file,
 * reporting which router mounts it. When no router mounts it, deletion PROCEEDs.
 *
 * Validates: Requirements 3.3
 */
describe('FIX-BE-3: regulatory deletion guard (abort-on-mount)', () => {
  describe('abort branch: a router still mounts createRegulatoryRoutes', () => {
    it('aborts and retains the file when a router mounts the orphaned route', () => {
      const routers = [
        {
          name: 'src/routes/v1/index.ts',
          content: `
            import { createRegulatoryRoutes } from '../regulatory';
            export function createV1Router() {
              const router = Router();
              router.use('/', createRegulatoryRoutes());
              return router;
            }
          `,
        },
      ];

      const decision = evaluateRegulatoryDeletion(routers);

      expect(decision.action).toBe('abort');
      expect(decision.retainFile).toBe(true);
      expect(decision.mountedBy).toContain('src/routes/v1/index.ts');
      expect(decision.reason).toMatch(/createRegulatoryRoutes/);
    });

    it('reports every router that mounts the orphaned route', () => {
      const routers = [
        {
          name: 'src/routes/v1/index.ts',
          content: `router.use('/', createRegulatoryRoutes());`,
        },
        {
          name: 'src/routes/admin.ts',
          content: `const reg = createRegulatoryRoutes();`,
        },
        {
          name: 'src/routes/users.ts',
          content: `router.get('/users', handler);`,
        },
      ];

      const decision = evaluateRegulatoryDeletion(routers);

      expect(decision.action).toBe('abort');
      expect(decision.mountedBy).toEqual([
        'src/routes/v1/index.ts',
        'src/routes/admin.ts',
      ]);
      expect(decision.mountedBy).not.toContain('src/routes/users.ts');
    });
  });

  describe('proceed branch: no router mounts createRegulatoryRoutes', () => {
    it('proceeds when no router references the orphaned route', () => {
      const routers = [
        {
          name: 'src/routes/v1/index.ts',
          content: `
            import { createCrudRoutes } from '../crudGenerator';
            router.use('/', createCrudRoutes('central_bank_instructions', 'central-bank-instructions'));
          `,
        },
        {
          name: 'src/routes/users.ts',
          content: `router.get('/users', handler);`,
        },
      ];

      const decision = evaluateRegulatoryDeletion(routers);

      expect(decision.action).toBe('proceed');
      expect(decision.retainFile).toBe(false);
      expect(decision.mountedBy).toEqual([]);
    });

    it('proceeds when there are no routers at all', () => {
      const decision = evaluateRegulatoryDeletion([]);

      expect(decision.action).toBe('proceed');
      expect(decision.retainFile).toBe(false);
    });

    it('does not match a substring of an unrelated symbol', () => {
      const routers = [
        {
          name: 'src/routes/v1/index.ts',
          // Similar-looking but distinct identifiers must not trigger an abort.
          content: `const x = createRegulatoryRoutesHelperDisabled;`,
        },
      ];

      const decision = evaluateRegulatoryDeletion(routers);

      expect(decision.action).toBe('proceed');
    });
  });
});

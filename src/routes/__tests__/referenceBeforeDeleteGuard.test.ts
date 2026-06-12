import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateReferenceBeforeDelete,
  isTestFile,
  referencesSymbol,
  type SourceFile,
} from './referenceBeforeDeleteGuard';

/**
 * Guard tests for the abort-on-reference branch (FIX-BE-2, Task 2.3)
 *
 * **Validates: Requirements 2.2**
 *
 * The dead `src/routes/index.ts` (exporting `setupRoutes`) was deleted only
 * after a reference-before-delete static search confirmed zero PRODUCTION
 * references. These tests pin down the abort-on-reference decision logic:
 *
 *  - When a production (non-test) file imports `setupRoutes`, the guard reports
 *    ABORT and the target file is RETAINED (Requirement 2.2).
 *  - When zero production files reference it (test-only references, or none),
 *    the guard reports PROCEED — the deletion may go ahead.
 */

const TARGET = 'setupRoutes';
const DEAD_FILE = 'src/routes/index.ts';

describe('Reference-before-delete guard: abort-on-reference branch (FIX-BE-2)', () => {
  describe('Requirement 2.2: a production reference aborts the deletion and retains the file', () => {
    it('aborts and retains the file when a production source imports setupRoutes', () => {
      const files: SourceFile[] = [
        { path: DEAD_FILE, contents: `export function ${TARGET}() {}` },
        {
          path: 'src/main.ts',
          contents: `import { setupRoutes } from './routes/index';\nsetupRoutes(app);\n`,
        },
      ];

      const result = evaluateReferenceBeforeDelete(files, TARGET);

      expect(result.decision).toBe('abort');
      expect(result.fileRetained).toBe(true);
      expect(result.productionReferences).toContain('src/main.ts');
    });

    it('reports every production file that references the symbol', () => {
      const files: SourceFile[] = [
        { path: 'src/index.ts', contents: `import { setupRoutes } from './routes';` },
        {
          path: 'src/server/bootstrap.ts',
          contents: `const { setupRoutes } = require('./routes');`,
        },
        { path: 'src/routes/v1/index.ts', contents: `export const createV1Router = () => {};` },
      ];

      const result = evaluateReferenceBeforeDelete(files, TARGET);

      expect(result.decision).toBe('abort');
      expect(result.fileRetained).toBe(true);
      expect(result.productionReferences).toEqual([
        'src/index.ts',
        'src/server/bootstrap.ts',
      ]);
    });
  });

  describe('Converse: zero production references allows the deletion to proceed', () => {
    it('proceeds when no file references the symbol', () => {
      const files: SourceFile[] = [
        { path: DEAD_FILE, contents: `export function ${TARGET}() {}` },
        { path: 'src/routes/v1/index.ts', contents: `export const createV1Router = () => {};` },
      ];

      const result = evaluateReferenceBeforeDelete(files, TARGET);

      expect(result.decision).toBe('proceed');
      expect(result.fileRetained).toBe(false);
      expect(result.productionReferences).toEqual([]);
    });

    it('proceeds when only test files reference the symbol (the real FIX-BE-2 case)', () => {
      const files: SourceFile[] = [
        { path: DEAD_FILE, contents: `export function ${TARGET}() {}` },
        {
          path: 'src/routes/__tests__/apiVersioning.test.ts',
          contents: `import { setupRoutes } from '../index';`,
        },
        {
          path: 'src/routes/index.spec.ts',
          contents: `import { setupRoutes } from './index';`,
        },
      ];

      const result = evaluateReferenceBeforeDelete(files, TARGET);

      expect(result.decision).toBe('proceed');
      expect(result.fileRetained).toBe(false);
      expect(result.productionReferences).toEqual([]);
    });

    it('does not treat an incidental comment mention as a blocking reference', () => {
      const files: SourceFile[] = [
        {
          path: 'src/routes/v1/index.ts',
          contents: `// replicates the version middleware the now-removed setupRoutes wired up\nexport const createV1Router = () => {};`,
        },
      ];

      const result = evaluateReferenceBeforeDelete(files, TARGET);

      expect(result.decision).toBe('proceed');
      expect(result.fileRetained).toBe(false);
      expect(result.productionReferences).toEqual([]);
    });
  });

  describe('Classification helpers', () => {
    it('isTestFile recognizes test and __tests__ paths but not production sources', () => {
      expect(isTestFile('src/routes/__tests__/apiVersioning.test.ts')).toBe(true);
      expect(isTestFile('src/foo.spec.ts')).toBe(true);
      expect(isTestFile('src\\routes\\__tests__\\guard.test.ts')).toBe(true);
      expect(isTestFile('src/main.ts')).toBe(false);
      expect(isTestFile('src/routes/index.ts')).toBe(false);
    });

    it('referencesSymbol matches imports/requires but not unrelated identifiers', () => {
      expect(referencesSymbol(`import { setupRoutes } from './routes';`, TARGET)).toBe(true);
      expect(referencesSymbol(`const { setupRoutes } = require('./routes');`, TARGET)).toBe(true);
      expect(referencesSymbol(`function setupRoutesHandler() {}`, TARGET)).toBe(false);
      expect(referencesSymbol(`const x = 1;`, TARGET)).toBe(false);
    });
  });

  describe('Property: any production reference forces abort + retain', () => {
    it('aborts and retains whenever >=1 production file imports the symbol', () => {
      fc.assert(
        fc.property(
          // 1..n production files that DO import the symbol
          fc.array(
            fc
              .string({ minLength: 1, maxLength: 12 })
              .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
            { minLength: 1, maxLength: 5 },
          ),
          // 0..n test files that also import the symbol (must NOT affect outcome)
          fc.array(
            fc
              .string({ minLength: 1, maxLength: 12 })
              .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
            { minLength: 0, maxLength: 5 },
          ),
          (prodNames, testNames) => {
            const prodFiles: SourceFile[] = prodNames.map((n, i) => ({
              path: `src/prod-${i}-${n}.ts`,
              contents: `import { ${TARGET} } from './routes';`,
            }));
            const testFiles: SourceFile[] = testNames.map((n, i) => ({
              path: `src/__tests__/test-${i}-${n}.test.ts`,
              contents: `import { ${TARGET} } from '../routes';`,
            }));

            const result = evaluateReferenceBeforeDelete(
              [...prodFiles, ...testFiles],
              TARGET,
            );

            expect(result.decision).toBe('abort');
            expect(result.fileRetained).toBe(true);
            // Only production files count toward the blocking references.
            expect(result.productionReferences.length).toBe(prodFiles.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

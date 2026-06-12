/**
 * Reference-before-delete guard (FIX-BE-2)
 *
 * Encapsulates the "reference-before-delete" static-search decision that gated
 * the deletion of the dead `src/routes/index.ts` (which exported `setupRoutes`).
 *
 * The deletion of a dead module must only proceed when NO production source file
 * references the symbol. Production sources are all files EXCEPT test files
 * (anything matching `*.test.ts` / `*.spec.ts`) and files inside `__tests__/`
 * directories. If any production file references the symbol, the deletion must
 * ABORT and the target file is retained.
 *
 * Modelled as a pure function over a set of files + contents so the abort-on-
 * reference logic is deterministically testable (the real deletion was a
 * one-shot manual operation).
 */

export interface SourceFile {
  /** Workspace-relative or absolute path of the file. */
  path: string;
  /** Raw text contents of the file. */
  contents: string;
}

export type GuardDecision = 'proceed' | 'abort';

export interface ReferenceGuardResult {
  /** Whether the deletion should proceed or abort. */
  decision: GuardDecision;
  /**
   * Whether the target file is retained. True whenever the decision is 'abort'
   * (the file is kept untouched); false when the decision is 'proceed'.
   */
  fileRetained: boolean;
  /** Paths of production (non-test) files that reference the symbol. */
  productionReferences: string[];
}

/**
 * Returns true if the file path is a test file and therefore NOT a production
 * source for the purposes of the reference search.
 */
export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)__tests__\//.test(normalized)
  );
}

/**
 * Detects whether a file's contents import/require the given symbol.
 *
 * Matches the symbol as a whole word inside an `import { ... }` clause, a
 * default/namespace import, or a `require(...)` destructure — i.e. an actual
 * code reference rather than an incidental substring inside a comment or
 * unrelated identifier.
 */
export function referencesSymbol(contents: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b${escaped}\\b`);

  // Scan import / require statements only, so comments mentioning the symbol
  // (e.g. "the now-removed setupRoutes") do not count as references. Each
  // statement is captured up to its terminating semicolon or end of line.
  const importLike =
    /\bimport\b[^;\n]*|(?:\b(?:const|let|var)\b[^;\n]*=\s*require\s*\([^)]*\)[^;\n]*)/g;
  let match: RegExpExecArray | null;
  while ((match = importLike.exec(contents)) !== null) {
    if (word.test(match[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Runs the reference-before-delete guard.
 *
 * @param files  The set of files (path + contents) to search.
 * @param symbol The exported symbol whose references block deletion (e.g. `setupRoutes`).
 * @returns A decision describing whether deletion may proceed and which
 *          production files (if any) still reference the symbol.
 */
export function evaluateReferenceBeforeDelete(
  files: SourceFile[],
  symbol: string,
): ReferenceGuardResult {
  const productionReferences = files
    .filter((file) => !isTestFile(file.path))
    .filter((file) => referencesSymbol(file.contents, symbol))
    .map((file) => file.path);

  const shouldAbort = productionReferences.length > 0;

  return {
    decision: shouldAbort ? 'abort' : 'proceed',
    fileRetained: shouldAbort,
    productionReferences,
  };
}

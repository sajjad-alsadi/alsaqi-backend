/**
 * Static-analysis guard: scoped `no-explicit-any` over the core layer.
 *
 * Requirement 26 mandates that the core data-access layer be typed, with ZERO
 * occurrences of the implicit or explicit `any` type in the PUBLIC SIGNATURES
 * of:
 *   - the database client and its query wrapper (Req 26.1), and
 *   - the auth-middleware request/response handlers (Req 26.2);
 * and that detection fail the check with a diagnostic identifying each
 * offending location, without producing build artifacts (Req 26.3, 26.4).
 *
 * Why a scoped Vitest guard rather than a repo-wide `tsc`/`eslint` gate:
 * the project builds via esbuild (not `tsc`), and a whole-repo `tsc --noEmit`
 * reports a large volume of pre-existing, unrelated diagnostics
 * (extensionless `nodenext` imports, `@alsaqi/shared` resolution). A global
 * gate is therefore not viable. This guard instead parses ONLY the scoped core
 * files with the TypeScript parser and asserts that `any` never appears in a
 * public signature position. It is a pure static analysis test — it emits no
 * build output (Req 26.4).
 *
 * What counts as a "public signature" `any` (and what does NOT):
 *   - REPORTED: `any` in a parameter type or return type of a request/response
 *     handler (a function whose parameters include req/res/next), and `any` in
 *     the parameter/return types or members of EXPORTED functions, classes
 *     (public members), interfaces, and type aliases.
 *   - IGNORED: `any` inside a function body (local variables, `as any`
 *     assertions, `catch (e: any)`), and `any` in the signatures of
 *     non-exported internal helpers that are not handlers. These are
 *     implementation details, not public signatures, and are out of scope for
 *     Requirement 26.1/26.2.
 *
 * The DB wrapper's public surface (`IDBWrapper`, `DBWrapper`, `getPool`,
 * `PreparedStatement`, and the client/connection types) and every
 * auth-middleware handler must be free of public-signature `any`.
 *
 * **Validates: Requirements 26.1, 26.2, 26.3, 26.4**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The scoped core files. Req 26.1 → db wrapper; Req 26.2 → auth handlers. */
const SCOPED_FILES: readonly string[] = [
  resolve(SRC_DIR, 'db', 'index.ts'),
  resolve(SRC_DIR, 'middleware', 'auth.ts'),
];

/** Parameter names that identify an Express request/response handler (Req 26.2). */
const HANDLER_PARAM_NAMES = new Set(['req', 'request', 'res', 'response', 'next']);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

/** A function node that owns a body (excludes type-only `FunctionType` etc.). */
type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Nearest enclosing function that has a body (a real function, not a type). */
function nearestFunctionWithBody(node: ts.Node): FunctionWithBody | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionWithBody(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** True when `node` is contained within `fn`'s body block (i.e. implementation, not signature). */
function isInsideBody(node: ts.Node, fn: FunctionWithBody): boolean {
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return false;
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === body) return true;
    if (current === fn) return false;
    current = current.parent;
  }
  return false;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasPrivateOrProtected(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some(
    (m) =>
      m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/** A function is a "handler" when any of its parameters is named req/res/next, etc. */
function isHandlerFunction(fn: FunctionWithBody): boolean {
  return fn.parameters.some(
    (p) => ts.isIdentifier(p.name) && HANDLER_PARAM_NAMES.has(p.name.text),
  );
}

/**
 * Whether a function's signature is part of the file's public API surface:
 * an exported function/class member, or an arrow/function assigned to an
 * exported variable (e.g. `export const createAuthMiddlewares = (...) => {}`).
 */
function isExportedOrPublic(fn: FunctionWithBody): boolean {
  if (ts.isFunctionDeclaration(fn)) {
    return hasExportModifier(fn);
  }

  if (
    ts.isMethodDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn) ||
    ts.isConstructorDeclaration(fn)
  ) {
    // Public member (not private/protected, not a #private name) of an exported class.
    const cls = fn.parent;
    if (cls && ts.isClassLike(cls)) {
      const memberIsPublic =
        !hasPrivateOrProtected(fn) &&
        !(fn.name && ts.isPrivateIdentifier(fn.name));
      return memberIsPublic && hasExportModifier(cls);
    }
    return false;
  }

  // Arrow / function expression assigned to a variable: exported if the
  // enclosing `const/let` statement is exported.
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    const list = parent.parent; // VariableDeclarationList
    const stmt = list?.parent; // VariableStatement
    if (stmt && ts.isVariableStatement(stmt)) {
      return hasExportModifier(stmt);
    }
  }
  return false;
}

/** The nearest exported top-level declaration enclosing `node`, if any. */
function isInExportedTopLevelDeclaration(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isEnumDeclaration(current)
    ) {
      return hasExportModifier(current);
    }
    if (ts.isVariableStatement(current)) {
      return hasExportModifier(current);
    }
    current = current.parent;
  }
  return false;
}

/** Climb out of nested type expressions (unions, arrays, `Promise<...>`, etc.). */
function typeRootOwner(anyNode: ts.Node): ts.Node | undefined {
  let node: ts.Node = anyNode;
  while (node.parent && ts.isTypeNode(node.parent)) {
    node = node.parent;
  }
  return node.parent;
}

function collectViolations(filePath: string): Violation[] {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];
  const relPath = relative(SRC_DIR, filePath);

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      classifyAny(node);
    }
    ts.forEachChild(node, visit);
  };

  const classifyAny = (anyNode: ts.Node): void => {
    // Skip `any` used in a type assertion (`x as any`, `<any>x`); these are
    // expression-level, not public signatures.
    const owner = typeRootOwner(anyNode);
    if (
      owner &&
      (ts.isAsExpression(owner) ||
        ts.isTypeAssertionExpression(owner) ||
        (ts.isSatisfiesExpression?.(owner) ?? false))
    ) {
      return;
    }

    const fn = nearestFunctionWithBody(anyNode);

    if (fn) {
      // `any` inside a function body is an implementation detail, not a signature.
      if (isInsideBody(anyNode, fn)) return;

      // Otherwise the `any` is in this function's parameters or return type.
      if (isHandlerFunction(fn)) {
        addViolation(anyNode, 'explicit `any` in a request/response handler signature (Req 26.2)');
        return;
      }
      if (isExportedOrPublic(fn)) {
        addViolation(anyNode, 'explicit `any` in an exported/public function signature (Req 26.1)');
        return;
      }
      // Non-exported internal helper that is not a handler: out of scope.
      return;
    }

    // No enclosing function: `any` sits in an interface/type-alias/class
    // property or exported variable type. Report only when the enclosing
    // top-level declaration is exported (public API surface).
    if (isInExportedTopLevelDeclaration(anyNode)) {
      addViolation(anyNode, 'explicit `any` in an exported type/interface/class member (Req 26.1)');
    }
  };

  const addViolation = (anyNode: ts.Node, reason: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(anyNode.getStart(sourceFile));
    const lineText = sourceText.split(/\r?\n/)[line] ?? '';
    violations.push({
      file: relPath,
      line: line + 1,
      column: character + 1,
      snippet: lineText.trim(),
      reason,
    });
  };

  visit(sourceFile);
  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line}:${v.column} — ${v.reason}\n      > ${v.snippet}`)
    .join('\n');
}

describe('core layer scoped no-explicit-any guard (Req 26.1, 26.2, 26.3, 26.4)', () => {
  it('sanity check: the guard parses every scoped core file', () => {
    for (const file of SCOPED_FILES) {
      const text = readFileSync(file, 'utf-8');
      expect(text.length, `scoped file is empty or unreadable: ${file}`).toBeGreaterThan(0);
    }
  });

  it('reports zero explicit `any` in the public signatures of the scoped core files', () => {
    const violations = SCOPED_FILES.flatMap(collectViolations);

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Found explicit \`any\` in core-layer public signatures (Requirement 26). ` +
            `The database client/wrapper (src/db/index.ts) and auth-middleware handlers ` +
            `(src/middleware/auth.ts) must declare explicit types with no \`any\` in their ` +
            `public signatures. Offending location(s):\n${formatViolations(violations)}`,
    ).toEqual([]);
  });
});

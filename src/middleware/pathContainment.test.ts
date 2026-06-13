/**
 * Property-based tests for the path-containment helper
 * (`src/middleware/pathContainment.ts`).
 *
 * Spec: .kiro/specs/backend-security-hardening (task 10.7)
 *
 * Feature: backend-security-hardening, Property 20: Upload-directory containment
 *
 * Property 20 (Validates: Requirements 10.1, 10.2, 10.3, 10.4):
 *   For any requested relative path (including ones with `.`/`..` traversal
 *   segments and ones that name sibling directories such as `uploads_backup`),
 *   `checkContainment` reports the path as contained if and only if its canonical
 *   resolved absolute path equals the resolved upload directory or begins with the
 *   resolved upload directory followed immediately by the platform path separator;
 *   non-contained paths are denied (contained === false).
 *
 * The tests build a real temporary directory tree so the symlink/sibling cases
 * exercise actual on-disk resolution rather than a simulated one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { checkContainment } from './pathContainment';

const NUM_RUNS = 200;

// A real, canonical upload directory and a real sibling directory that shares the
// upload directory's name as a prefix (e.g. `uploads` vs `uploads_backup`).
let uploadDir: string;
let baseName: string;
let siblingDir: string;

beforeAll(() => {
  // `realpathSync` collapses any platform-specific aliasing (e.g. macOS /var ->
  // /private/var, Windows short names) so the test's expectations match the
  // helper's canonicalization.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-')));
  baseName = 'uploads';
  uploadDir = path.join(root, baseName);
  fs.mkdirSync(uploadDir, { recursive: true });

  // Sibling that merely shares the upload directory name as a string prefix.
  siblingDir = path.join(root, `${baseName}_backup`);
  fs.mkdirSync(siblingDir, { recursive: true });

  // Some genuine nested content inside the upload directory.
  fs.mkdirSync(path.join(uploadDir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'file.txt'), 'hello');
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'leak');
});

afterAll(() => {
  // Remove the whole temp tree (parent of uploadDir).
  const parent = path.dirname(uploadDir);
  fs.rmSync(parent, { recursive: true, force: true });
});

// Safe path segments that never themselves introduce traversal or separators.
const safeSegment = fc.constantFrom(
  'a',
  'b',
  'c',
  'docs',
  'img',
  'sub',
  'deep',
  'file.txt',
  'nested',
);

// A relative path composed only of safe segments — always stays inside the base.
const insideRelPath = fc
  .array(safeSegment, { minLength: 0, maxLength: 6 })
  .map((segs) => segs.join('/'));

// Names guaranteed NOT to be the upload directory's own name, used to construct
// escaping paths and sibling targets.
const escapeName = fc.constantFrom(
  'evil',
  'other',
  'etc',
  'secret',
  `${'uploads'}_backup`, // the real sibling
  'passwd',
);

describe('Feature: backend-security-hardening, Property 20: Upload-directory containment', () => {
  it('never throws for arbitrary requested paths', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => checkContainment(uploadDir, raw)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('treats the upload directory itself as contained (empty, ".", "./")', () => {
    for (const self of ['', '.', './', './.']) {
      const res = checkContainment(uploadDir, self);
      expect(res.contained).toBe(true);
      expect(res.resolvedPath).toBe(uploadDir);
    }
  });

  it('reports paths composed only of safe segments as contained inside the base', () => {
    fc.assert(
      fc.property(insideRelPath, (rel) => {
        const res = checkContainment(uploadDir, rel);
        expect(res.contained).toBe(true);
        expect(res.resolvedPath).not.toBeNull();
        // Resolved path is the base itself or a true child at a separator boundary.
        const inside =
          res.resolvedPath === uploadDir ||
          res.resolvedPath!.startsWith(uploadDir + path.sep);
        expect(inside).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('reports balanced traversal that nets back inside as contained', () => {
    // Descend k safe segments then climb j (<= k) levels — always lands inside.
    const balanced = fc
      .array(safeSegment, { minLength: 1, maxLength: 6 })
      .chain((segs) =>
        fc.tuple(fc.constant(segs), fc.integer({ min: 0, max: segs.length })),
      )
      .map(([segs, up]) => [...segs, ...Array(up).fill('..')].join('/'));

    fc.assert(
      fc.property(balanced, (rel) => {
        const res = checkContainment(uploadDir, rel);
        expect(res.contained).toBe(true);
        const inside =
          res.resolvedPath === uploadDir ||
          res.resolvedPath!.startsWith(uploadDir + path.sep);
        expect(inside).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects parent-directory traversal that escapes the upload directory', () => {
    // k>=1 levels up, then into a name that is not the base name => outside base.
    const escaping = fc
      .tuple(
        fc.integer({ min: 1, max: 6 }),
        escapeName,
        fc.array(safeSegment, { maxLength: 3 }),
      )
      .map(([up, name, tail]) =>
        [...Array(up).fill('..'), name, ...tail].join('/'),
      );

    fc.assert(
      fc.property(escaping, (rel) => {
        const res = checkContainment(uploadDir, rel);
        expect(res.contained).toBe(false);
        // When not contained, the helper must not claim an inside resolution.
        if (res.resolvedPath !== null) {
          expect(res.resolvedPath === uploadDir).toBe(false);
          expect(res.resolvedPath.startsWith(uploadDir + path.sep)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects sibling directories that share the upload directory name as a prefix', () => {
    // e.g. `../uploads_backup`, `../uploads_backup/secret.txt`.
    const siblingRel = fc
      .array(safeSegment, { maxLength: 3 })
      .map((tail) => ['..', `${baseName}_backup`, ...tail].join('/'));

    fc.assert(
      fc.property(siblingRel, (rel) => {
        const res = checkContainment(uploadDir, rel);
        expect(res.contained).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );

    // Also via an absolute path directly into the real sibling directory.
    expect(checkContainment(uploadDir, siblingDir).contained).toBe(false);
    expect(
      checkContainment(uploadDir, path.join(siblingDir, 'secret.txt')).contained,
    ).toBe(false);
  });

  it('matches the canonical separator-aware oracle for mixed traversal inputs', () => {
    // Mixed inputs: arbitrary interleavings of safe segments and `..`/`.`.
    const mixedSegment = fc.oneof(safeSegment, fc.constantFrom('..', '.'), escapeName);
    const mixedRel = fc
      .array(mixedSegment, { minLength: 0, maxLength: 8 })
      .map((segs) => segs.join('/'));

    fc.assert(
      fc.property(mixedRel, (rel) => {
        const res = checkContainment(uploadDir, rel);
        // Ground truth: resolve against the (already canonical) base. Because the
        // base and all generated targets live in a symlink-free temp tree, plain
        // path.resolve reproduces the canonical resolution the helper performs.
        const expectedResolved = path.resolve(uploadDir, rel);
        const expectedContained =
          expectedResolved === uploadDir ||
          expectedResolved.startsWith(uploadDir + path.sep);
        expect(res.contained).toBe(expectedContained);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  describe('symlink escape (best-effort; skipped where unsupported)', () => {
    it('treats an in-directory symlink that points outside as not contained', () => {
      const linkPath = path.join(uploadDir, 'escape-link');
      let created = false;
      try {
        fs.symlinkSync(siblingDir, linkPath, 'dir');
        created = true;
      } catch {
        // Symlink creation can require privileges (notably on Windows). Skip
        // gracefully rather than failing the suite on environment limitations.
        return;
      }

      try {
        // The link resolves (via realpath) to the sibling directory, outside base.
        const res = checkContainment(uploadDir, 'escape-link');
        expect(res.contained).toBe(false);

        const viaLink = checkContainment(uploadDir, 'escape-link/secret.txt');
        expect(viaLink.contained).toBe(false);
      } finally {
        if (created) fs.rmSync(linkPath, { force: true });
      }
    });
  });
});

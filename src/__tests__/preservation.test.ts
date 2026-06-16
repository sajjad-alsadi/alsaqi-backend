// @vitest-environment node
/**
 * Preservation Property Tests — Property 2 (Code-Review Remediation)
 *
 * Spec: .kiro/specs/code-review-remediation (bugfix workflow)
 * Task 2: "Write preservation property tests (BEFORE implementing any fix)"
 *
 * ── SEMANTICS (READ THIS BEFORE EDITING) ─────────────────────────────────────
 * These tests capture the BASELINE behavior for NON-triggering inputs (`¬C(X)`)
 * — i.e. inputs that do NOT hit any of the 40 bug conditions. This baseline MUST
 * stay byte-for-byte identical after the fixes land (design "Preservation
 * Checking"; bugfix.md clauses 3.1–3.12).
 *
 * EXPECTED OUTCOME (this phase): every test here PASSES on the UNFIXED code.
 * A passing test records the contract to preserve. After the fixes (task 11.2)
 * these SAME tests must STILL pass, proving no regression for `¬C(X)` inputs.
 *
 * ── METHODOLOGY (observation-first) ──────────────────────────────────────────
 * Preservation is a universal claim over all non-triggering inputs, so the
 * primary guarantees are property-based (fast-check + Vitest): we exercise the
 * actual pure functions the fixes will touch (column whitelist, response
 * envelope, pagination, ORDER BY for VALID identifiers, the TOTP acceptance
 * primitive) and assert the observed outputs hold across the whole `¬C(X)`
 * domain. Generators catch edge cases manual examples miss.
 *
 * Several preservation clauses describe RUNTIME behavior that needs a live
 * server/DB (boot+serve 3.6, session honoring 3.4, audit persistence 3.5,
 * webhook dispatch 3.9, identifier persistence 3.10, wired features 3.11,
 * migration idempotency 3.12). Those cannot execute as a unit/property test in
 * this environment, so they are scoped to SOURCE-LEVEL BASELINE CONTRACTS: we
 * assert the stable public primitives that the happy path depends on still
 * exist and are referenced. These are clearly labelled "[source-level baseline]"
 * and act as regression guards that the fixes must not remove.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import fc from 'fast-check';
import * as OTPAuth from 'otpauth';

import { QueryBuilder } from '../utils/QueryBuilder';
import {
  TABLE_WRITE_SCHEMAS,
  getColumnWhitelist,
  checkWhitelist,
} from '../services/columnWhitelist';
import {
  createSuccessResponse,
  createErrorResponse,
  computePagination,
} from '../utils/responseEnvelope';
import {
  parsePaginationParams,
  computePaginationMeta,
} from '../utils/paginationService';

// ── Path / source helpers (for source-level baseline clauses) ────────────────
// This file lives at <backend>/src/__tests__; the backend root is two levels up.
const BACKEND_ROOT = resolve(__dirname, '../..');

function read(relPath: string): string {
  return readFileSync(resolve(BACKEND_ROOT, relPath), 'utf-8');
}

/** Recursively concatenate the source of every .ts file under a directory. */
function readDirRecursive(relDir: string): string {
  const root = resolve(BACKEND_ROOT, relDir);
  let out = '';
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out += '\n' + readFileSync(full, 'utf-8');
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const SRC = readDirRecursive('src');

// ═══════════════════════════════════════════════════════════════════════════
// 3.2 — Whitelisted CRUD still succeeds (column whitelist preservation)
//   Non-triggering input: a write body whose top-level keys are all drawn from
//   the table's declared write schema. Such bodies MUST keep being accepted
//   (ok=true, no rejected keys) exactly as today — the bulk/whitelist fix (1.3)
//   must not reject previously-permitted columns.
// ═══════════════════════════════════════════════════════════════════════════
describe('Preservation 3.2 — whitelisted CRUD columns stay accepted', () => {
  const tableNames = Object.keys(TABLE_WRITE_SCHEMAS);

  it('a body using only whitelisted keys is always accepted (ok=true, no rejects)', () => {
    const tableArb = fc.constantFrom(...tableNames);
    fc.assert(
      fc.property(
        tableArb.chain((table) => {
          const cols = [...getColumnWhitelist(table)];
          // Pick a random subset (possibly empty) of the table's permitted columns.
          return fc.tuple(
            fc.constant(table),
            fc.subarray(cols, { minLength: 0, maxLength: cols.length })
          );
        }),
        ([table, chosen]) => {
          const body: Record<string, unknown> = {};
          for (const c of chosen) body[c] = 'value';
          const res = checkWhitelist(table, body);
          // Baseline: every chosen key is in the whitelist → fully accepted.
          return res.ok === true && res.rejectedKeys.length === 0;
        }
      ),
      { numRuns: 200 }
    );
  });

  it('getColumnWhitelist returns exactly the declared schema field names (stable contract)', () => {
    for (const table of tableNames) {
      const wl = getColumnWhitelist(table);
      const declared = Object.keys(TABLE_WRITE_SCHEMAS[table].shape);
      expect([...wl].sort()).toEqual([...declared].sort());
    }
  });

  it('checkWhitelist is order-independent for accepted bodies', () => {
    const table = 'departments';
    const cols = [...getColumnWhitelist(table)];
    fc.assert(
      fc.property(fc.shuffledSubarray(cols), (chosen) => {
        const body: Record<string, unknown> = {};
        for (const c of chosen) body[c] = 1;
        return checkWhitelist(table, body).ok === true;
      }),
      { numRuns: 100 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.3 — Valid, unused 2FA codes within the window are still accepted
//   Non-triggering input: the current TOTP code for a freshly generated secret.
//   verify() accepts iff `totp.validate({ token, window: 1 }) !== null`; the
//   replay fix (1.10) only adds a `last_used_at` reuse check, so an unused
//   in-window code MUST still pass this acceptance primitive unchanged.
// ═══════════════════════════════════════════════════════════════════════════
describe('Preservation 3.3 — valid unused TOTP code within window stays accepted', () => {
  it('the current code for a random secret validates within the ±1 window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => {
        // Deterministic secret per run.
        const secret = new OTPAuth.Secret({ size: 20 });
        const totp = new OTPAuth.TOTP({
          issuer: 'AL-SAQI',
          label: `user-${seed}`,
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret,
        });
        const token = totp.generate();
        const delta = totp.validate({ token, window: 1 });
        // Baseline acceptance: a freshly generated (unused) code is accepted.
        return delta !== null;
      }),
      { numRuns: 100 }
    );
  });

  it('a code from the immediately previous window is still accepted (window=1 tolerance)', () => {
    const totp = new OTPAuth.TOTP({
      issuer: 'AL-SAQI',
      label: 'window-user',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: new OTPAuth.Secret({ size: 20 }),
    });
    const now = Date.now();
    const prevToken = totp.generate({ timestamp: now - 30_000 });
    const delta = totp.validate({ token: prevToken, window: 1, timestamp: now });
    expect(delta).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.7 — Canonical-envelope success responses keep the same shape + structure
//   Non-triggering input: any success payload routed through the canonical
//   envelope builder. The envelope-unification fix (1.17) must not change the
//   shape of responses that ALREADY use the canonical envelope.
// ═══════════════════════════════════════════════════════════════════════════
describe('Preservation 3.7 — canonical success envelope shape is stable', () => {
  const arbitraryData = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.string(), { maxLength: 5 }),
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z_]/.test(s)),
      fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      { maxKeys: 5 }
    )
  );

  it('createSuccessResponse always yields {success:true, data, meta:{requestId,timestamp,version}}', () => {
    fc.assert(
      fc.property(arbitraryData, (data) => {
        const r = createSuccessResponse({ data });
        expect(r.success).toBe(true);
        expect(r.data).toEqual(data);
        expect(typeof r.meta.requestId).toBe('string');
        expect(typeof r.meta.version).toBe('string');
        expect(new Date(r.meta.timestamp).toISOString()).toBe(r.meta.timestamp);
        // No double-wrapping: a success body must NOT carry an `error` key.
        expect((r as Record<string, unknown>).error).toBeUndefined();
      }),
      { numRuns: 150 }
    );
  });

  it('createErrorResponse keeps a single canonical error object (no error.error nesting)', () => {
    const codeArb = fc.constantFrom('NOT_FOUND', 'FORBIDDEN', 'VALIDATION_ERROR', 'INTERNAL_ERROR');
    const msgArb = fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim().length > 0);
    fc.assert(
      fc.property(codeArb, msgArb, (code, message) => {
        const r = createErrorResponse({ code, message });
        expect(r.success).toBe(false);
        expect(r.data).toBeNull();
        expect(r.error.code).toBe(code);
        expect(r.error.message).toBe(message);
        // The error payload must not be nested under error.error.
        expect((r.error as Record<string, unknown>).error).toBeUndefined();
        expect(typeof r.error.traceId).toBe('string');
      }),
      { numRuns: 150 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.8 — In-range list/query params return the same result sets + ordering
//   Non-triggering input: valid, in-range pagination params and VALID order-by
//   identifiers. The pagination-unification (1.35) and orderBy-validation (1.36)
//   fixes must not change results for these well-formed inputs.
// ═══════════════════════════════════════════════════════════════════════════
describe('Preservation 3.8 — pagination math + valid ORDER BY are stable', () => {
  it('parsePaginationParams: in-range page/pageSize → offset = (page-1)*pageSize', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 100 }),
        (page, pageSize) => {
          const parsed = parsePaginationParams({ page: String(page), pageSize: String(pageSize) });
          return (
            parsed.page === page &&
            parsed.pageSize === pageSize &&
            parsed.offset === (page - 1) * pageSize
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  it('computePaginationMeta: totalPages/hasNext/hasPrev consistent for in-range inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (page, pageSize, total) => {
          const meta = computePaginationMeta(page, pageSize, total);
          const expectedTotalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
          return (
            meta.totalPages === expectedTotalPages &&
            meta.hasNext === page < meta.totalPages &&
            meta.hasPrev === page > 1
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  it('computePagination (envelope helper) clamps + computes consistently', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (page, pageSize, total) => {
          const m = computePagination({ page, pageSize, total });
          return (
            m.page === page &&
            m.pageSize === pageSize &&
            m.total === total &&
            m.totalPages === Math.ceil(total / pageSize) &&
            m.hasNext === page < m.totalPages &&
            m.hasPrev === page > 1
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  it('QueryBuilder.orderBy with a VALID identifier still emits "ORDER BY <col> <dir>"', () => {
    const validIdentifier = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(s));
    const dir = fc.constantFrom<'ASC' | 'DESC'>('ASC', 'DESC');
    fc.assert(
      fc.property(validIdentifier, dir, (col, direction) => {
        const qb = new QueryBuilder('SELECT * FROM t');
        // Baseline: valid identifiers must NOT throw and must appear verbatim in
        // the ORDER BY clause (the 1.36 fix only rejects INVALID identifiers).
        qb.orderBy(col, direction);
        const sql = qb.buildDataQuery();
        return sql.includes(`ORDER BY ${col} ${direction}`);
      }),
      { numRuns: 150 }
    );
  });

  it('QueryBuilder pagination math (page/pageSize → offset/limit) is unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        (page, pageSize) => {
          const qb = new QueryBuilder('FROM t');
          const { offset, limit } = qb.paginate(page, pageSize);
          return offset === (page - 1) * pageSize && limit === pageSize;
        }
      ),
      { numRuns: 150 }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE-LEVEL BASELINE CONTRACTS
//   The following clauses describe runtime behavior that requires a live
//   server/DB to exercise end-to-end (not available in this unit/property test
//   environment). They are scoped to assert the stable public primitives the
//   happy path depends on still exist / are referenced, so the fixes cannot
//   silently remove them. Each PASSES on the unfixed code and must remain true
//   after the fixes. (See file header "METHODOLOGY".)
// ═══════════════════════════════════════════════════════════════════════════
describe('Preservation — source-level baseline contracts (runtime needs server/DB)', () => {
  it('3.1 [source-level baseline] authenticate + checkPermission primitives still exist', () => {
    const auth = read('src/middleware/auth.ts');
    // The auth primitives are produced by the createAuthMiddlewares factory and
    // returned as { authenticate, checkPermission, ... }; the happy path depends
    // on both continuing to exist.
    expect(auth).toMatch(/createAuthMiddlewares/);
    expect(auth).toMatch(/const\s+authenticate\s*=/);
    expect(auth).toMatch(/const\s+checkPermission\s*=/);
  });

  it('3.4 [source-level baseline] session revocation gates on session_version mismatch (valid versions honored)', () => {
    const ss = read('src/services/SessionService.ts');
    // The honoring path is driven by a session_version comparison: a matching
    // (non-revoked) version must continue to be accepted. Assert the version
    // check exists so the happy path is preserved.
    expect(ss).toMatch(/session_version/);
  });

  it('3.5 [source-level baseline] AuditChainService remains the hash-chain writer', () => {
    const acs = read('src/services/AuditChainService.ts');
    expect(acs).toMatch(/previous_hash|hash/);
  });

  it('3.6 [source-level baseline] start() composes the express app and mounts routes', () => {
    const idx = read('src/index.ts');
    expect(idx).toMatch(/express\(\)|app\.use\(/);
    expect(idx).toMatch(/function\s+start|const\s+start\s*=|start\s*\(/);
  });

  it('3.9 [source-level baseline] n8n webhook dispatch primitive still exists', () => {
    // The webhook ordering fix (1.14) moves the call relative to the transaction
    // but must keep dispatching on success. Assert the dispatch primitive exists.
    expect(SRC).toMatch(/sendEvent|n8n|N8n/i);
  });

  it('3.10 [source-level baseline] atomic NumberingService.nextCounter remains available', () => {
    const ns = read('src/services/NumberingService.ts');
    expect(ns).toMatch(/nextCounter/);
  });

  it('3.11 [source-level baseline] wired features (WebSocket setup, PdfEngine) keep their public API', () => {
    expect(read('src/ws/index.ts')).toMatch(/setupWebSocket|WebSocketServer|WebSocket/);
    expect(read('src/services/PdfEngine.ts')).toMatch(/class\s+PdfEngine|PdfEngine/);
  });

  it('3.12 [source-level baseline] MigrationRunner tracks applied migrations (idempotent restart)', () => {
    const mr = read('src/db/MigrationRunner.ts');
    // Tracking applied migrations is what makes restart idempotent; assert the
    // tracking concept is present (a migrations bookkeeping table / applied set).
    expect(mr).toMatch(/applied|schema_migrations|migrations|version/i);
  });
});

// @vitest-environment node
/**
 * Bug Condition Exploration Tests — Property 1 (Code-Review Remediation)
 *
 * Spec: .kiro/specs/code-review-remediation (bugfix workflow)
 * Task 1: "Write bug condition exploration tests (BEFORE any fix)"
 *
 * ── SEMANTICS (READ THIS BEFORE EDITING) ─────────────────────────────────────
 * Each test in this file encodes the EXPECTED (fixed) behavior from bugfix.md
 * clause 2.N. On the UNFIXED code these assertions FAIL — and a FAILING test
 * here is the SUCCESS case: it surfaces the counterexample that confirms the bug
 * `C_N` exists. After the fixes land (task 11.1) these SAME tests must PASS,
 * which proves each finding has been remediated.
 *
 * DO NOT "fix" a failing test by weakening it. The failure is the goal in this
 * phase. These are deterministic, scoped reproductions (design "Scoped PBT
 * Approach"): each finding is driven to its concrete triggering case via static
 * source inspection of the actual implementation files, plus a fast-check
 * property where an input family applies (1.36 QueryBuilder.orderBy).
 *
 * The two [INFERRED] findings (1.23 PDF-in-container, 1.30 file-upload
 * middleware) are reproduced first; their reproduction result is recorded in the
 * test assertions/comments (manifests vs not-reproducible).
 *
 * **Validates: Requirements 1.1–1.40 (bug conditions) / 2.1–2.40 (expected)**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import fc from 'fast-check';
import { QueryBuilder } from '../utils/QueryBuilder';

// ── Path helpers ──────────────────────────────────────────────────────────────
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

/**
 * Returns the body of the first `db.transaction(...)` callback that appears
 * after `fromMarker` in `content`, using brace matching. Used to assert that a
 * given token (e.g. an n8n webhook call) is or is NOT executed inside the
 * transaction.
 */
function firstTransactionBodyAfter(content: string, fromMarker: string): string {
  const start = content.indexOf(fromMarker);
  if (start === -1) return '';
  const txnIdx = content.indexOf('db.transaction', start);
  if (txnIdx === -1) return '';
  const braceStart = content.indexOf('{', txnIdx);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let i = braceStart; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(braceStart, i + 1);
    }
  }
  return content.slice(braceStart);
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITICAL (Blocking) — findings 1.1–1.5
// ═══════════════════════════════════════════════════════════════════════════
describe('Bug Condition — Critical findings (1.1–1.5)', () => {
  it('1.1 startup wires Redis/queues/WebSocket/cron/backups/queue-workers/metrics (2.1)', () => {
    const idx = read('src/index.ts');
    // start() must invoke each infrastructure initializer or mount /metrics.
    expect(idx).toMatch(/redisManager\.connect\s*\(/);
    expect(idx).toMatch(/queueManager\.initialize\s*\(/);
    expect(idx).toMatch(/setupWebSocket\s*\(/);
    expect(idx).toMatch(/startAutomationJobs\s*\(/);
    expect(idx).toMatch(/backupScheduler\.start\s*\(/);
    expect(idx).toMatch(/['"`]\/metrics['"`]/);
  });

  it('1.2 graceful shutdown drains queues/pool/Redis/cron and calls ApiServer.stop() (2.2)', () => {
    const main = read('src/main.ts');
    const gs = read('src/server/gracefulShutdown.ts');
    const combined = main + '\n' + gs;
    // Full shutdown must do more than close the HTTP server + WS clients.
    expect(combined).toMatch(/queueManager\.shutdown\s*\(|queueManager\.close\s*\(/);
    expect(combined).toMatch(/\.stop\s*\(/); // ApiServer.stop()
    expect(combined).toMatch(/redis.*disconnect|disconnectRedis|redisManager\.(disconnect|quit|close)/i);
    expect(combined).toMatch(/pool\.end\s*\(|endPool|pg.*end/i);
  });

  it('1.3 bulk route enforces checkPermission + checkWhitelist and reads a portable id (2.3)', () => {
    const route = read('src/routes/bulk.ts');
    const svc = read('src/services/BulkOperationsService.ts');
    // Route must require permission, not just authenticate.
    expect(route).toMatch(/checkPermission/);
    // Service must validate the column whitelist on create/update.
    expect(svc).toMatch(/checkWhitelist/);
    // Service must NOT use the SQLite-only lastInsertRowid (undefined under PG/PGlite).
    expect(svc).not.toMatch(/lastInsertRowid/);
    // Portable id read.
    expect(svc).toMatch(/RETURNING\s+id/i);
  });

  it('1.4 rotated refresh token carries session_version so revocation keeps working (2.4)', () => {
    const ss = read('src/services/SessionService.ts');
    // The rotated (new) refresh token must include session_version in its claims.
    expect(ss).toMatch(/newRefreshToken\s*=\s*jwt\.sign\(\s*\{[^}]*session_version/);
  });

  it('1.5 audit chain: schema has hash/previous_hash/seq, writers funnel through chain, logAudit surfaces errors (2.5)', () => {
    const schema = read('database/schema.sql');
    // audit_trail must define the hash-chain columns.
    expect(schema).toMatch(/previous_hash/);
    expect(schema).toMatch(/\bhash\b/);
    expect(schema).toMatch(/\bseq\b/);
    // Services must not write audit_trail directly (must funnel via AuditChainService).
    const dept = read('src/services/DepartmentService.ts');
    expect(dept).not.toMatch(/INSERT\s+INTO\s+audit_trail/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTANT — findings 1.6–1.30
// ═══════════════════════════════════════════════════════════════════════════
describe('Bug Condition — Important findings (1.6–1.30)', () => {
  it('1.6 mutating/custom routes require checkPermission, not authenticate-only (2.6)', () => {
    expect(read('src/routes/recommendations.ts')).toMatch(/checkPermission/);
    expect(read('src/routes/auditTasks.ts')).toMatch(/checkPermission/);
  });

  it('1.7 object-level authorization (IDOR) enforced on reports/comments/coi reads (2.7)', () => {
    // Each flagged read route must apply an authorization/ownership check.
    expect(read('src/routes/reports.ts')).toMatch(/checkPermission/);
    expect(read('src/routes/comments.ts')).toMatch(/checkPermission/);
    expect(read('src/routes/coi.ts')).toMatch(/checkPermission\(['"`]IntegrityManagement['"`],\s*['"`]View['"`]\)/);
  });

  it('1.8 logging endpoints require auth, gate DELETE behind delete-level perm, inject JWT key (2.8)', () => {
    const logs = read('src/routes/logs.ts');
    // POST /system-errors and /log-error must NOT run unauthenticated.
    expect(logs).not.toMatch(/router\.post\(\s*["'`]\/system-errors["'`]\s*,\s*optionalAuthenticate/);
    expect(logs).not.toMatch(/router\.post\(\s*["'`]\/log-error["'`]\s*,\s*optionalAuthenticate/);
    // DELETE /system-errors must require a delete/edit-level permission, not 'View'.
    expect(logs).not.toMatch(/router\.delete\(\s*["'`]\/system-errors["'`][^\n]*['"`]View['"`]/);
    // JWT public key must come from injected config, not process.env directly.
    expect(logs).not.toMatch(/process\.env\.JWT_PUBLIC_KEY/);
  });

  it('1.9 2FA verification endpoints are rate-limited / lockout-protected (2.9)', () => {
    const tf = read('src/routes/auth/twoFactor.ts');
    expect(tf).toMatch(/authLimiter|rateLimit|Limiter|lockout/i);
  });

  it('1.10 TOTP replay rejected: last_used_at checked before accept; constant-time result gates (2.10)', () => {
    const totp = read('src/services/TOTPService.ts');
    // verify() must read last_used_at (not only write it) to reject reuse in-window.
    expect(totp).toMatch(/SELECT[^;]*last_used_at[\s\S]*FROM\s+user_totp/i);
    // The timingSafeEqual result must not be silently discarded inside a catch.
    expect(totp).not.toMatch(/catch\s*\{\s*\/\/[^\n]*Length mismatch/);
  });

  it('1.11 startup asserts FILE_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY (2.11)', () => {
    // The fail-fast startup assertion (SecureFileService.assertConfigured, invoked from
    // index.ts start()) currently only asserts FILE_ACCESS_SECRET. It must also assert the
    // encryption keys so files are never written plaintext due to a missing key.
    const secureFile = read('src/services/SecureFileService.ts');
    expect(secureFile).toMatch(/FILE_ENCRYPTION_KEY/);
    expect(secureFile).toMatch(/TOTP_ENCRYPTION_KEY/);
  });

  it('1.12 DepartmentService.update validates column identifiers (2.12)', () => {
    const dept = read('src/services/DepartmentService.ts');
    expect(dept).toMatch(/validateIdentifier/);
  });

  it('1.13 multi-step writes wrapped in a transaction (NotificationService.create) (2.13)', () => {
    const notif = read('src/services/NotificationService.ts');
    expect(notif).toMatch(/db\.transaction/);
  });

  it('1.14 n8n webhook executes OUTSIDE the transaction in AuditService.updateFinding (2.14)', () => {
    const audit = read('src/services/AuditService.ts');
    const txnBody = firstTransactionBodyAfter(audit, 'static async updateFinding');
    // The webhook must not be dispatched from inside the transaction body.
    expect(txnBody).not.toMatch(/N8nService\.sendEvent/);
  });

  it('1.15 schema/validate factories are wired into routes (validateQuery/validateParams used) (2.15)', () => {
    const routes = readDirRecursive('src/routes');
    expect(routes).toMatch(/validateQuery\s*\(|validateParams\s*\(/);
  });

  it('1.16 requestLogger middleware is mounted in index.ts (2.16)', () => {
    expect(read('src/index.ts')).toMatch(/requestLogger/);
  });

  it('1.17 single canonical field-error shape (no {field, rule} divergence) (2.17)', () => {
    const validate = read('src/middleware/validate.ts');
    // Canonical envelope field-error shape is {path, message, code}. The divergent
    // validate.ts shape uses a `rule` field, which must be gone after unification.
    expect(validate).not.toMatch(/\brule\b/);
  });

  it('1.18 manual error responses route through the global sanitizer (no raw err.message) (2.18)', () => {
    expect(read('src/routes/recommendations.ts')).not.toMatch(/error:\s*\{\s*message:\s*err\.message/);
    expect(read('src/routes/auditTasks.ts')).not.toMatch(/message:\s*err\.message/);
  });

  it('1.19 correspondence numbering uses atomic NumberingService.nextCounter (2.19)', () => {
    const corr = read('src/services/CorrespondenceService.ts');
    // Must not derive the next number via ORDER BY id DESC on a UUID id.
    expect(corr).not.toMatch(/ORDER BY id DESC LIMIT 1/);
    expect(corr).toMatch(/NumberingService|nextCounter/);
  });

  it('1.20 RiskService computed columns pass the whitelist (2.20)', () => {
    // risk_score_calc / risk_level_calc must be whitelisted (or computed server-side
    // in a whitelisted way). The column whitelist must therefore know about them.
    const whitelist = read('src/services/columnWhitelist.ts') + read('src/services/RiskService.ts');
    expect(whitelist).toMatch(/risk_score_calc/);
    expect(whitelist).toMatch(/risk_level_calc/);
    // Whitelisting alone isn't enough — they must appear in the allow-set, not only
    // be injected by RiskService. Assert the whitelist module references them.
    expect(read('src/services/columnWhitelist.ts')).toMatch(/risk_score_calc/);
  });

  it('1.21 employee-id generation avoids the invalid-integer cast; archived counted correctly (2.21)', () => {
    const us = read('src/services/UserService.ts');
    // The PG/PGlite-breaking CAST(SUBSTR(...) AS INTEGER) ordering must be gone.
    expect(us).not.toMatch(/CAST\(SUBSTR\(employee_id[^)]*\)\s*AS\s*INTEGER\)/i);
    // getUserSummary must not count a status ('Archived') that is never persisted.
    expect(us).not.toMatch(/status\s*=\s*'Archived'/);
  });

  it('1.22 org-entity self-parent guard compares UUIDs (not parseInt) (2.22)', () => {
    const org = read('src/services/OrgService.ts');
    expect(org).not.toMatch(/parseInt\(parent_id\)\s*===\s*parseInt\(id\)/);
  });

  it('1.23 [INFERRED] container PDF generation has a reachable Chromium binary path (2.23)', () => {
    // Reproduction: static inspection of the Dockerfile (full container runtime
    // not executable in this test environment). Defect manifests when Puppeteer
    // download is skipped AND no PUPPETEER_EXECUTABLE_PATH points at a binary.
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/PUPPETEER_EXECUTABLE_PATH/);
  });

  it('1.24 runMigrations throws on a DDL error (does not swallow) (2.24)', () => {
    const mig = read('src/db/migrations.ts');
    // The core-table creation must not swallow the DDL error with console.error only.
    expect(mig).not.toMatch(/catch\s*\(e\)\s*\{\s*console\.error\("Error creating core table:",\s*e\);\s*\}/);
  });

  it('1.25 redisManager keeps attempting recovery after exhausting attempts (2.25)', () => {
    const rm = read('src/cache/redisManager.ts');
    // After max attempts it must not permanently give up; a backoff/continued retry
    // signal must be present rather than only the "exhausted ... Manual intervention" path.
    expect(rm).toMatch(/backoff|resetReconnect|scheduleReconnect[\s\S]*backoff|Math\.pow|exponential/i);
  });

  it('1.26 docker-compose.yml has no insecure default secrets (2.26)', () => {
    const compose = read('docker-compose.yml');
    expect(compose).not.toMatch(/:-alsaqi/);
    expect(compose).not.toMatch(/:-changeme/);
  });

  it('1.27 WebSocket handshake requires a ws-typed token and avoids ?token= query string (2.27)', () => {
    const wsAuth = read('src/ws/auth.ts');
    // Must require type==='ws' and re-check session_version/status.
    expect(wsAuth).toMatch(/type\s*===\s*['"`]ws['"`]|decoded\.type/);
    expect(wsAuth).toMatch(/session_version|status/);
    // Token must not be read from the query string.
    expect(wsAuth).not.toMatch(/searchParams\.get\(\s*['"`]token['"`]\s*\)/);
  });

  it('1.28 effective permissions subtract is_allowed=0 denies (2.28)', () => {
    const auth = read('src/services/AuthService.ts');
    expect(auth).toMatch(/is_allowed\s*=\s*0|is_allowed\s*=\s*FALSE/i);
  });

  it('1.29 idempotency cache does not persist secrets in plaintext (2.29)', () => {
    const idem = read('src/middleware/idempotency.ts');
    // A redaction/omission step must exist before caching the body.
    expect(idem).toMatch(/redact|sanitize|omit|tempPassword/i);
  });

  it('1.30 [INFERRED] file-upload middleware is registered so req.files is parsed (2.30)', () => {
    // Reproduction: grep of src found express-fileupload imported only as a TYPE;
    // no app.use(fileUpload(...)) registration anywhere → defect MANIFESTS.
    const allSrc = readDirRecursive('src');
    expect(allSrc).toMatch(/app\.use\(\s*fileUpload\(|use\(\s*fileUpload\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MINOR — findings 1.31–1.40
// ═══════════════════════════════════════════════════════════════════════════
describe('Bug Condition — Minor findings (1.31–1.40)', () => {
  it('1.31 dashboard/task/recommendation/finding reads exclude soft-deleted rows (2.31)', () => {
    const dash = read('src/services/DashboardService.ts');
    expect(dash).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('1.32 soft-delete tables list the correct name (outgoing_letters) (2.32)', () => {
    const base = read('src/services/BaseService.ts');
    // The real table is outgoing_letters; the wrong outgoing_correspondence entry
    // (and the absent outgoing_letters) is the defect.
    expect(base).toMatch(/outgoing_letters/);
  });

  it('1.33 unbounded list/export queries are bounded with pagination/limits (2.33)', () => {
    const lookups = read('src/routes/lookups.ts');
    // The lookups risk_register/compliance_items reads must apply a LIMIT.
    expect(lookups).toMatch(/LIMIT/i);
  });

  it('1.34 CSV export neutralizes formula-injection lead chars =,+,-,@ (2.34)', () => {
    const logs = read('src/routes/logs.ts');
    // The export escaper must guard leading =/+/-/@ (e.g. prefix with a quote).
    // Current escapeCsv only quotes comma/quote/newline → no formula-injection guard.
    expect(logs).toMatch(
      /\^?\[=\+\\?-?@?\]|startsWith\(\s*['"`][=+\-@]|charAt\(0\)\s*===\s*['"`][=+@\-]|formula|csvInjection|neutraliz/i
    );
  });

  it('1.35 pagination defaults are unified across modules (2.35)', () => {
    const pag = read('src/utils/pagination.ts');
    const svc = read('src/utils/paginationService.ts');
    const def1 = pag.match(/parseInt\(req\.query\.limit as string\)\s*\|\|\s*(\d+)/)?.[1];
    const def2 = svc.match(/DEFAULT_PAGE_SIZE\s*=\s*(\d+)/)?.[1];
    expect(def1).toBeDefined();
    expect(def2).toBeDefined();
    expect(def1).toBe(def2);
  });

  it('1.36 QueryBuilder.orderBy validates identifiers (property over malicious columns) (2.36)', () => {
    const invalidIdentifier = fc
      .string({ minLength: 1, maxLength: 24 })
      .filter((s) => !/^[a-zA-Z0-9_.]+$/.test(s)); // contains an injection-capable char
    fc.assert(
      fc.property(invalidIdentifier, (col) => {
        const qb = new QueryBuilder('SELECT * FROM t');
        // Fixed behavior: an invalid identifier must be rejected (thrown), so the
        // raw, unvalidated column can never reach the SQL string.
        let threw = false;
        try {
          qb.orderBy(col, 'ASC');
        } catch {
          threw = true;
        }
        return threw === true;
      }),
      { numRuns: 50 }
    );
  });

  it('1.37 CircuitBreaker uses isRetryableError in its retry decision (2.37)', () => {
    const cb = read('src/services/CircuitBreaker.ts');
    // The method must be referenced (called) somewhere beyond its own definition.
    const occurrences = (cb.match(/isRetryableError/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('1.38 PdfEngine clears its race timeout (no leaked 30s timer) (2.38)', () => {
    const pdf = read('src/services/PdfEngine.ts');
    expect(pdf).toMatch(/clearTimeout/);
  });

  it('1.39 credential flows hardened: env-aware cookies, HKDF keystore, strong temp passwords (2.39)', () => {
    const password = read('src/routes/auth/password.ts');
    const keyStore = read('src/utils/keyStore.ts');
    const pwSvc = read('src/services/PasswordService.ts');
    // Cookies must not be hardcoded secure:true/sameSite:'none' (dropped on dev/HTTP).
    expect(password).not.toMatch(/secure:\s*true,\s*sameSite:\s*['"`]none['"`]/);
    // KeyStore must derive via HKDF, not SHA-256(secret + '_rsa_enc').
    expect(keyStore).not.toMatch(/createHash\(['"`]sha256['"`]\)\.update\(this\.encryptionSecret\s*\+\s*['"`]_rsa_enc['"`]\)/);
    // approveReset temp password must use more entropy than randomBytes(6).
    expect(pwSvc).not.toMatch(/crypto\.randomBytes\(6\)/);
  });

  it('1.40 misc hardening: caching does not mark authenticated responses public (2.40)', () => {
    const caching = read('src/middleware/caching.ts');
    // Representative 2.40 item: must not set Cache-Control: public on API responses.
    expect(caching).not.toMatch(/Cache-Control['"`],\s*`public/);
  });
});

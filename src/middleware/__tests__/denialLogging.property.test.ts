// @vitest-environment node
// Feature: backend-security-hardening, Property 22: Exactly one categorized denial log entry per denied request
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Property Test: Exactly one categorized denial log entry per denied request (Property 22)
 *
 * **Validates: Requirements 13.2**
 *
 * For any denied file request, the secure-file middleware emits EXACTLY ONE denial
 * log entry. That entry carries the requested file identifier and a denial-category
 * reason drawn from {authentication failure, expired signed URL, missing module
 * permission, no valid owning module}. When the denial stems from an unauthenticated
 * request (no user/signer established), the recorded user identifier is the fixed
 * anonymous placeholder (Req 13.3). Granted requests produce no denial entry.
 *
 * Observability: the middleware funnels every denial through a single
 * `logFileAccess(userId, filePath, 'view', 'denied', ip, category)` call fired once
 * from the `res.on('finish')` listener. `logFileAccess` is module-internal, so we
 * observe its arguments via its resilient-failure path (Req 13.4): we make the audit
 * INSERT reject, which causes `logFileAccess` to write a single notice to stderr
 * containing `userId=...`, `filePath=...`, `result=denied`, and `reason=<category>`.
 * Each denial therefore surfaces as exactly one stderr notice carrying the full,
 * categorized denial payload, which is precisely what Property 22 constrains.
 */

// Dedicated file-access secret consumed by SecureFileService at verify time.
const FILE_ACCESS_SECRET = 'unit-test-file-access-secret-0123456789abcdef';
process.env.FILE_ACCESS_SECRET = FILE_ACCESS_SECRET;

// Per-iteration state shared with the mocked db / permission modules.
const hoisted = vi.hoisted(() => ({
  fileModule: undefined as string | undefined, // owning module returned by encrypted_files
  hasPermission: false, // PermissionService.hasPermission result
}));

// Mock the database. Reads are routed by SQL text; the audit INSERT always rejects
// so logFileAccess exercises its resilient stderr notice (carrying the category).
vi.mock('../../db/index', () => ({
  default: {
    prepare: (sql: string) => ({
      get: async () => {
        if (/SELECT\s+module\s+FROM\s+encrypted_files/i.test(sql)) {
          return hoisted.fileModule === undefined ? undefined : { module: hoisted.fileModule };
        }
        if (/FROM\s+users/i.test(sql)) return undefined;
        // lookupEncryptedFile (original_name, ...) => file is not encrypted.
        return undefined;
      },
      all: async () => [],
      run: async () => {
        throw new Error('audit-write-unavailable');
      },
    }),
  },
}));

// Drive the current permission decision per iteration.
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn().mockResolvedValue(false),
  },
}));

// The owning module (when present) is registered and file-scoped, so the decision
// is delegated to PermissionService.
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn().mockReturnValue({ name: 'AuditPlans', fileScope: true, actions: ['View'] }),
  },
}));

// Quiet, side-effect-free logger.
vi.mock('../../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createSecureFileMiddleware } from '../secureFile';
import { PermissionService } from '../../services/PermissionService';

const FILE_PATH = 'secure-test-file.txt';
const ANONYMOUS_USER_ID = 'anonymous';

// All denial categories enumerated by Property 22 / Req 13.2.
const CATEGORIES = [
  'authentication failure',
  'expired signed URL',
  'missing module permission',
  'no valid owning module',
] as const;

// A denial notice parsed out of stderr.
interface DenialNotice {
  userId: string;
  filePath: string;
  reason: string;
}

// Parse the resilient-failure notice emitted by logFileAccess for denied results.
// Format: "...\n  userId=<id>, filePath=<path>, result=denied, reason=<category>\n"
function parseDenialNotices(writes: string[]): DenialNotice[] {
  const notices: DenialNotice[] = [];
  for (const chunk of writes) {
    const m = chunk.match(
      /userId=(.*?), filePath=(.*?), result=denied(?:, reason=(.*?))?\n/
    );
    if (m) {
      notices.push({ userId: m[1], filePath: m[2], reason: (m[3] ?? '').trim() });
    }
  }
  return notices;
}

describe('Feature: backend-security-hardening, Property 22: Exactly one categorized denial log entry per denied request', () => {
  let uploadDir: string;
  let middleware: ReturnType<typeof createSecureFileMiddleware>;
  let authUser: { id: string; role: string } | null = null;
  let stderrWrites: string[];

  beforeAll(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denialLog-prop-'));
    fs.writeFileSync(path.join(uploadDir, FILE_PATH), 'plain-content');

    // authenticate populates req.user only when the iteration models an
    // authenticated principal; otherwise it calls next() with no user (silent auth
    // failure), so the middleware denies with 401 + anonymous placeholder.
    const authenticate = (req: any, _res: any, next: any) => {
      if (authUser) req.user = authUser;
      next();
    };
    middleware = createSecureFileMiddleware(authenticate, uploadDir, {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  // Build a fake req/res. The res emits 'finish' synchronously once the response is
  // finalized; `done` resolves at that point.
  function invoke(query: Record<string, string>) {
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const listeners: Record<string, Array<(...a: any[]) => void>> = {};
    const res: any = {
      statusCode: 200,
      served: false,
      finished: false,
      headersSent: false,
      writableFinished: false,
      on(event: string, cb: (...a: any[]) => void) {
        (listeners[event] ??= []).push(cb);
        return this;
      },
      removeListener(event: string, cb: (...a: any[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
        return this;
      },
      emit(event: string, ...args: any[]) {
        (listeners[event] ?? []).forEach((f) => f(...args));
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        this.finished = true;
        this.writableFinished = true;
        this.emit('finish');
        resolveDone();
        return this;
      },
      send(payload: unknown) {
        this.body = payload;
        this.served = true;
        this.finished = true;
        this.writableFinished = true;
        this.emit('finish');
        resolveDone();
        return this;
      },
      sendFile(p: string) {
        this.body = p;
        this.served = true;
        this.finished = true;
        this.writableFinished = true;
        this.emit('finish');
        resolveDone();
        return this;
      },
    };
    const req: any = {
      path: FILE_PATH,
      query,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };
    middleware(req, res, () => {});
    return { res, done };
  }

  // Flush microtasks so the void logFileAccess(...) call from the finish listener
  // (and granted inline logging) completes before assertions.
  const flush = () => new Promise<void>((r) => setImmediate(r));

  type Scenario =
    | 'unauth-no-signature'
    | 'expired-signature'
    | 'auth-missing-permission'
    | 'auth-no-owning-module'
    | 'granted';

  const scenarioArb = fc.constantFrom<Scenario>(
    'unauth-no-signature',
    'expired-signature',
    'auth-missing-permission',
    'auth-no-owning-module',
    'granted'
  );

  it('records exactly one categorized denial entry per denied request and none for granted requests', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.uuid(), async (scenario, principalId) => {
        // Reset per-iteration knobs.
        authUser = null;
        hoisted.fileModule = undefined;
        hoisted.hasPermission = false;
        (PermissionService.hasPermission as any).mockResolvedValue(false);
        stderrWrites = [];

        let query: Record<string, string> = {};
        let expectedDenied: boolean;
        let expectedCategory: (typeof CATEGORIES)[number] | null = null;
        let expectedUserId = ANONYMOUS_USER_ID;

        switch (scenario) {
          case 'unauth-no-signature':
            // No signature, authenticate establishes no user -> 401 auth failure.
            authUser = null;
            expectedDenied = true;
            expectedCategory = 'authentication failure';
            expectedUserId = ANONYMOUS_USER_ID;
            break;
          case 'expired-signature':
            // Past-expiry signed URL -> 401 expired signed URL, claimed signer id.
            query = {
              expires: String(Math.floor(Date.now() / 1000) - 60),
              userId: principalId,
              sig: 'deadbeef',
            };
            expectedDenied = true;
            expectedCategory = 'expired signed URL';
            expectedUserId = principalId;
            break;
          case 'auth-missing-permission':
            // Authenticated user, owning module present but permission denied.
            authUser = { id: principalId, role: 'Auditor' };
            hoisted.fileModule = 'AuditPlans';
            (PermissionService.hasPermission as any).mockResolvedValue(false);
            expectedDenied = true;
            expectedCategory = 'missing module permission';
            expectedUserId = principalId;
            break;
          case 'auth-no-owning-module':
            // Authenticated user, file has no owning module.
            authUser = { id: principalId, role: 'Auditor' };
            hoisted.fileModule = undefined;
            expectedDenied = true;
            expectedCategory = 'no valid owning module';
            expectedUserId = principalId;
            break;
          case 'granted':
          default:
            // Authenticated user with a registered, file-scoped module and permission.
            authUser = { id: principalId, role: 'Auditor' };
            hoisted.fileModule = 'AuditPlans';
            (PermissionService.hasPermission as any).mockResolvedValue(true);
            expectedDenied = false;
            break;
        }

        const { res, done } = invoke(query);
        await done;
        await flush();

        const denials = parseDenialNotices(stderrWrites);

        if (expectedDenied) {
          // Exactly one categorized denial entry.
          expect(denials).toHaveLength(1);
          const entry = denials[0];
          // Carries the requested file identifier.
          expect(entry.filePath).toBe(FILE_PATH);
          // Carries a category drawn from the enumerated denial categories...
          expect(CATEGORIES).toContain(entry.reason as any);
          // ...and specifically the correct category for this denial.
          expect(entry.reason).toBe(expectedCategory);
          // Anonymous placeholder when unauthenticated; claimed/known id otherwise.
          expect(entry.userId).toBe(expectedUserId);
          // The response was a denial status (>= 400).
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
        } else {
          // Granted request: served, default 200, and no denial entry recorded.
          expect(res.served).toBe(true);
          expect(res.statusCode).toBeLessThan(400);
          expect(denials).toHaveLength(0);
        }
      }),
      { numRuns: 150 }
    );
  });
});

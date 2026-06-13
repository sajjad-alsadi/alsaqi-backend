// @vitest-environment node
// Feature: backend-security-hardening, Property 21: Signed-URL serving re-checks current signer standing
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Property Test: Signed-URL serving re-checks current signer standing (Property 21)
 *
 * **Validates: Requirements 11.1, 11.2, 11.3**
 *
 * For a valid, unexpired signature, the secure-file middleware serves the file
 * content IF AND ONLY IF the signer is currently active (status === 'Active')
 * AND currently holds the required permission. It denies (without serving any
 * content) when the signer is inactive/suspended/missing, when the signer lacks
 * the current permission, or when the signature is expired/invalid — even while
 * the signature itself is cryptographically valid and unexpired.
 *
 * served  ⇔  signature(valid & unexpired)  ∧  signer Active  ∧  permission granted
 */

// The dedicated file-access secret used by SecureFileService.verifySignedUrl
// (read from process.env at signature-compute time). We sign with the same
// value so cryptographically valid signatures verify.
const FILE_ACCESS_SECRET = 'unit-test-file-access-secret-0123456789abcdef';
process.env.FILE_ACCESS_SECRET = FILE_ACCESS_SECRET;

// Mutable state shared with the mocked db module (set per iteration).
const hoisted = vi.hoisted(() => ({
  signerRow: undefined as undefined | { id: string; role: string; status: string },
  moduleName: 'AuditPlans',
}));

// Mock the database. The middleware issues three kinds of reads:
//  - SELECT id, role, status FROM users   -> signer standing (or undefined => missing)
//  - SELECT module FROM encrypted_files    -> owning module for permission check
//  - SELECT ...original_name... FROM encrypted_files -> encryption metadata (none here)
// plus INSERT into file_access_logs (audit). All routed by SQL text.
vi.mock('../../db/index', () => ({
  default: {
    prepare: (sql: string) => ({
      get: async () => {
        if (/FROM\s+users/i.test(sql)) return hoisted.signerRow;
        if (/SELECT\s+module\s+FROM\s+encrypted_files/i.test(sql)) {
          return { module: hoisted.moduleName };
        }
        // lookupEncryptedFile (selects original_name, ...) => not encrypted
        return undefined;
      },
      all: async () => [],
      run: async () => ({ lastInsertRowid: 0, changes: 1 }),
    }),
  },
}));

// Mock the permission service so we can drive granted/denied per iteration.
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: vi.fn().mockResolvedValue(true),
  },
}));

// Mock the module registry: the file's owning module is registered and supports
// file scoping, so the permission decision is delegated to PermissionService.
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
import { ModuleRegistry } from '../../permissions/registry';

// The request path (relative, no leading slash so it resolves inside uploadDir).
const FILE_PATH = 'secure-test-file.txt';

// Compute an HMAC-SHA256 signature identical to SecureFileService.computeSignature.
function computeSig(filePath: string, userId: string, expires: number): string {
  const payload = `${filePath}:${userId}:${expires}`;
  return crypto.createHmac('sha256', FILE_ACCESS_SECRET).update(payload).digest('hex');
}

// Corrupt a hex signature into a different, equal-length, hex-valid value.
function corruptSig(sig: string): string {
  const first = sig[0] === '0' ? '1' : '0';
  return first + sig.slice(1);
}

describe('Feature: backend-security-hardening, Property 21: Signed-URL serving re-checks current signer standing', () => {
  let uploadDir: string;
  let middleware: ReturnType<typeof createSecureFileMiddleware>;

  beforeAll(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureFile-prop-'));
    fs.writeFileSync(path.join(uploadDir, FILE_PATH), 'decrypted-content');

    // Authenticate stub: when an INVALID signature falls through to the normal
    // auth flow it calls next() without populating req.user, so the middleware
    // denies with 401 (i.e. the request is NOT served).
    const authenticate = (_req: any, _res: any, next: any) => next();
    middleware = createSecureFileMiddleware(authenticate, uploadDir, {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (ModuleRegistry.getModule as any).mockReturnValue({
      name: 'AuditPlans',
      fileScope: true,
      actions: ['View'],
    });
  });

  // Invoke the middleware with a hand-built req/res and resolve when the
  // response is finalized (json/send/sendFile).
  function invoke(query: Record<string, string>) {
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const res: any = {
      statusCode: 200,
      served: false,
      finished: false,
      body: undefined as unknown,
      headers: {} as Record<string, unknown>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        this.finished = true;
        resolveDone();
        return this;
      },
      send(payload: unknown) {
        this.body = payload;
        this.served = true;
        this.finished = true;
        resolveDone();
        return this;
      },
      sendFile(p: string) {
        this.body = p;
        this.served = true;
        this.finished = true;
        resolveDone();
        return this;
      },
      setHeader(k: string, v: unknown) {
        this.headers[k] = v;
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

  const validityArb = fc.constantFrom<'valid' | 'expired' | 'invalid'>('valid', 'expired', 'invalid');
  const statusArb = fc.constantFrom('Active', 'Suspended', 'Inactive', 'missing');
  // Non-admin roles so the permission decision is governed by PermissionService
  // (Admins bypass the permission check entirely).
  const roleArb = fc.constantFrom('Auditor', 'Manager', 'Viewer', 'User');

  it('serves IFF signature valid+unexpired AND signer Active AND permission granted', async () => {
    await fc.assert(
      fc.asyncProperty(
        validityArb,
        statusArb,
        fc.boolean(),
        roleArb,
        fc.uuid(),
        async (validity, status, permissionGranted, role, userId) => {
          // Arrange current signer standing + current permission.
          hoisted.signerRow =
            status === 'missing' ? undefined : { id: userId, role, status };
          (PermissionService.hasPermission as any).mockResolvedValue(permissionGranted);

          // Build the signature according to the validity scenario.
          const now = Math.floor(Date.now() / 1000);
          let expires: number;
          let sig: string;
          if (validity === 'expired') {
            expires = now - 60;
            sig = computeSig(FILE_PATH, userId, expires);
          } else {
            expires = now + 600;
            sig = computeSig(FILE_PATH, userId, expires);
            if (validity === 'invalid') sig = corruptSig(sig);
          }

          const { res, done } = invoke({ expires: String(expires), userId, sig });
          await done;

          const sigOk = validity === 'valid';
          const expectedServed = sigOk && status === 'Active' && permissionGranted === true;

          expect(res.served).toBe(expectedServed);
          if (expectedServed) {
            // Served: file content streamed, default 200 status.
            expect(res.statusCode).toBe(200);
          } else {
            // Denied without serving content: expired/invalid -> 401,
            // inactive/missing signer or missing permission -> 403.
            expect([401, 403]).toContain(res.statusCode);
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});

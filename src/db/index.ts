import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { AsyncLocalStorage } from "async_hooks";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createSSLConfig, validateSSLConnection } from "./sslConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize variables, but don't create the client immediately to avoid blocking startup
let client: any = null;
let isExternal = false;

const DATABASE_URL = process.env.DATABASE_URL;

export function getPersistentDataDir(): string {
  // Always use /tmp to avoid filesystem permission issues in Cloud Run
  // and to avoid dev server file-watcher crash loops.
  let dataDir = path.resolve('/tmp', 'audit_db_persistent_v2');
  
  const ensureDir = (dir: string): boolean => {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const testFile = path.join(dir, '.write-test-' + Date.now());
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
      return true;
    } catch (e) {
      return false;
    }
  };

  if (!ensureDir(dataDir)) {
    dataDir = path.resolve('/tmp', 'audit_db_fallback_' + Date.now());
    ensureDir(dataDir);
  }
  
  return dataDir;
}

function createPgliteClient(isRetry = false) {
  const dataDir = getPersistentDataDir();
  
  const cleanupStaleFiles = (dir: string) => {
    const staleFiles = ["postmaster.pid", "postmaster.opts", "pglite.lock", "PG_VERSION.lock"];
    for (const file of staleFiles) {
      const filePath = path.join(dir, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.chmodSync(filePath, 0o666);
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
    }
  };

  try {
    if (isRetry && fs.existsSync(dataDir)) {
      console.log(`[DB] Retry requested. Backing up existing directory at ${dataDir}`);
      const backupDir = `${dataDir}_retry_backup_${Date.now()}`;
      try {
        fs.renameSync(dataDir, backupDir);
      } catch (e) {
        console.error("[DB] Backup failed, trying to at least clean stale files:", e);
        cleanupStaleFiles(dataDir);
      }
    } else if (fs.existsSync(dataDir)) {
      // Normal cleanup of root dir if it's not a directory
      try {
        const stats = fs.statSync(dataDir);
        if (!stats.isDirectory()) {
           const backupFile = `${dataDir}_file_backup_${Date.now()}`;
           fs.renameSync(dataDir, backupFile);
        }
      } catch (e) {}
      cleanupStaleFiles(dataDir);
    }

    console.log(`[DB] Initializing PGlite at ${dataDir}`);
    const client = new PGlite(dataDir);
    
    // Wire up terminal error detection
    client.waitReady.catch((err: any) => {
      const msg = String(err.message || "");
      if (msg.includes("failed to initialize properly") || msg.includes("ExitStatus")) {
        console.error("[DB] CRITICAL: PGlite terminal initialization failure detected.");
      }
    });

    return client;
  } catch (err) {
    console.error("[DB] Immediate PGlite creation failure:", err);
    return new PGlite();
  }
}

if (DATABASE_URL && !DATABASE_URL.startsWith('http')) {
  // Build SSL config based on environment
  const sslConfig = createSSLConfig(process.env);
  const isLocal = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1') || DATABASE_URL.includes('0.0.0.0');

  // Determine SSL option: production uses createSSLConfig, local dev disables SSL
  let sslOption: pg.PoolConfig['ssl'];
  if (sslConfig) {
    sslOption = sslConfig.ssl;
  } else if (isLocal) {
    sslOption = false;
  } else {
    // Non-production, non-local: use permissive SSL (don't reject unauthorized)
    sslOption = { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
  }

  client = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: sslOption,
    connectionTimeoutMillis: 2000,
    max: 20,
    idleTimeoutMillis: 30000,
  });
  isExternal = true;
} else {
  // We'll initialize PGlite lazily
  isExternal = false;
}

const als = new AsyncLocalStorage<any>();

/**
 * ReadWriteLock for PGlite mode.
 * 
 * PGlite (WASM-based) does not support truly concurrent queries, but it CAN
 * handle multiple SELECT queries sequentially without corruption risk.
 * This lock allows concurrent read operations (shared lock) while ensuring
 * write operations (exclusive lock) block all other operations.
 * 
 * In production with PostgreSQL, the lock is bypassed entirely (see isExternal checks).
 * 
 * Behavior:
 * - Multiple readers can hold the lock simultaneously
 * - A writer must wait for all readers to finish, then blocks all new readers/writers
 * - Queued requests wait up to LOCK_TIMEOUT_MS (5000ms) before receiving a 503
 * - Writers are prioritized: when a writer is waiting, new readers queue behind it
 */
export class ReadWriteLock {
  private _readers = 0;
  private _writing = false;
  private _writeQueue: Array<{ resolve: (release: (() => void) | PromiseLike<() => void>) => void; reject: (err: Error) => void }> = [];
  private _readQueue: Array<{ resolve: (release: (() => void) | PromiseLike<() => void>) => void; reject: (err: Error) => void }> = [];

  static readonly LOCK_TIMEOUT_MS = 5000;

  get readers() { return this._readers; }
  get writing() { return this._writing; }
  get writeQueueLength() { return this._writeQueue.length; }
  get readQueueLength() { return this._readQueue.length; }

  async acquireRead(): Promise<() => void> {
    // If already inside a transaction context (ALS store set), skip locking
    if (als.getStore()) {
      return () => {};
    }

    // If no writer is active and no writer is waiting, grant read immediately
    if (!this._writing && this._writeQueue.length === 0) {
      this._readers++;
      return () => this._releaseRead();
    }

    // Otherwise, queue the read request and wait
    return this._enqueueWithTimeout(this._readQueue, 'read');
  }

  async acquireWrite(): Promise<() => void> {
    // If already inside a transaction context (ALS store set), skip locking
    if (als.getStore()) {
      return () => {};
    }

    // If no readers and no writer, grant write immediately
    if (!this._writing && this._readers === 0) {
      this._writing = true;
      return () => this._releaseWrite();
    }

    // Otherwise, queue the write request and wait
    return this._enqueueWithTimeout(this._writeQueue, 'write');
  }

  private _enqueueWithTimeout(
    queue: Array<{ resolve: (release: (() => void) | PromiseLike<() => void>) => void; reject: (err: Error) => void }>,
    type: 'read' | 'write'
  ): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const entry = { resolve, reject };
      queue.push(entry);

      const timer = setTimeout(() => {
        // Remove from queue if still waiting
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
          const error = new Error(
            `Lock acquisition timeout: could not acquire ${type} lock within ${ReadWriteLock.LOCK_TIMEOUT_MS}ms`
          );
          (error as any).statusCode = 503;
          reject(error);
        }
      }, ReadWriteLock.LOCK_TIMEOUT_MS);

      // Wrap the resolve to clear the timeout
      const originalResolve = entry.resolve;
      entry.resolve = (release) => {
        clearTimeout(timer);
        originalResolve(release);
      };
    });
  }

  private _releaseRead(): void {
    this._readers--;
    this._processQueue();
  }

  private _releaseWrite(): void {
    this._writing = false;
    this._processQueue();
  }

  private _processQueue(): void {
    // Priority: if there's a writer waiting and no readers, grant write
    if (this._writeQueue.length > 0 && this._readers === 0 && !this._writing) {
      this._writing = true;
      const next = this._writeQueue.shift()!;
      next.resolve(() => this._releaseWrite());
      return;
    }

    // If no writer is active/waiting, drain all queued readers
    if (!this._writing && this._writeQueue.length === 0 && this._readQueue.length > 0) {
      while (this._readQueue.length > 0) {
        this._readers++;
        const next = this._readQueue.shift()!;
        next.resolve(() => this._releaseRead());
      }
    }
  }
}

const dbLock = new ReadWriteLock();

/**
 * Determines if a SQL statement is a read (SELECT) or write (INSERT, UPDATE, DELETE, etc.) operation.
 */
export function isReadQuery(sql: string): boolean {
  const trimmed = sql.trimStart().toUpperCase();
  // SELECT, EXPLAIN, SHOW, and WITH ... SELECT are read operations
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('EXPLAIN') || trimmed.startsWith('SHOW')) {
    return true;
  }
  // WITH (CTE) that ends in SELECT is a read
  if (trimmed.startsWith('WITH')) {
    // Check if it's a CTE followed by SELECT (not INSERT/UPDATE/DELETE)
    // Simple heuristic: if it doesn't contain INSERT/UPDATE/DELETE after the CTE
    const hasWrite = /\)\s*(INSERT|UPDATE|DELETE)/i.test(sql);
    return !hasWrite;
  }
  return false;
}

/** Public interface for the database wrapper */
export interface IDBWrapper {
  readonly client: any;
  readonly isExternal: boolean;
  validateIdentifier(id: string): string;
  prepare(sql: string): {
    get(...params: any[]): Promise<any>;
    all(...params: any[]): Promise<any[]>;
    run(...params: any[]): Promise<{ lastInsertRowid: number; changes: number }>;
  };
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  exec(sql: string): Promise<void>;
  updateClient(client: any, isExternal: boolean): void;
}

export class DBWrapper {
  private _client: any;
  private _isExternal: boolean;
  private _isReconnecting = false;
  private _reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

  constructor(client: any, isExternal: boolean) {
    this._client = client;
    this._isExternal = isExternal;
  }

  updateClient(client: any, isExternal: boolean) {
    this._client = client;
    this._isExternal = isExternal;
    this._reconnectAttempts = 0;
  }

  get client() { 
    if (!this._client && !this._isExternal) {
      this._client = createPgliteClient();
    }
    return this._client; 
  }

  get isExternal() { return this._isExternal; }

  validateIdentifier(id: string) {
    if (!/^[a-zA-Z0-9_]+$/.test(id)) {
      throw new Error(`Invalid database identifier: ${id}`);
    }
    return id;
  }

  private async ensureReady() {
    if (this._isExternal) return;
    
    // Ensure client exists (lazy init)
    if (!this._client) {
      this._client = createPgliteClient();
    }
    
    const checkError = (err: any) => {
      if (!err) return false;
      
      const errStr = String(err.message || "").toLowerCase();
      const errName = String(err.name || "").toLowerCase();
      
      // Look for specific PostgreSQL/PGlite error signatures or IO errors 
      const errorCode = err.code || err.errno;
      const isNetworkOrIo = ['EIO', 'EPERM', 'EBUSY', 'ECONNREFUSED'].includes(errorCode) || errorCode === 20;
      const isPgFail = err.name === 'PgError' || (typeof err.status === 'number' && err.status !== 200);
      
      const isWasmCrash = errStr.includes('exit status') || 
                         errStr.includes('abort(') || 
                         errStr.includes('failed to initialize properly') ||
                         errStr.includes('closed') ||
                         errStr.includes('errno: 20') ||
                         errName.includes('exitstatus') ||
                         errName.includes('errnoerror');
      
      return isNetworkOrIo || isPgFail || isWasmCrash;
    };

    try {
      if (this._client.waitReady) {
        await this._client.waitReady;
      }
      this._reconnectAttempts = 0; // Reset on success
    } catch (err: any) {
      if (checkError(err)) {
        console.error(`[DB] PGlite engine issue detected: ${err.message}. Attempt ${this._reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS}...`);
        
        if (this._reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
          console.error("[DB] Circuit breaker triggered. Too many restart attempts. Falling back to in-memory...");
          if (!this._isReconnecting) {
            this._isReconnecting = true;
            this._client = new PGlite();
            await this._client.waitReady;
            this._isReconnecting = false;
          }
          return;
        }

        if (!this._isReconnecting) {
          this._isReconnecting = true;
          this._reconnectAttempts++;
          try {
            // Try to close old client if possible
            try { await this._client.close(); } catch (e) {}
            
            this._client = createPgliteClient(true);
            await this._client.waitReady;
            console.log("[DB] PGlite engine restarted successfully.");
          } catch (reconnectErr) {
            console.error("[DB] Failed to restart PGlite engine:", reconnectErr);
          } finally {
            this._isReconnecting = false;
          }
        }
      } else {
        throw err;
      }
    }
  }

  prepare(sql: string) {
    let counter = 1;
    const pgSql = sql.replace(/\?/g, () => `$${counter++}`);
    
    const convertedSql = pgSql
      .replace(/\(user, action, module, details\)/gi, '("user", action, module, details)')
      .replace(/id, user, action, module/gi, 'id, "user", action, module');
      
    const executeWithRetry = async (operation: (conn: any) => Promise<any>, retryCount = 0): Promise<any> => {
      const connection = als.getStore() || this.client;
      try {
        return await operation(connection);
      } catch (error: any) {
        const errStr = error?.message || String(error) || "";
        const errName = error?.name || (error?.constructor ? error.constructor.name : "") || "";
        const hasErrno = typeof error === 'object' && error !== null && 'errno' in error;
        const isExitStatus = errStr.includes('ExitStatus') || errName.includes('ExitStatus') || (typeof error === 'object' && error !== null && 'status' in error) || hasErrno;

        if (isExitStatus && !this._isExternal && retryCount < 2) {
          console.warn(`[DB] Query failed with engine or filesystem error. Retrying (attempt ${retryCount + 1})...`);
          await this.ensureReady(); // This will trigger restart
          return await executeWithRetry(operation, retryCount + 1);
        }
        throw error;
      }
    };

    return {
      get: async (...params: any[]) => {
        const unlock = this.isExternal ? () => {} : await dbLock.acquireRead();
        try {
          await this.ensureReady();
          const res = await executeWithRetry(conn => conn.query(convertedSql, params));
          return res.rows ? res.rows[0] : undefined;
        } catch (error) {
          console.error(`[DB ERROR] GET: ${convertedSql}`, error);
          throw error;
        } finally {
          unlock();
        }
      },
      all: async (...params: any[]) => {
        const unlock = this.isExternal ? () => {} : await dbLock.acquireRead();
        try {
          await this.ensureReady();
          const res = await executeWithRetry(conn => conn.query(convertedSql, params));
          return res.rows || [];
        } catch (error) {
          console.error(`[DB ERROR] ALL: ${convertedSql}`, error);
          throw error;
        } finally {
          unlock();
        }
      },
      run: async (...params: any[]) => {
        const unlock = this.isExternal ? () => {} : await dbLock.acquireWrite();
        try {
          await this.ensureReady();
          let finalSql = convertedSql;
          if (finalSql.trim().toUpperCase().startsWith('INSERT')) {
              if (!finalSql.toUpperCase().includes('RETURNING')) {
                  finalSql += ' RETURNING *';
              }
              try {
                  const res = await executeWithRetry(conn => conn.query(finalSql, params));
                  return { 
                    lastInsertRowid: (res.rows && res.rows[0] as any)?.id || 0, 
                    changes: res.rowCount || 0 
                  };
              } catch (e: any) {
                  console.error(`[DB ERROR] RUN (INSERT): ${finalSql}`, e);
                  throw e;
              }
          } else {
              const res = await executeWithRetry(conn => conn.query(finalSql, params));
              return { lastInsertRowid: 0, changes: res.rowCount || 0 };
          }
        } catch (error) {
          if (!(error as any).message?.includes('does not exist')) {
            console.error(`[DB ERROR] RUN: ${convertedSql}`, error);
          }
          throw error;
        } finally {
          unlock();
        }
      }
    };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const unlock = this.isExternal ? () => {} : await dbLock.acquireWrite();
      try {
        await this.ensureReady();
          
        let connection = this.client;
        let needsRelease = false;
        
        if (this.isExternal) {
          connection = await this.client.connect();
          needsRelease = true;
        }

        const executeWithRetry = async (sql: string, retryCount = 0): Promise<any> => {
          try {
            return await connection.query(sql);
          } catch (error: any) {
            const errStr = error?.message || String(error) || "";
            const errName = error?.name || (error?.constructor ? error.constructor.name : "") || "";
            const hasErrno = typeof error === 'object' && error !== null && 'errno' in error;
            const isExitStatus = errStr.includes('ExitStatus') || errName.includes('ExitStatus') || (typeof error === 'object' && error !== null && 'status' in error) || hasErrno;

            if (isExitStatus && !this._isExternal && retryCount < 2) {
              console.warn(`[DB] Transaction command (${sql}) failed with engine or filesystem error. Retrying...`);
              await this.ensureReady();
              // Update connection if it was restarted
              if (!this._isExternal) connection = this.client;
              return await executeWithRetry(sql, retryCount + 1);
            }
            throw error;
          }
        };

        return await als.run(connection, async () => {
          try {
            await executeWithRetry('BEGIN');
            const result = await fn();
            await executeWithRetry('COMMIT');
            return result;
          } catch (e) {
            try { await executeWithRetry('ROLLBACK'); } catch (rollbackErr) {}
            throw e;
          } finally {
            if (needsRelease) connection.release();
          }
        });
      } finally {
        unlock();
      }
  }

  async exec(sql: string) {
    const isRead = isReadQuery(sql);
    const unlock = this.isExternal ? () => {} : (isRead ? await dbLock.acquireRead() : await dbLock.acquireWrite());
    try {
      await this.ensureReady();
      
      const executeWithRetry = async (retryCount = 0): Promise<void> => {
        const connection = als.getStore() || this.client;
        try {
          await connection.query(sql);
        } catch (error: any) {
          const errStr = error?.message || String(error) || "";
          const errName = error?.name || (error?.constructor ? error.constructor.name : "") || "";
          const hasErrno = typeof error === 'object' && error !== null && 'errno' in error;
          const isExitStatus = errStr.includes('ExitStatus') || errName.includes('ExitStatus') || (typeof error === 'object' && error !== null && 'status' in error) || hasErrno;

          if (isExitStatus && !this._isExternal && retryCount < 2) {
            console.warn(`[DB] Exec failed with engine or filesystem error. Retrying (attempt ${retryCount + 1})...`);
            await this.ensureReady();
            return await executeWithRetry(retryCount + 1);
          }
          throw error;
        }
      };

      await executeWithRetry();
    } catch (error) {
      console.error(`[DB ERROR] EXEC: ${sql.substring(0, 100)}...`, error);
      throw error;
    } finally {
      unlock();
    }
  }
}

export const db: IDBWrapper = new DBWrapper(client, isExternal);

export const initDb = async () => {
  if (DATABASE_URL && isExternal) {
    try {
      // In production, validate SSL connection — refuse to start if it fails
      if (process.env.NODE_ENV === 'production') {
        try {
          await validateSSLConnection(client);
          console.log("[DB] Production SSL connection validated successfully.");
        } catch (sslErr: any) {
          console.error(`[DB] FATAL: ${sslErr.message}`);
          process.exit(1);
        }
      } else {
        await client.query('SELECT 1');
      }
    } catch (err: any) {
      console.error("[DB] External PostgreSQL connection failed. Falling back to PGlite.", err.message);
      const pgliteClient = createPgliteClient();
      db.updateClient(pgliteClient, false);
    }
  } else if (!isExternal) {
    try {
      if (db.client.waitReady) {
        await db.client.waitReady;
      }
    } catch (err: any) {
      console.error("[DB] PGlite initialization failed:", err);
    }
  }
};

export default db;

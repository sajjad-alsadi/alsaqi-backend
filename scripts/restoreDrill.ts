/**
 * Restore_Drill — المنطقة (ي) في التصميم + نموذج البيانات `RestoreDrillLog`
 * (المتطلبات 3.5، 3.6، 3.8)
 *
 * يستعيد نسخة احتياطية إنتاجية **مشفّرة** إلى قاعدة بيانات هدف **نظيفة ومنفصلة**،
 * ثم يقارن أعداد صفوف مجموعة محدّدة مسبقاً وموثّقة من الجداول الحرجة بين الهدف
 * المُستعاد والأعداد المتوقّعة المسجّلة وقت إنشاء النسخة، ويُنتِج `RestoreDrillLog`
 * يسجّل `restoreId`/`backupId`/التاريخ/الهدف/النتيجة و`verifiedRestorable`.
 *
 * قاعدة الصحّة (Req 3.8):
 *   verifiedRestorable === true ⇔ result === 'verified' وكل جدول حرج expected === actual.
 *   عند فشل الاستعادة أو اختلاف أي عدد ⇒ result === 'failed' و verifiedRestorable === false.
 *
 * البنية: يُفصَل المنطق الحتمي النقي (المقارنة وبناء السجلّ — قابل لاختبار الوحدة
 * دون أثر جانبي) عن خطوات الاستعادة ذات الأثر (فكّ التشفير، فكّ الأرشيف، التحميل
 * إلى الهدف النظيف، عدّ الصفوف). الجزء النقي لا يقرأ ملفات ولا يتصل بقاعدة بيانات.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import type { RestoreDrillLog } from '../src/launch/types.js';

// ---------------------------------------------------------------------------
// مجموعة الجداول الحرجة المحدّدة مسبقاً والموثّقة (Req 3.5)
// ---------------------------------------------------------------------------

/**
 * مجموعة الجداول الحرجة الموثّقة التي يقارن Restore_Drill أعداد صفوفها بين النسخة
 * المصدر (الأعداد المتوقّعة) والهدف المُستعاد (الأعداد الفعلية).
 *
 * هذه المجموعة هي نفسها المجموعة الحرجة التي يصدّرها/يحتفظ بها `Backup_Service`
 * (انظر `src/utils/backup.ts`)، فيبقى نطاق التحقّق متّسقاً مع نطاق النسخ الاحتياطي.
 * أي تعديل هنا يجب أن يواكب تعديل قائمة الجداول في النسخ الاحتياطي.
 */
export const CRITICAL_TABLES: readonly string[] = [
  'users',
  'audit_programs',
  'audit_plans',
  'audit_tasks',
  'audit_findings',
  'recommendations',
  'risk_register',
  'incoming_correspondence',
  'outgoing_correspondence',
  'notifications',
] as const;

// ---------------------------------------------------------------------------
// المنطق الحتمي النقي (قابل لاختبار الوحدة) — لا أثر جانبي
// ---------------------------------------------------------------------------

/** عدد صفوف متوقّع مقابل فعلي لجدول حرج واحد. */
export interface TableRowCountPair {
  expected: number;
  actual: number;
}

/**
 * يبني خريطة `tableRowCounts` (متوقّع مقابل فعلي) لكل جدول في `tables`، آخذاً
 * القيمة 0 افتراضياً عند غياب أي عدّ، بحيث يبقى الناتج حتمياً وكامل التغطية
 * للجداول الحرجة المحدّدة مسبقاً (Req 3.5).
 *
 * @param tables   مجموعة الجداول الحرجة المراد تضمينها في السجلّ.
 * @param expected الأعداد المتوقّعة (المسجّلة وقت إنشاء النسخة) لكل جدول.
 * @param actual   الأعداد الفعلية المُلاحَظة في الهدف المُستعاد لكل جدول.
 */
export function buildTableRowCounts(
  tables: readonly string[],
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>
): Record<string, TableRowCountPair> {
  const result: Record<string, TableRowCountPair> = {};
  for (const table of tables) {
    result[table] = {
      expected: expected[table] ?? 0,
      actual: actual[table] ?? 0,
    };
  }
  return result;
}

/**
 * يُرجِع `true` إذا وفقط إذا تطابق `expected === actual` لكل جدول في الخريطة
 * (يُعدّ غياب أي جدول مطابقة فارغة صحيحة، أي خريطة بلا مدخلات تُعَدّ متطابقة).
 */
export function allRowCountsMatch(
  tableRowCounts: Readonly<Record<string, TableRowCountPair>>
): boolean {
  return Object.values(tableRowCounts).every(
    (pair) => pair.expected === pair.actual
  );
}

/** مُدخلات بناء سجلّ تمرين الاسترجاع (نقية بالكامل). */
export interface BuildRestoreDrillLogInput {
  restoreId: string;
  backupId: string;
  executedAt: string; // ISO-8601
  targetDatabase: string;
  tableRowCounts: Record<string, TableRowCountPair>;
  /**
   * هل أكملت خطوات الاستعادة ذات الأثر (فكّ التشفير/الأرشيف/التحميل/العدّ) بنجاح؟
   * عند `false` تُسجَّل الدورة فاشلة بصرف النظر عن الأعداد (Req 3.8).
   */
  restoreSucceeded: boolean;
}

/**
 * المنطق النقي لبناء `RestoreDrillLog` من نتائج المقارنة (Req 3.6، 3.8).
 *
 * - `result === 'verified'` ⇔ نجحت الاستعادة **و** تطابقت كل أعداد الجداول الحرجة.
 * - `verifiedRestorable === true` ⇔ `result === 'verified'` (أي نجاح الاستعادة
 *   وتطابق كل الأعداد). أي فشل استعادة أو عدم تطابق ⇒ `failed` و`false`.
 */
export function buildRestoreDrillLog(
  input: BuildRestoreDrillLogInput
): RestoreDrillLog {
  const countsMatch = allRowCountsMatch(input.tableRowCounts);
  const verified = input.restoreSucceeded && countsMatch;

  return {
    restoreId: input.restoreId,
    backupId: input.backupId,
    executedAt: input.executedAt,
    targetDatabase: input.targetDatabase,
    tableRowCounts: input.tableRowCounts,
    result: verified ? 'verified' : 'failed',
    verifiedRestorable: verified,
  };
}

// ---------------------------------------------------------------------------
// خطوات الاستعادة ذات الأثر الجانبي
// ---------------------------------------------------------------------------

// ثوابت التشفير — مطابقة لما يُنتجه `Backup_Service` في `src/utils/backup.ts`.
const BACKUP_ENC_ALGORITHM = 'aes-256-gcm';
const BACKUP_ENC_IV_LENGTH = 12;
const BACKUP_ENC_AUTH_TAG_LENGTH = 16;
const BACKUP_ENC_KEY_LENGTH = 32;
const BACKUP_HKDF_INFO = 'alsaqi-backup-encryption';
const BACKUP_HKDF_SALT = 'alsaqi-backup-enc-salt';

/**
 * يشتقّ مفتاح AES-256 لفكّ تشفير النسخة بنفس آلية `Backup_Service` (HKDF-SHA256
 * فوق `FILE_ENCRYPTION_KEY` أو `FILE_ACCESS_SECRET`). يُرجِع `null` عند غياب أي
 * مادة مفتاح مُعدّة (تُعامَل النسخة عندئذٍ كغير مشفّرة).
 */
export function getBackupDecryptionKey(
  env: Record<string, string | undefined> = process.env
): Buffer | null {
  const rawKey = env.FILE_ENCRYPTION_KEY || env.FILE_ACCESS_SECRET;
  if (!rawKey) {
    return null;
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(rawKey, 'utf8'),
    Buffer.from(BACKUP_HKDF_SALT, 'utf8'),
    Buffer.from(BACKUP_HKDF_INFO, 'utf8'),
    BACKUP_ENC_KEY_LENGTH
  );
  return Buffer.from(derived);
}

/**
 * يفكّ تشفير أرشيف نسخة احتياطية مُنتَج بـ AES-256-GCM إلى `destPath`.
 *
 * تنسيق الإدخال (مطابق لـ `encryptFileAtRest`): [IV (12)][Ciphertext...][AuthTag (16)].
 * يُقرأ الـ IV من البداية والـ AuthTag من النهاية، ويُفكّ ما بينهما.
 */
export async function decryptBackupArchive(
  srcPath: string,
  destPath: string,
  key: Buffer
): Promise<void> {
  const stat = await fs.promises.stat(srcPath);
  const minSize = BACKUP_ENC_IV_LENGTH + BACKUP_ENC_AUTH_TAG_LENGTH;
  if (stat.size < minSize) {
    throw new Error(
      `[RestoreDrill] Encrypted archive too small to be valid: ${srcPath}`
    );
  }

  const fd = await fs.promises.open(srcPath, 'r');
  try {
    // اقرأ الـ IV من بداية الملف.
    const iv = Buffer.alloc(BACKUP_ENC_IV_LENGTH);
    await fd.read(iv, 0, BACKUP_ENC_IV_LENGTH, 0);

    // اقرأ الـ AuthTag من نهاية الملف.
    const authTag = Buffer.alloc(BACKUP_ENC_AUTH_TAG_LENGTH);
    await fd.read(
      authTag,
      0,
      BACKUP_ENC_AUTH_TAG_LENGTH,
      stat.size - BACKUP_ENC_AUTH_TAG_LENGTH
    );

    const decipher = crypto.createDecipheriv(BACKUP_ENC_ALGORITHM, key, iv, {
      authTagLength: BACKUP_ENC_AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const cipherStart = BACKUP_ENC_IV_LENGTH;
    const cipherEnd = stat.size - BACKUP_ENC_AUTH_TAG_LENGTH - 1; // inclusive
    const input = fs.createReadStream(srcPath, {
      start: cipherStart,
      end: cipherEnd,
    });
    const output = fs.createWriteStream(destPath, { mode: 0o600 });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        input.destroy();
        decipher.destroy();
        output.destroy();
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      input.pipe(decipher).pipe(output);
    });
  } finally {
    await fd.close();
  }
}

/** يفكّ أرشيف tar.gz إلى دليل وجهة باستخدام أداة `tar` النظامية. */
function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    tar.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    tar.on('error', (err) =>
      reject(new Error(`tar spawn failed: ${err.message}`))
    );
    tar.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

/** يعدّ صفوف جدول واحد عبر اتصال نظيف بالهدف. يُرجِع 0 عند غياب الجدول. */
async function countTableRows(
  pool: pg.Pool,
  table: string
): Promise<number> {
  // مطابقة اسم الجدول لقائمة بيضاء (الجداول الحرجة) لمنع أي حقن.
  if (!/^[a-zA-Z0-9_]+$/.test(table)) {
    throw new Error(`[RestoreDrill] Invalid table identifier: ${table}`);
  }
  try {
    const res = await pool.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    const row = res.rows[0] as { count?: number } | undefined;
    return row?.count ?? 0;
  } catch (err: unknown) {
    const message = (err as { message?: string })?.message ?? '';
    if (message.includes('does not exist')) {
      return 0;
    }
    throw err;
  }
}

/** خيارات تشغيل تمرين الاسترجاع ذي الأثر. */
export interface RestoreDrillOptions {
  /** مسار أرشيف النسخة الاحتياطية المشفّرة (.tar.gz.enc). */
  backupArchivePath: string;
  /** مُعرّف النسخة الاحتياطية المُستعادة (يُسجَّل في `RestoreDrillLog`). */
  backupId: string;
  /** سلسلة اتصال PostgreSQL لقاعدة الهدف النظيفة والمنفصلة. */
  targetConnectionString: string;
  /** اسم قاعدة الهدف (يُسجَّل في `RestoreDrillLog`). */
  targetDatabase: string;
  /**
   * الأعداد المتوقّعة لكل جدول حرج (مأخوذة وقت إنشاء النسخة). الجداول الغائبة
   * تُعامَل افتراضياً كصفر.
   */
  expectedRowCounts: Readonly<Record<string, number>>;
  /** مجموعة الجداول الحرجة (افتراضياً `CRITICAL_TABLES`). */
  criticalTables?: readonly string[];
  /** بيئة لاشتقاق مفتاح فكّ التشفير (افتراضياً `process.env`). */
  env?: Record<string, string | undefined>;
}

/**
 * يُنفِّذ تمرين الاسترجاع الكامل ذا الأثر: فكّ تشفير النسخة، فكّ الأرشيف، استرجاع
 * بيانات الجداول إلى الهدف النظيف، عدّ صفوف الجداول الحرجة، ثم بناء `RestoreDrillLog`
 * عبر المنطق النقي. أي فشل في خطوات الاستعادة يُنتِج سجلّاً `failed` غير مُتحقَّق منه
 * بدلاً من رمي استثناء (fail-closed، Req 3.8).
 *
 * ملاحظة: تفاصيل تحميل البيانات إلى الهدف (psql/pg_restore أو استيراد JSON) تعتمد
 * على صيغة النسخة المُنتَجة من `Backup_Service`؛ تُحقن خطوة التحميل عبر `loadIntoTarget`
 * لتبقى هذه الدالة قابلة للاختبار وغير مقيّدة بصيغة واحدة.
 */
export async function runRestoreDrill(
  options: RestoreDrillOptions,
  loadIntoTarget: (extractedDir: string, pool: pg.Pool) => Promise<void>,
  now: () => Date = () => new Date()
): Promise<RestoreDrillLog> {
  const tables = options.criticalTables ?? CRITICAL_TABLES;
  const restoreId = crypto.randomUUID();
  const executedAt = now().toISOString();
  const env = options.env ?? process.env;

  let restoreSucceeded = true;
  const actualRowCounts: Record<string, number> = {};

  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'alsaqi-restore-drill-')
  );
  let pool: pg.Pool | null = null;

  try {
    // 1. فكّ تشفير الأرشيف (إن كان مشفّراً).
    const key = getBackupDecryptionKey(env);
    let archivePath = options.backupArchivePath;
    if (key && archivePath.endsWith('.enc')) {
      const decryptedPath = path.join(workDir, 'backup.tar.gz');
      await decryptBackupArchive(archivePath, decryptedPath, key);
      archivePath = decryptedPath;
    }

    // 2. فكّ الأرشيف إلى دليل عمل.
    const extractedDir = path.join(workDir, 'extracted');
    await fs.promises.mkdir(extractedDir, { recursive: true });
    await extractArchive(archivePath, extractedDir);

    // 3. الاتصال بالهدف النظيف وتحميل البيانات.
    pool = new pg.Pool({ connectionString: options.targetConnectionString });
    await loadIntoTarget(extractedDir, pool);

    // 4. عدّ صفوف الجداول الحرجة في الهدف المُستعاد.
    for (const table of tables) {
      actualRowCounts[table] = await countTableRows(pool, table);
    }
  } catch (err) {
    // أي فشل في خطوات الاستعادة ⇒ دورة فاشلة غير مُتحقَّق منها (Req 3.8).
    restoreSucceeded = false;
    console.error(
      '[RestoreDrill] Restore failed:',
      (err as { message?: string })?.message ?? err
    );
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  const tableRowCounts = buildTableRowCounts(
    tables,
    options.expectedRowCounts,
    actualRowCounts
  );

  return buildRestoreDrillLog({
    restoreId,
    backupId: options.backupId,
    executedAt,
    targetDatabase: options.targetDatabase,
    tableRowCounts,
    restoreSucceeded,
  });
}

/**
 * مُحمِّل افتراضي للهدف يستورد ملفات JSON لكل جدول حرج (صيغة نسخ PGlite في
 * `Backup_Service`). كل ملف `<table>.json` يحوي مصفوفة صفوف تُدرَج في الهدف
 * عبر `jsonb_populate_recordset`. الجداول الغائبة تُتجاوَز بصمت.
 */
export async function loadJsonBackupIntoTarget(
  extractedDir: string,
  pool: pg.Pool,
  tables: readonly string[] = CRITICAL_TABLES
): Promise<void> {
  // ابحث عن دليل النسخ الفعلي (قد يكون tar قد ضمّن مجلداً جذرياً واحداً).
  const candidates = [extractedDir];
  const entries = await fs.promises.readdir(extractedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(extractedDir, entry.name));
    }
  }

  for (const table of tables) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error(`[RestoreDrill] Invalid table identifier: ${table}`);
    }
    let jsonPath: string | null = null;
    for (const dir of candidates) {
      const p = path.join(dir, `${table}.json`);
      if (fs.existsSync(p)) {
        jsonPath = p;
        break;
      }
    }
    if (!jsonPath) {
      continue;
    }

    const raw = await fs.promises.readFile(jsonPath, 'utf8');
    const rows = JSON.parse(raw) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) {
      continue;
    }

    await pool.query(
      `INSERT INTO "${table}"
       SELECT * FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb)`,
      [JSON.stringify(rows)]
    );
  }
}

// ---------------------------------------------------------------------------
// CLI main — يُشغَّل فقط عند تنفيذ الملف مباشرةً، لا عند الاستيراد في الاختبارات.
// ---------------------------------------------------------------------------

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void (async () => {
    const backupArchivePath = process.env.RESTORE_DRILL_BACKUP_PATH;
    const targetConnectionString = process.env.RESTORE_DRILL_TARGET_DB_URL;
    const backupId = process.env.RESTORE_DRILL_BACKUP_ID ?? 'unknown';
    const targetDatabase =
      process.env.RESTORE_DRILL_TARGET_DB_NAME ?? 'restore_drill_target';

    if (!backupArchivePath || !targetConnectionString) {
      console.error(
        '[RestoreDrill] FATAL: مطلوب RESTORE_DRILL_BACKUP_PATH و RESTORE_DRILL_TARGET_DB_URL.'
      );
      process.exit(1);
    }

    // الأعداد المتوقّعة تُقرأ من ملف JSON اختياري سُجِّل وقت إنشاء النسخة.
    let expectedRowCounts: Record<string, number> = {};
    const expectedPath = process.env.RESTORE_DRILL_EXPECTED_COUNTS_PATH;
    if (expectedPath && fs.existsSync(expectedPath)) {
      expectedRowCounts = JSON.parse(
        await fs.promises.readFile(expectedPath, 'utf8')
      ) as Record<string, number>;
    }

    const log = await runRestoreDrill(
      {
        backupArchivePath,
        backupId,
        targetConnectionString,
        targetDatabase,
        expectedRowCounts,
      },
      (extractedDir, pool) => loadJsonBackupIntoTarget(extractedDir, pool)
    );

    console.log(JSON.stringify(log, null, 2));
    // fail-closed: رمز خروج غير صفري عند عدم التحقّق من قابلية الاسترجاع (Req 3.8).
    process.exit(log.verifiedRestorable ? 0 : 1);
  })();
}

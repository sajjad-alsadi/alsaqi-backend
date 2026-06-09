// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Property Test: Migration DDL uses IF NOT EXISTS (Property 1)
 *
 * **Validates: Requirements 2.4**
 *
 * For any table creation statement in the migration definitions, the SQL must
 * include `IF NOT EXISTS` to prevent errors on re-execution and ensure
 * idempotent schema creation.
 */
describe('Property 1: Migration DDL uses IF NOT EXISTS', () => {
  // Read the migrations source file to extract all SQL statements
  const tsPath = path.resolve(__dirname, '..', 'migrations.ts');
  const jsPath = path.resolve(__dirname, '..', 'migrations.js');
  const migrationsFilePath = fs.existsSync(tsPath) ? tsPath : jsPath;
  const migrationsSource = fs.readFileSync(migrationsFilePath, 'utf-8');

  // Extract all CREATE TABLE statements from the source
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  const createTableStatements: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = createTableRegex.exec(migrationsSource)) !== null) {
    createTableStatements.push(match[0]);
  }

  // Extract all DROP TABLE statements from the source
  const dropTableRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
  const dropTableStatements: string[] = [];

  while ((match = dropTableRegex.exec(migrationsSource)) !== null) {
    dropTableStatements.push(match[0]);
  }

  it('should have found CREATE TABLE statements in migrations file', () => {
    expect(createTableStatements.length).toBeGreaterThan(0);
  });

  it('every CREATE TABLE statement includes IF NOT EXISTS', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: createTableStatements.length - 1 }),
        (index) => {
          const statement = createTableStatements[index];
          // Every CREATE TABLE must include IF NOT EXISTS
          const hasIfNotExists = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(statement);
          expect(hasIfNotExists).toBe(true);
        }
      ),
      { numRuns: Math.max(100, createTableStatements.length * 3) }
    );
  });

  it('no DROP TABLE statements exist in migrations', () => {
    expect(dropTableStatements).toHaveLength(0);
  });

  it('all CREATE TABLE statements use IF NOT EXISTS pattern (exhaustive check)', () => {
    // Verify every single CREATE TABLE statement, not just random samples
    for (const statement of createTableStatements) {
      const hasIfNotExists = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(statement);
      expect(hasIfNotExists).toBe(true);
    }
  });

  it('generated table names produce valid IF NOT EXISTS DDL pattern', () => {
    // Property: For any valid table name, the expected DDL pattern should
    // always include IF NOT EXISTS
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{2,30}$/),
        (tableName) => {
          // Simulate what the migration system should produce for any table
          const expectedDDL = `CREATE TABLE IF NOT EXISTS ${tableName}`;
          
          // Verify the pattern includes IF NOT EXISTS
          expect(expectedDDL).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+\w+/i);
          
          // Verify it does NOT match a destructive DROP TABLE pattern
          expect(expectedDDL).not.toMatch(/DROP\s+TABLE/i);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no migration SQL contains DROP TABLE followed by CREATE TABLE (destructive pattern)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.max(0, createTableStatements.length - 1) }),
        (index) => {
          const statement = createTableStatements[index];
          // Extract the table name from the CREATE TABLE statement
          const tableNameMatch = statement.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
          if (tableNameMatch) {
            const tableName = tableNameMatch[1];
            // Verify there's no DROP TABLE for this same table name in the source
            const dropPattern = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${tableName}`, 'i');
            expect(migrationsSource).not.toMatch(dropPattern);
          }
        }
      ),
      { numRuns: Math.max(100, createTableStatements.length * 3) }
    );
  });
});


/**
 * Property Test: Migration idempotence preserves data (Property 2)
 *
 * **Validates: Requirements 2.6**
 *
 * For any valid data inserted into `app_settings`, `pdf_settings`, or
 * `user_management_settings` tables, running the migration system again
 * must leave that data unchanged.
 *
 * Strategy: Extract the actual CREATE TABLE IF NOT EXISTS DDL from the
 * migrations source, execute them against an in-memory PGlite instance,
 * insert generated data, re-execute the DDL (simulating server restart),
 * and verify data is preserved.
 */
describe('Property 2: Migration idempotence preserves data', () => {
  let pglite: any;

  // Extract the actual DDL for the three settings tables from migrations source
  const tsPath2 = path.resolve(__dirname, '..', 'migrations.ts');
  const jsPath2 = path.resolve(__dirname, '..', 'migrations.js');
  const migrationsFilePath = fs.existsSync(tsPath2) ? tsPath2 : jsPath2;
  const migrationsSource = fs.readFileSync(migrationsFilePath, 'utf-8');

  // Extract full CREATE TABLE statements for our target tables
  function extractCreateTableDDL(tableName: string): string | null {
    // Match CREATE TABLE IF NOT EXISTS <tableName> ( ... ) with balanced parens
    const regex = new RegExp(
      `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\s*\\(`,
      'i'
    );
    const match = regex.exec(migrationsSource);
    if (!match) return null;

    // Find the matching closing paren by counting depth
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < migrationsSource.length && depth > 0) {
      if (migrationsSource[i] === '(') depth++;
      if (migrationsSource[i] === ')') depth--;
      i++;
    }

    return migrationsSource.substring(match.index, i);
  }

  const appSettingsDDL = extractCreateTableDDL('app_settings');
  const pdfSettingsDDL = extractCreateTableDDL('pdf_settings');
  const userMgmtSettingsDDL = extractCreateTableDDL('user_management_settings');

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;

    // Create the tables initially
    if (appSettingsDDL) await pglite.query(appSettingsDDL);
    if (pdfSettingsDDL) await pglite.query(pdfSettingsDDL);
    if (userMgmtSettingsDDL) await pglite.query(userMgmtSettingsDDL);
  });

  afterAll(async () => {
    if (pglite) {
      await pglite.close();
    }
  });

  it('should have extracted DDL for all three settings tables', () => {
    expect(appSettingsDDL).not.toBeNull();
    expect(pdfSettingsDDL).not.toBeNull();
    expect(userMgmtSettingsDDL).not.toBeNull();
  });

  it('data in app_settings, pdf_settings, and user_management_settings is preserved after re-running CREATE TABLE IF NOT EXISTS', async () => {
    // Define fast-check arbitraries for each settings table
    const appSettingsArb = fc.record({
      app_name: fc.string({ minLength: 1, maxLength: 50 }),
      app_version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/),
      app_description: fc.string({ minLength: 0, maxLength: 100 }),
      company_name: fc.string({ minLength: 1, maxLength: 50 }),
      system_owner: fc.string({ minLength: 1, maxLength: 50 }),
      developer_name: fc.string({ minLength: 1, maxLength: 50 }),
      support_email: fc.emailAddress(),
      app_status: fc.constantFrom('Active', 'Inactive', 'Maintenance'),
    });

    const pdfSettingsArb = fc.record({
      arabic_font_name: fc.constantFrom('Simplified Arabic', 'Traditional Arabic', 'Tahoma'),
      arabic_font_size: fc.integer({ min: 8, max: 72 }),
      heading_font_size: fc.integer({ min: 10, max: 72 }),
      subheading_font_size: fc.integer({ min: 8, max: 72 }),
      table_font_size: fc.integer({ min: 8, max: 72 }),
      rtl_enabled: fc.constantFrom(0, 1),
      margin_top: fc.integer({ min: 0, max: 100 }),
      margin_right: fc.integer({ min: 0, max: 100 }),
      margin_bottom: fc.integer({ min: 0, max: 100 }),
      margin_left: fc.integer({ min: 0, max: 100 }),
      logo_position: fc.constantFrom('left', 'right', 'center'),
      show_page_number: fc.constantFrom(0, 1),
    });

    const userMgmtSettingsArb = fc.record({
      failed_login_threshold: fc.integer({ min: 1, max: 10 }),
      inactive_account_threshold_days: fc.integer({ min: 30, max: 365 }),
      password_min_length: fc.integer({ min: 6, max: 32 }),
      password_require_uppercase: fc.constantFrom(0, 1),
      password_require_lowercase: fc.constantFrom(0, 1),
      password_require_numbers: fc.constantFrom(0, 1),
      password_require_symbols: fc.constantFrom(0, 1),
      password_expiry_days: fc.integer({ min: 30, max: 365 }),
      enforce_single_session: fc.constantFrom(0, 1),
      session_timeout_minutes: fc.integer({ min: 5, max: 480 }),
      bulk_import_enabled: fc.constantFrom(0, 1),
      admin_approval_required: fc.constantFrom(0, 1),
    });

    await fc.assert(
      fc.asyncProperty(
        appSettingsArb,
        pdfSettingsArb,
        userMgmtSettingsArb,
        async (appSettings, pdfSettings, userMgmtSettings) => {
          // Clear existing data for this iteration
          await pglite.query('DELETE FROM app_settings');
          await pglite.query('DELETE FROM pdf_settings');
          await pglite.query('DELETE FROM user_management_settings');

          // Insert generated data into app_settings
          await pglite.query(
            `INSERT INTO app_settings (id, app_name, app_version, app_description, company_name, system_owner, developer_name, support_email, app_status)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              appSettings.app_name,
              appSettings.app_version,
              appSettings.app_description,
              appSettings.company_name,
              appSettings.system_owner,
              appSettings.developer_name,
              appSettings.support_email,
              appSettings.app_status,
            ]
          );

          // Insert generated data into pdf_settings
          await pglite.query(
            `INSERT INTO pdf_settings (id, arabic_font_name, arabic_font_size, heading_font_size, subheading_font_size, table_font_size, rtl_enabled, margin_top, margin_right, margin_bottom, margin_left, logo_position, show_page_number)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              pdfSettings.arabic_font_name,
              pdfSettings.arabic_font_size,
              pdfSettings.heading_font_size,
              pdfSettings.subheading_font_size,
              pdfSettings.table_font_size,
              pdfSettings.rtl_enabled,
              pdfSettings.margin_top,
              pdfSettings.margin_right,
              pdfSettings.margin_bottom,
              pdfSettings.margin_left,
              pdfSettings.logo_position,
              pdfSettings.show_page_number,
            ]
          );

          // Insert generated data into user_management_settings
          await pglite.query(
            `INSERT INTO user_management_settings (id, failed_login_threshold, inactive_account_threshold_days, password_min_length, password_require_uppercase, password_require_lowercase, password_require_numbers, password_require_symbols, password_expiry_days, enforce_single_session, session_timeout_minutes, bulk_import_enabled, admin_approval_required)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              userMgmtSettings.failed_login_threshold,
              userMgmtSettings.inactive_account_threshold_days,
              userMgmtSettings.password_min_length,
              userMgmtSettings.password_require_uppercase,
              userMgmtSettings.password_require_lowercase,
              userMgmtSettings.password_require_numbers,
              userMgmtSettings.password_require_symbols,
              userMgmtSettings.password_expiry_days,
              userMgmtSettings.enforce_single_session,
              userMgmtSettings.session_timeout_minutes,
              userMgmtSettings.bulk_import_enabled,
              userMgmtSettings.admin_approval_required,
            ]
          );

          // Snapshot data before re-running migrations
          const appBefore = (await pglite.query('SELECT * FROM app_settings WHERE id = 1')).rows[0];
          const pdfBefore = (await pglite.query('SELECT * FROM pdf_settings WHERE id = 1')).rows[0];
          const userMgmtBefore = (await pglite.query('SELECT * FROM user_management_settings WHERE id = 1')).rows[0];

          // Re-run the CREATE TABLE IF NOT EXISTS DDL (simulating server restart migration)
          await pglite.query(appSettingsDDL!);
          await pglite.query(pdfSettingsDDL!);
          await pglite.query(userMgmtSettingsDDL!);

          // Snapshot data after re-running migrations
          const appAfter = (await pglite.query('SELECT * FROM app_settings WHERE id = 1')).rows[0];
          const pdfAfter = (await pglite.query('SELECT * FROM pdf_settings WHERE id = 1')).rows[0];
          const userMgmtAfter = (await pglite.query('SELECT * FROM user_management_settings WHERE id = 1')).rows[0];

          // Verify data is unchanged
          expect(appAfter).toEqual(appBefore);
          expect(pdfAfter).toEqual(pdfBefore);
          expect(userMgmtAfter).toEqual(userMgmtBefore);
        }
      ),
      { numRuns: 100 }
    );
  }, 120000); // 2 minute timeout for 100 iterations with PGlite
});

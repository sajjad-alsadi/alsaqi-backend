import { Migration } from './migrationRunner';

/**
 * Registry of all versioned migrations.
 * 
 * Each migration has a unique version string (zero-padded for correct ordering),
 * a human-readable name, a type ('schema' for DDL or 'seed' for data), and an
 * `up` function that performs the migration.
 * 
 * The base schema (all CREATE TABLE IF NOT EXISTS statements) is handled by
 * `runMigrations()` in migrations.ts. This registry is for incremental changes
 * that should only run once and be tracked in the schema_migrations table.
 * 
 * To add a new migration:
 * 1. Add a new entry with the next sequential version number
 * 2. Provide a descriptive name
 * 3. Implement the `up` function with the migration logic
 */

// Import db for use in migration up() functions
import { db } from './index';

export const versionedMigrations: Migration[] = [
  {
    version: '001',
    name: 'Unify Administrator role to Admin',
    type: 'seed',
    up: async () => {
      await db.exec("UPDATE users SET role = 'Admin' WHERE role = 'Administrator'");
    },
  },

  {
    version: '002',
    name: 'Add API audit tables and soft delete columns',
    type: 'schema',
    up: async () => {
      // 1. Create idempotency_keys table (Requirement 13.3)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          idempotency_key TEXT NOT NULL,
          user_id UUID NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          response_status INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ NOT NULL,
          UNIQUE(idempotency_key, user_id)
        )
      `);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key_user ON idempotency_keys(idempotency_key, user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at)`);

      // 2. Create request_logs table (Requirement 11.4)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS request_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_id TEXT NOT NULL,
          user_id UUID,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          error_message TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs(status_code)`);

      // 3. Create file_access_logs table (Requirement 12.4)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS file_access_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          access_type TEXT NOT NULL,
          result TEXT NOT NULL,
          ip_address TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_file_access_logs_user_id ON file_access_logs(user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_file_access_logs_file_path ON file_access_logs(file_path)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_file_access_logs_created_at ON file_access_logs(created_at)`);

      // 4. Create dead_letter_queue table (Requirement 17.2)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS dead_letter_queue (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          failure_reason TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          retry_count INTEGER DEFAULT 0
        )
      `);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_event_type ON dead_letter_queue(event_type)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at ON dead_letter_queue(created_at)`);

      // 5. Add deleted_at and deleted_by columns to entity tables that need soft delete (Requirement 8.1)
      // Tables that already have deleted_at: audit_tasks, audit_findings, compliance_items
      // Tables that need soft delete support added:
      const softDeleteTables = [
        'audit_programs',
        'audit_plans',
        'recommendations',
        'risk_register',
        'audit_evidence',
        'audit_reports',
        'fraud_log',
        'incoming_correspondence',
        'outgoing_correspondence',
        'correspondence_attachments',
      ];

      for (const table of softDeleteTables) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_by UUID`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_deleted_at ON ${table}(deleted_at)`);
      }

      // Add deleted_by to tables that already have deleted_at but lack deleted_by
      const tablesNeedingDeletedBy = [
        'audit_tasks',
        'audit_findings',
        'compliance_items',
      ];

      for (const table of tablesNeedingDeletedBy) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_by UUID`);
      }
    },
  },

  {
    version: '003',
    name: 'Add encrypted_files table for file encryption at rest',
    type: 'schema',
    up: async () => {
      // Create encrypted_files table to store encryption metadata for uploaded files
      await db.exec(`
        CREATE TABLE IF NOT EXISTS encrypted_files (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          original_size INTEGER NOT NULL,
          encrypted_path TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          checksum_sha256 TEXT NOT NULL,
          key_version INTEGER NOT NULL DEFAULT 1,
          encrypted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          uploaded_by TEXT NOT NULL,
          module TEXT NOT NULL CHECK (module IN ('audit', 'fraud', 'coi', 'correspondence'))
        )
      `);

      // Index on uploaded_by for querying files by user
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_encrypted_files_uploaded_by ON encrypted_files(uploaded_by)`);

      // Index on module for filtering by application module
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_encrypted_files_module ON encrypted_files(module)`);

      // Index on key_version for key rotation operations
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_encrypted_files_key_version ON encrypted_files(key_version)`);
    },
  },

  {
    version: '004',
    name: 'Add backup_history table for backup scheduling',
    type: 'schema',
    up: async () => {
      // Create backup_history table to track all backup operations
      await db.exec(`
        CREATE TABLE IF NOT EXISTS backup_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMPTZ,
          status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
          type TEXT NOT NULL CHECK (type IN ('scheduled', 'manual')),
          size_bytes BIGINT DEFAULT 0,
          tables_count INTEGER DEFAULT 0,
          file_path TEXT,
          error_message TEXT,
          verified BOOLEAN DEFAULT FALSE,
          verified_at TIMESTAMPTZ
        )
      `);

      // Index on started_at for querying recent backups
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_history_started_at ON backup_history(started_at)`);
    },
  },

  {
    version: '005',
    name: 'Add user_totp table and requires_2fa_setup column for 2FA',
    type: 'schema',
    up: async () => {
      // Create user_totp table to store TOTP secrets and backup codes
      await db.exec(`
        CREATE TABLE IF NOT EXISTS user_totp (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL UNIQUE,
          secret_encrypted TEXT NOT NULL,
          secret_iv TEXT NOT NULL,
          secret_tag TEXT NOT NULL,
          is_enabled BOOLEAN DEFAULT FALSE,
          enabled_at TIMESTAMPTZ,
          backup_codes_hash TEXT NOT NULL,
          last_used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Index on user_id for fast lookups
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_totp_user_id ON user_totp(user_id)`);

      // Add requires_2fa_setup column to users table
      await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_2fa_setup BOOLEAN DEFAULT FALSE`);
    },
  },

  {
    version: '006',
    name: 'Convert audit_trail to range-partitioned table by timestamp',
    type: 'schema',
    up: async () => {
      // Partitioning only works with external PostgreSQL (not PGlite)
      if (!db.isExternal) {
        return;
      }

      // Check if already partitioned
      const checkResult = await db.prepare(`
        SELECT relkind FROM pg_class WHERE relname = 'audit_trail'
      `).get();

      if (checkResult?.relkind === 'p') {
        // Already partitioned, skip
        return;
      }

      // Step 1: Create the partitioned parent table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS audit_trail_partitioned (
          id UUID DEFAULT gen_random_uuid(),
          "user" TEXT NOT NULL,
          action TEXT NOT NULL,
          module TEXT NOT NULL,
          details TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, timestamp)
        ) PARTITION BY RANGE (timestamp)
      `);

      // Step 2: Create initial partitions (previous month, current, +3 future)
      const now = new Date();
      for (let i = -1; i <= 3; i++) {
        const start = new Date(Date.UTC(now.getFullYear(), now.getMonth() + i, 1));
        const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + i + 1, 1));
        const partName = `audit_trail_y${start.getFullYear()}m${String(start.getMonth() + 1).padStart(2, '0')}`;

        await db.exec(`
          CREATE TABLE IF NOT EXISTS ${partName}
          PARTITION OF audit_trail_partitioned
          FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
        `);
      }

      // Step 3: Check for existing data and create historical partitions if needed
      const existingData = await db.prepare(
        `SELECT COUNT(*) as count FROM audit_trail`
      ).get();

      if (existingData && parseInt(existingData.count) > 0) {
        // Find the oldest record to create partitions for historical data
        const oldestRow = await db.prepare(
          `SELECT MIN(timestamp) as min_ts FROM audit_trail`
        ).get();

        if (oldestRow?.min_ts) {
          const oldestDate = new Date(oldestRow.min_ts);
          const currentPartStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));

          // Create partitions for all months between oldest data and already-created partitions
          let iterDate = new Date(Date.UTC(oldestDate.getFullYear(), oldestDate.getMonth(), 1));
          while (iterDate < currentPartStart) {
            const start = new Date(Date.UTC(iterDate.getFullYear(), iterDate.getMonth(), 1));
            const end = new Date(Date.UTC(iterDate.getFullYear(), iterDate.getMonth() + 1, 1));
            const partName = `audit_trail_y${start.getFullYear()}m${String(start.getMonth() + 1).padStart(2, '0')}`;

            await db.exec(`
              CREATE TABLE IF NOT EXISTS ${partName}
              PARTITION OF audit_trail_partitioned
              FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')
            `);

            iterDate = new Date(Date.UTC(iterDate.getFullYear(), iterDate.getMonth() + 1, 1));
          }
        }

        // Step 4: Migrate existing data from original table to partitioned table
        await db.exec(`
          INSERT INTO audit_trail_partitioned (id, "user", action, module, details, timestamp)
          SELECT id, "user", action, module, details, timestamp
          FROM audit_trail
        `);
      }

      // Step 5: Swap table names (old → _old, partitioned → audit_trail)
      await db.exec(`ALTER TABLE audit_trail RENAME TO audit_trail_old`);
      await db.exec(`ALTER TABLE audit_trail_partitioned RENAME TO audit_trail`);
    },
  },

  {
    version: '007',
    name: 'Create permission_audit_logs table for permission change auditing',
    type: 'schema',
    up: async () => {
      // Create permission_audit_logs table (Requirement 12.1-12.6)
      // Append-only audit log for all permission changes
      await db.exec(`
        CREATE TABLE IF NOT EXISTS permission_audit_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type TEXT NOT NULL CHECK (event_type IN ('role_permission_change', 'user_override_change', 'custom_role_created', 'custom_role_deleted')),
          actor_user_id TEXT NOT NULL,
          target_role_id TEXT,
          target_user_id TEXT,
          old_state TEXT,
          new_state TEXT,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Indexes for efficient filtering (Req 12.4)
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_perm_audit_actor ON permission_audit_logs(actor_user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_perm_audit_target_role ON permission_audit_logs(target_role_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_perm_audit_target_user ON permission_audit_logs(target_user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_perm_audit_event_type ON permission_audit_logs(event_type)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_perm_audit_timestamp ON permission_audit_logs(timestamp)`);
    },
  },

  {
    version: '008',
    name: 'Audit modules restructure - tables, columns, and indexes',
    type: 'schema',
    up: async () => {
      // 1. audit_plans: Add year, quarter, is_archived, archived_at, archived_by columns
      await db.exec(`ALTER TABLE audit_plans ADD COLUMN IF NOT EXISTS year INTEGER`);
      await db.exec(`ALTER TABLE audit_plans ADD COLUMN IF NOT EXISTS quarter TEXT DEFAULT 'Annual'`);
      await db.exec(`ALTER TABLE audit_plans ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false`);
      await db.exec(`ALTER TABLE audit_plans ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
      await db.exec(`ALTER TABLE audit_plans ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id)`);

      // 2. Create task_assignments table (many-to-many for multi-assignee tasks)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS task_assignments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id UUID NOT NULL REFERENCES audit_tasks(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id),
          assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          assigned_by UUID REFERENCES users(id),
          UNIQUE(task_id, user_id)
        )
      `);

      // 3. Create program_risk_links table (link programs to risk_register)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS program_risk_links (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          program_id UUID NOT NULL REFERENCES audit_programs(id) ON DELETE CASCADE,
          risk_id UUID NOT NULL REFERENCES risk_register(id),
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(program_id, risk_id)
        )
      `);

      // 4. Create program_compliance_links table (link programs to compliance_items)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS program_compliance_links (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          program_id UUID NOT NULL REFERENCES audit_programs(id) ON DELETE CASCADE,
          compliance_item_id UUID NOT NULL REFERENCES compliance_items(id),
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(program_id, compliance_item_id)
        )
      `);

      // 5. audit_findings: Add finding_type, created_by, title columns
      // finding_type and created_by may already exist from column migrations, use IF NOT EXISTS
      await db.exec(`ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS finding_type TEXT DEFAULT 'control_design_deficiency'`);
      await db.exec(`ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id)`);
      // title already exists as NOT NULL in base schema, but ensure it's there
      await db.exec(`ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS title TEXT`);
      // Backfill any NULL titles before enforcing NOT NULL
      await db.exec(`UPDATE audit_findings SET title = COALESCE(title, 'ملاحظة ' || COALESCE(finding_number, id::text)) WHERE title IS NULL`);
      // Set NOT NULL constraint (may already be set from base schema)
      try {
        await db.exec(`ALTER TABLE audit_findings ALTER COLUMN title SET NOT NULL`);
      } catch (_e) {
        // Column may already be NOT NULL
      }

      // 6. recommendations: Add plan_id column
      await db.exec(`ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES audit_plans(id)`);

      // 6b. audit_evidence: Add evidence_number and file_path columns
      await db.exec(`ALTER TABLE audit_evidence ADD COLUMN IF NOT EXISTS evidence_number TEXT`);
      await db.exec(`ALTER TABLE audit_evidence ADD COLUMN IF NOT EXISTS file_path TEXT`);

      // 6c. audit_programs: Add approved_by and approved_at columns
      await db.exec(`ALTER TABLE audit_programs ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id)`);
      await db.exec(`ALTER TABLE audit_programs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);

      // 7. Create archive tables
      await db.exec(`
        CREATE TABLE IF NOT EXISTS archived_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_plan_id UUID NOT NULL,
          plan_data JSONB NOT NULL,
          year INTEGER NOT NULL,
          archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          archived_by UUID REFERENCES users(id)
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS archived_tasks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_task_id UUID NOT NULL,
          plan_id UUID NOT NULL,
          task_data JSONB NOT NULL,
          archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS archived_findings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_finding_id UUID NOT NULL,
          plan_id UUID NOT NULL,
          finding_data JSONB NOT NULL,
          archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS archived_recommendations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_recommendation_id UUID NOT NULL,
          plan_id UUID NOT NULL,
          recommendation_data JSONB NOT NULL,
          archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS archived_evidence (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          original_evidence_id UUID NOT NULL,
          plan_id UUID NOT NULL,
          evidence_data JSONB NOT NULL,
          archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 7b. Create numbering_counters table for unified hierarchical numbering
      // Composite primary key (scope_type, scope_id) determines counter scope:
      //   - 'plan_year' + year  → plan sequence within year (001, 002, ...)
      //   - 'task'  + plan_id   → task sequence within plan (T01, T02, ...)
      //   - 'finding' + plan_id → finding sequence within plan (F01, F02, ...)
      //   - 'rec'   + finding_id → recommendation sequence within finding (R01, R02, ...)
      //   - 'evidence' + finding_id → evidence sequence within finding (E01, E02, ...)
      await db.exec(`
        CREATE TABLE IF NOT EXISTS numbering_counters (
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          last_value INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope_type, scope_id)
        )
      `);

      // 8. Performance indexes
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_plans_year ON audit_plans(year)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_plans_quarter ON audit_plans(quarter)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_plans_is_archived ON audit_plans(is_archived)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_findings_plan_id ON audit_findings(audit_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_findings_created_by ON audit_findings(created_by)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_recommendations_plan_id ON recommendations(plan_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON task_assignments(task_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_task_assignments_user_id ON task_assignments(user_id)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_archived_plans_year ON archived_plans(year)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_evidence_finding_id ON audit_evidence(finding_id)`);
    },
  },

  {
    version: '009',
    name: 'Add template_type_key column to pdf_templates',
    type: 'schema',
    up: async () => {
      // Step 1: Add the template_type_key column (nullable initially to allow population)
      await db.exec(`
        ALTER TABLE pdf_templates ADD COLUMN IF NOT EXISTS template_type_key VARCHAR(50)
      `);

      // Step 2: Populate template_type_key using CASE mapping from existing template_type values
      // Maps Arabic labels and English labels to snake_case keys.
      // Unmapped, NULL, or empty values default to 'general'.
      await db.exec(`
        UPDATE pdf_templates SET template_type_key = CASE
          WHEN template_type = 'تقرير التدقيق' OR template_type = 'Audit Report' THEN 'audit_report'
          WHEN template_type = 'التقرير الربعي' OR template_type = 'Quarterly Report' THEN 'quarterly_report'
          WHEN template_type = 'التقرير السنوي' OR template_type = 'Annual Report' THEN 'annual_report'
          WHEN template_type = 'خطة التدقيق' OR template_type = 'Audit Plan' THEN 'audit_plan'
          WHEN template_type = 'مهام التدقيق' OR template_type = 'Audit Missions' THEN 'audit_missions'
          WHEN template_type = 'التوصيات' OR template_type = 'Recommendations' THEN 'recommendations'
          WHEN template_type = 'خطاب صادر' OR template_type = 'Outgoing Letter' THEN 'outgoing_letter'
          ELSE 'general'
        END
        WHERE template_type_key IS NULL
      `);

      // Step 3: Make column NOT NULL after all rows are populated
      await db.exec(`
        ALTER TABLE pdf_templates ALTER COLUMN template_type_key SET NOT NULL
      `);

      // Step 4: Set default value for future inserts
      await db.exec(`
        ALTER TABLE pdf_templates ALTER COLUMN template_type_key SET DEFAULT 'general'
      `);

      // Step 5: Create partial composite index on (template_type_key, status)
      // filtered by is_default = 1 for fast lookups of default templates
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pdf_templates_type_key_status
          ON pdf_templates(template_type_key, status)
          WHERE is_default = 1
      `);

      // Step 6: Create unique partial index to enforce one default approved template per type
      // This prevents race conditions from creating multiple defaults
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_default_per_type
          ON pdf_templates(template_type_key)
          WHERE is_default = 1 AND status = 'Approved'
      `);

      // Note: The original template_type column is preserved unchanged for backward compatibility
    },
  },

  {
    version: '010',
    name: 'Make audit_tasks.plan_id nullable for routine tasks',
    type: 'schema',
    up: async () => {
      // Allow plan_id to be NULL so routine tasks (without an audit plan) can be created
      await db.exec(`ALTER TABLE audit_tasks ALTER COLUMN plan_id DROP NOT NULL`);

      // Add task_type column to distinguish between routine and audit plan tasks
      await db.exec(`ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(20) DEFAULT 'audit_plan'`);
    },
  },
];

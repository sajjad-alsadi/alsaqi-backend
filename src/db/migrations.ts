import { db } from "./index";
import { ROLES, MODULES, PERMISSIONS, DEFAULT_PERMISSIONS } from "../permissions.js";

export const runMigrations = async () => {
  // Test connection first to avoid multiple connection errors
  try {
    await db.prepare("SELECT 1").get();
  } catch (e: any) {
    if (e.message?.includes('ECONNREFUSED') || e.message?.includes('connection timeout') || e.message?.includes('Connection terminated')) {
      console.error("[DB] CRITICAL: Database connection failed. Migrations cannot proceed.");
      console.error("[DB] Error details:", e.message);
      throw e; // Stop migrations if we can't connect
    }
    // Other errors (like table not existing) might be fine at this stage
  }

  // Core tables
  const coreTables = [
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      department TEXT,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      last_login TIMESTAMP,
      failed_attempts INTEGER DEFAULT 0,
      locked_until TIMESTAMP,
      profile_picture TEXT,
      language TEXT DEFAULT 'en',
      theme TEXT DEFAULT 'light',
      dashboard_layout TEXT DEFAULT 'standard',
      notifications_enabled INTEGER DEFAULT 1,
      job_title_id UUID,
      role_id UUID,
      unit TEXT,
      reporting_manager_id UUID,
      access_scope TEXT,
      phone_number TEXT,
      notes TEXT,
      session_version INTEGER DEFAULT 1,
      requires_password_change INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_programs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      program_code TEXT,
      program_title TEXT,
      audit_area TEXT,
      department TEXT,
      audit_type TEXT,
      audit_objective TEXT,
      audit_scope TEXT,
      key_risks TEXT,
      control_objectives TEXT,
      reference_standard TEXT,
      status TEXT,
      version_number TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_code TEXT UNIQUE,
      program_id UUID,
      title TEXT NOT NULL,
      department TEXT,
      type TEXT,
      risk_rating TEXT,
      planned_start_date TEXT,
      planned_end_date TEXT,
      status TEXT,
      lead_auditor TEXT,
      team_members TEXT,
      objectives TEXT,
      scope TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(program_id) REFERENCES audit_programs(id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_procedures (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id UUID,
      procedure_number TEXT,
      audit_step TEXT,
      audit_test_description TEXT,
      risk_addressed TEXT,
      control_test_type TEXT,
      expected_evidence TEXT,
      sampling_method TEXT,
      responsible_auditor TEXT,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(program_id) REFERENCES audit_programs(id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_findings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audit_id UUID,
      title TEXT NOT NULL,
      description TEXT,
      criteria TEXT,
      condition TEXT,
      cause TEXT,
      consequence TEXT,
      recommendation TEXT,
      risk_level TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(audit_id) REFERENCES audit_plans(id)
    )`,
    `CREATE TABLE IF NOT EXISTS recommendations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id UUID,
      department TEXT,
      responsible TEXT,
      due_date TEXT,
      status TEXT,
      risk_level TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(finding_id) REFERENCES audit_findings(id)
    )`,
    `CREATE TABLE IF NOT EXISTS risk_register (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_id TEXT,
      description TEXT,
      owner TEXT,
      source TEXT,
      early_warning TEXT,
      type TEXT,
      likelihood TEXT,
      impact TEXT,
      score INTEGER,
      rating TEXT,
      controls TEXT,
      control_assessment TEXT,
      mitigation TEXT,
      treatment_option TEXT,
      residual_likelihood TEXT,
      residual_impact TEXT,
      residual_score INTEGER,
      residual_rating TEXT,
      status TEXT,
      target_date TEXT,
      review_date TEXT,
      notes TEXT,
      entry_date TEXT,
      entered_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS central_bank_instructions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT,
      issue_date TEXT,
      reference_number TEXT,
      category TEXT,
      description TEXT,
      related_department TEXT,
      attachment TEXT,
      status TEXT,
      related_instruction_id UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_trail (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "user" TEXT NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS internal_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      department TEXT NOT NULL,
      version TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      file_url TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const tableSql of coreTables) {
    try {
      await db.prepare(tableSql).run();
    } catch (e) {
      console.error("Error creating core table:", e);
    }
  }

  // Roles and Permissions tables
  const userManagementTables = [
    `CREATE TABLE IF NOT EXISTS org_entities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_code TEXT UNIQUE NOT NULL,
      name_ar TEXT NOT NULL,
      name_en TEXT NOT NULL,
      entity_type TEXT NOT NULL, -- Top Management, Department, Division, Unit, Branch, Office, Committee, Other
      parent_id UUID,
      manager_id UUID,
      manager_name TEXT,
      level INTEGER DEFAULT 1,
      status TEXT DEFAULT 'Active', -- Active, Inactive, Archived
      description TEXT,
      display_order INTEGER DEFAULT 0,
      location TEXT,
      cost_center_code TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES org_entities(id),
      FOREIGN KEY (manager_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_number VARCHAR(30) UNIQUE NOT NULL,
      title TEXT NOT NULL,
      plan_id UUID NOT NULL REFERENCES audit_plans(id),
      program_id UUID REFERENCES audit_programs(id),
      audit_type TEXT NOT NULL, 
      status TEXT NOT NULL DEFAULT 'draft',
      assigned_to UUID REFERENCES users(id),
      audited_unit_id UUID REFERENCES org_entities(id),
      planned_hours INTEGER,
      actual_hours INTEGER DEFAULT 0,
      period_from DATE,
      period_to DATE,
      due_date DATE,
      approved_by UUID REFERENCES users(id),
      approved_at TIMESTAMPTZ,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS finding_risks (
      finding_id UUID NOT NULL REFERENCES audit_findings(id),
      risk_id UUID NOT NULL REFERENCES risk_register(id),
      PRIMARY KEY (finding_id, risk_id)
    )`,
    `CREATE TABLE IF NOT EXISTS finding_compliance (
      finding_id UUID NOT NULL REFERENCES audit_findings(id),
      compliance_id UUID NOT NULL REFERENCES central_bank_instructions(id),
      PRIMARY KEY (finding_id, compliance_id)
    )`,
    `CREATE TABLE IF NOT EXISTS compliance_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ref_number TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      issuing_authority TEXT,
      issue_date DATE,
      effective_date DATE,
      compliance_status TEXT DEFAULT 'under_review',
      responsible_person_id UUID REFERENCES users(id),
      attachment_path TEXT,
      notes TEXT,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS law_bank (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      type TEXT,
      authority TEXT,
      issue_date TEXT,
      keywords TEXT,
      bookmarked INTEGER DEFAULT 0,
      file_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fraud_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      incident_date TEXT,
      description TEXT,
      reported_by TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS audit_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audit_id UUID,
      title TEXT,
      report_type INTEGER,
      generated_by TEXT,
      date_generated TEXT,
      status TEXT,
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(audit_id) REFERENCES audit_plans(id)
    )`,
    `CREATE TABLE IF NOT EXISTS system_error_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message TEXT NOT NULL,
      stack TEXT,
      module TEXT NOT NULL,
      user_id UUID,
      severity TEXT DEFAULT 'error',
      user_agent TEXT,
      url TEXT,
      request_data TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS job_titles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      job_level TEXT NOT NULL,
      description TEXT,
      reporting_to UUID,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS outgoing_letters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sequence_number TEXT UNIQUE NOT NULL,
      letter_date DATE,
      recipient_entity TEXT,
      subject TEXT,
      classification TEXT,
      sending_method TEXT,
      attachment_file TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_archived INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      app_name TEXT,
      app_version TEXT,
      app_description TEXT,
      company_name TEXT,
      system_owner TEXT,
      developer_name TEXT,
      release_date TEXT,
      last_update_date TEXT,
      support_email TEXT,
      support_phone TEXT,
      official_website TEXT,
      copyright_notice TEXT,
      system_environment TEXT,
      database_type TEXT,
      build_number TEXT,
      app_status TEXT DEFAULT 'Active'
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      is_revoked INTEGER DEFAULT 0,
      revoked_at TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS system_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      policy_key TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pdf_settings (
      id INTEGER PRIMARY KEY,
      arabic_font_name TEXT DEFAULT 'Simplified Arabic',
      arabic_font_size INTEGER DEFAULT 14,
      heading_font_size INTEGER DEFAULT 16,
      subheading_font_size INTEGER DEFAULT 14,
      table_font_size INTEGER DEFAULT 14,
      rtl_enabled INTEGER DEFAULT 1,
      margin_top INTEGER DEFAULT 20,
      margin_right INTEGER DEFAULT 20,
      margin_bottom INTEGER DEFAULT 20,
      margin_left INTEGER DEFAULT 20,
      header_template TEXT DEFAULT '',
      footer_template TEXT DEFAULT '',
      logo_position TEXT DEFAULT 'right',
      show_page_number INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS pdf_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_name TEXT NOT NULL,
      template_type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'Draft',
      is_default INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      related_module TEXT,
      link TEXT,
      status TEXT DEFAULT 'Unread',
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      status TEXT DEFAULT 'Pending',
      request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fraud_access_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      user_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'Pending',
      request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS conflict_of_interest (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      user_name TEXT NOT NULL,
      declaration_date TEXT NOT NULL,
      description TEXT NOT NULL,
      related_party TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS org_structure (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      department TEXT NOT NULL,
      unit TEXT,
      employee_name TEXT,
      reporting_to UUID,
      role_description TEXT,
      access_level TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS audit_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      audit_id UUID,
      finding_id UUID,
      type TEXT,
      description TEXT,
      uploaded_by TEXT,
      upload_date TEXT,
      file_name TEXT,
      file_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(audit_id) REFERENCES audit_plans(id),
      FOREIGN KEY(finding_id) REFERENCES audit_findings(id)
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_custom INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT,
      UNIQUE(module, action)
    )`,
    `CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, permission_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS login_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      username TEXT,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      logout_time TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      device TEXT,
      browser TEXT,
      status TEXT NOT NULL, -- Success, Failed, Locked
      failure_reason TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      refresh_token TEXT,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'Active', -- Active, Terminated, Expired
      ip_address TEXT,
      device TEXT,
      browser TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS permission_change_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_user_id UUID NOT NULL,
      changed_by_id UUID NOT NULL,
      old_role TEXT,
      new_role TEXT,
      old_permissions TEXT, -- JSON string
      new_permissions TEXT, -- JSON string
      change_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS user_management_settings (
      id INTEGER PRIMARY KEY,
      failed_login_threshold INTEGER DEFAULT 3,
      inactive_account_threshold_days INTEGER DEFAULT 90,
      password_min_length INTEGER DEFAULT 8,
      password_require_uppercase INTEGER DEFAULT 1,
      password_require_lowercase INTEGER DEFAULT 1,
      password_require_numbers INTEGER DEFAULT 1,
      password_require_symbols INTEGER DEFAULT 1,
      password_expiry_days INTEGER DEFAULT 90,
      enforce_single_session INTEGER DEFAULT 0,
      session_timeout_minutes INTEGER DEFAULT 30,
      bulk_import_enabled INTEGER DEFAULT 1,
      admin_approval_required INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS incoming_correspondence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sequence_number TEXT UNIQUE NOT NULL,
      letter_number TEXT,
      sender_entity TEXT NOT NULL,
      sender_entity_type TEXT,
      subject TEXT NOT NULL,
      letter_date DATE,
      receipt_date DATE,
      registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      classification TEXT,
      priority TEXT DEFAULT 'Normal',
      method TEXT,
      receiving_dept_id UUID,
      assigned_dept_id UUID,
      assigned_user_id UUID,
      status TEXT DEFAULT 'Received',
      follow_up_required INTEGER DEFAULT 0,
      follow_up_date DATE,
      response_required INTEGER DEFAULT 0,
      response_due_date DATE,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_archived INTEGER DEFAULT 0,
      FOREIGN KEY (receiving_dept_id) REFERENCES org_entities(id),
      FOREIGN KEY (assigned_dept_id) REFERENCES org_entities(id),
      FOREIGN KEY (assigned_user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS outgoing_correspondence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sequence_number TEXT UNIQUE NOT NULL,
      official_number TEXT UNIQUE,
      letter_date DATE,
      registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      recipient_entity TEXT NOT NULL,
      recipient_entity_type TEXT,
      subject TEXT NOT NULL,
      classification TEXT,
      priority TEXT DEFAULT 'Normal',
      method TEXT,
      status TEXT DEFAULT 'Draft',
      source_dept_id UUID,
      sent_date TIMESTAMP,
      delivery_ref TEXT,
      recipient_contact TEXT,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_archived INTEGER DEFAULT 0,
      FOREIGN KEY (source_dept_id) REFERENCES org_entities(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS correspondence_attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      correspondence_id UUID NOT NULL,
      correspondence_type TEXT NOT NULL, -- 'Incoming' or 'Outgoing'
      file_name TEXT NOT NULL,
      file_type TEXT,
      file_data TEXT, -- Base64 or URL
      description TEXT,
      uploaded_by UUID,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS correspondence_referrals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      incoming_id UUID NOT NULL,
      from_user_id UUID NOT NULL,
      to_dept_id UUID,
      to_user_id UUID,
      referral_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      status TEXT DEFAULT 'Pending',
      FOREIGN KEY (incoming_id) REFERENCES incoming_correspondence(id),
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_dept_id) REFERENCES org_entities(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS correspondence_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      incoming_id UUID NOT NULL,
      outgoing_id UUID NOT NULL,
      link_type TEXT DEFAULT 'Reply',
      linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      linked_by UUID,
      UNIQUE(incoming_id, outgoing_id),
      FOREIGN KEY (incoming_id) REFERENCES incoming_correspondence(id),
      FOREIGN KEY (outgoing_id) REFERENCES outgoing_letters(id),
      FOREIGN KEY (linked_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS correspondence_status_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      correspondence_id UUID NOT NULL,
      correspondence_type TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      changed_by UUID,
      change_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      FOREIGN KEY (changed_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS incoming_letters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sequence_number TEXT UNIQUE NOT NULL,
      letter_date DATE,
      sender_entity TEXT,
      subject TEXT,
      classification TEXT,
      status TEXT DEFAULT 'Open',
      response_required INTEGER DEFAULT 0,
      attachment_file TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const tableSql of userManagementTables) {
    try {
      await db.prepare(tableSql).run();
    } catch (e) {
      console.error("Error creating user management table:", e);
    }
  }

  // Seed system policies
  try {
    const policies = [
      {
        key: 'fraud_policy',
        content: `<h3>سياسة مكافحة الاحتيال والفساد</h3>
<p>تلتزم المؤسسة بأعلى معايير النزاهة والشفافية في جميع معاملاتها. تهدف هذه السياسة إلى:</p>
<ul>
  <li>منع حدوث حالات الاحتيال والفساد بجميع أشكاله.</li>
  <li>تحديد آليات الإبلاغ عن الشبهات بطريقة آمنة وسرية.</li>
  <li>ضمان حماية المبلغين من أي إجراءات انتقامية.</li>
</ul>
<p>يجب على جميع الموظفين والمتعاملين الالتزام بمدونة السلوك الوظيفي ومعايير النزاهة المعتمدة.</p>`
      }
    ];

    for (const p of policies) {
      const exists = await db.prepare("SELECT 1 FROM system_policies WHERE policy_key = ?").get(p.key);
      if (!exists) {
        await db.prepare("INSERT INTO system_policies (policy_key, content) VALUES (?, ?)").run(p.key, p.content);
        console.log(`Seeded system policy: ${p.key}`);
      }
    }
  } catch (e) {
    console.error("Error seeding system policies:", e);
  }

  // Comments table
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        related_type TEXT NOT NULL,
        related_id UUID NOT NULL,
        user_id UUID NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `).run();
  } catch (e) {
    console.error("Error creating comments table:", e);
  }

  // Notification Recipients table (per-user isolation)
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS notification_recipients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_read BOOLEAN DEFAULT false,
        read_at TIMESTAMP,
        is_dismissed BOOLEAN DEFAULT false,
        dismissed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_notif_recip_user_read ON notification_recipients(recipient_id, is_read)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_notif_recip_user_date ON notification_recipients(recipient_id, created_at DESC)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_notif_recip_notif_id ON notification_recipients(notification_id)").run();
  } catch (e) {
    // Table may already exist
  }

  // Column Migrations
  const migrations = [
    { table: "audit_findings", column: "finding_number", type: "VARCHAR(50) UNIQUE" },
    { table: "audit_findings", column: "finding_type", type: "TEXT" },
    { table: "audit_findings", column: "impact", type: "TEXT" },
    { table: "audit_findings", column: "root_cause", type: "TEXT" },
    { table: "audit_findings", column: "responsible_unit_id", type: "UUID REFERENCES org_entities(id)" },
    { table: "audit_findings", column: "risk_id", type: "UUID REFERENCES risk_register(id)" },
    { table: "audit_findings", column: "created_by", type: "UUID REFERENCES users(id)" },
    { table: "audit_findings", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "recommendations", column: "rec_number", type: "VARCHAR(70) UNIQUE" },
    { table: "recommendations", column: "action_plan", type: "TEXT" },
    { table: "recommendations", column: "responsible_person_id", type: "UUID REFERENCES users(id)" },
    { table: "recommendations", column: "priority", type: "TEXT DEFAULT 'medium'" },
    { table: "recommendations", column: "follow_up_date", type: "DATE" },
    { table: "recommendations", column: "closure_evidence_path", type: "TEXT" },
    { table: "recommendations", column: "closed_by", type: "UUID REFERENCES users(id)" },
    { table: "recommendations", column: "closed_at", type: "TIMESTAMPTZ" },
    { table: "recommendations", column: "created_by", type: "UUID REFERENCES users(id)" },
    { table: "risk_register", column: "likelihood_num", type: "INTEGER CHECK(likelihood_num BETWEEN 1 AND 5)" },
    { table: "risk_register", column: "impact_num", type: "INTEGER CHECK(impact_num BETWEEN 1 AND 5)" },
    { table: "risk_register", column: "risk_score_calc", type: "INTEGER" },
    { table: "risk_register", column: "risk_level_calc", type: "TEXT" },
    { table: "audit_plans", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_tasks", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_procedures", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_evidence", column: "created_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_evidence", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "risk_register", column: "created_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "risk_register", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "fraud_log", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "central_bank_instructions", column: "created_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "central_bank_instructions", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "law_bank", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_reports", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_findings", column: "created_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "audit_findings", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "recommendations", column: "created_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "recommendations", column: "updated_at", type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP" },
    { table: "fraud_access_requests", column: "expires_at", type: "TIMESTAMP" },
    { table: "fraud_access_requests", column: "response_date", type: "TIMESTAMP" },
    { table: "fraud_access_requests", column: "responded_by", type: "UUID" },
    { table: "fraud_access_requests", column: "rejection_reason", type: "TEXT" },
    { table: "conflict_of_interest", column: "reviewer_notes", type: "TEXT" },
    { table: "users", column: "password_last_changed", type: "TIMESTAMP" },
    { table: "users", column: "employee_id", type: "TEXT UNIQUE" },
    { table: "users", column: "org_entity_id", type: "UUID" },
    { table: "users", column: "division_id", type: "UUID" },
    { table: "users", column: "unit_id", type: "UUID" },
    { table: "password_reset_requests", column: "temp_password", type: "TEXT" },
    { table: "password_reset_requests", column: "resolved_date", type: "TIMESTAMP" },
    { table: "password_reset_requests", column: "resolved_by", type: "UUID" },
    { table: "users", column: "failed_attempts", type: "INTEGER DEFAULT 0" },
    { table: "users", column: "session_version", type: "INTEGER DEFAULT 1" },
    { table: "users", column: "requires_password_change", type: "INTEGER DEFAULT 0" },
    { table: "users", column: "role_id", type: "UUID" },
    { table: "users", column: "unit", type: "TEXT" },
    { table: "users", column: "reporting_manager_id", type: "UUID" },
    { table: "users", column: "access_scope", type: "TEXT" },
    { table: "users", column: "phone_number", type: "TEXT" },
    { table: "users", column: "notes", type: "TEXT" },
    { table: "audit_plans", column: "department", type: "TEXT" },
    { table: "audit_plans", column: "type", type: "TEXT" },
    { table: "audit_plans", column: "risk_rating", type: "TEXT" },
    { table: "audit_plans", column: "planned_start_date", type: "TEXT" },
    { table: "audit_plans", column: "planned_end_date", type: "TEXT" },
    { table: "audit_plans", column: "lead_auditor", type: "TEXT" },
    { table: "audit_plans", column: "notes", type: "TEXT" },
    { table: "audit_plans", column: "plan_code", type: "TEXT UNIQUE" },
    { table: "system_error_log", column: "severity", type: "TEXT DEFAULT 'error'" },
    { table: "system_error_log", column: "user_agent", type: "TEXT" },
    { table: "system_error_log", column: "url", type: "TEXT" },
    { table: "system_error_log", column: "request_data", type: "TEXT" },
    { table: "login_history", column: "user_agent", type: "TEXT" },
    { table: "audit_procedures", column: "control_test_type", type: "TEXT" },
    { table: "audit_procedures", column: "expected_evidence", type: "TEXT" },
    { table: "audit_procedures", column: "sampling_method", type: "TEXT" },
    { table: "audit_procedures", column: "responsible_auditor", type: "TEXT" },
    { table: "audit_procedures", column: "remarks", type: "TEXT" },
    { table: "user_sessions", column: "refresh_token", type: "TEXT" },
    { table: "refresh_tokens", column: "revoked_at", type: "TIMESTAMP" },
    { table: "outgoing_letters", column: "status", type: "TEXT DEFAULT 'Draft'" },
    { table: "audit_trail", column: "hash", type: "TEXT" },
    { table: "audit_trail", column: "previous_hash", type: "TEXT" },
    { table: "notifications", column: "actor_id", type: "UUID" },
    { table: "notifications", column: "entity_id", type: "UUID" },
    { table: "notifications", column: "entity_type", type: "TEXT" },
    { table: "notifications", column: "data", type: "JSONB DEFAULT '{}'" },
    { table: "notifications", column: "title", type: "TEXT" },
    { table: "user_management_settings", column: "two_factor_auth", type: "INTEGER DEFAULT 0" },
  ];

  for (const m of migrations) {
    try {
      console.log(`[MIGRATION] Attempting to add column ${m.column} to table ${m.table}`);
      await db.prepare(`ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.type}`).run();
    } catch (e) {
      console.error(`Error adding column ${m.column} to ${m.table}:`, e);
    }
  }

  // Add missing foreign key constraints for columns added via ALTER TABLE.
  // Each entry includes the constraint name so we can check for its existence
  // before attempting to add it (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
  const foreignKeys = [
    { table: "users", name: "fk_org_entity", constraint: "ALTER TABLE users ADD CONSTRAINT fk_org_entity FOREIGN KEY (org_entity_id) REFERENCES org_entities(id) ON DELETE SET NULL" },
    { table: "users", name: "fk_manager", constraint: "ALTER TABLE users ADD CONSTRAINT fk_manager FOREIGN KEY (reporting_manager_id) REFERENCES users(id) ON DELETE SET NULL" },
    { table: "password_reset_requests", name: "fk_resolved_by", constraint: "ALTER TABLE password_reset_requests ADD CONSTRAINT fk_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL" },
    { table: "fraud_access_requests", name: "fk_responded_by", constraint: "ALTER TABLE fraud_access_requests ADD CONSTRAINT fk_responded_by FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL" }
  ];

  for (const fk of foreignKeys) {
    try {
      // Skip if the constraint already exists to avoid noisy duplicate errors.
      const existing = await db.prepare(
        "SELECT 1 FROM pg_constraint WHERE conname = ?"
      ).get(fk.name);
      if (existing) continue;

      await db.prepare(fk.constraint).run();
    } catch (e: any) {
      if (!e.message.includes('already exists')) {
        console.warn(`[MIGRATION] Could not add FK to ${fk.table}: ${e.message}`);
      }
    }
  }

  // Backfill plan_code for existing audit_plans
  try {
    const currentYear = new Date().getFullYear();
    // Use a more robust query to find plans without a valid code
    const existingPlans = await db.prepare("SELECT id, title FROM audit_plans WHERE plan_code IS NULL OR plan_code = '' OR plan_code NOT LIKE 'AP-%'").all();
    
    if (existingPlans && existingPlans.length > 0) {
      for (let i = 0; i < existingPlans.length; i++) {
        // Find the next available number for this year to avoid duplicates if some are already set
        const prefix = `AP-${currentYear}-`;
        const latest = await db.prepare("SELECT plan_code FROM audit_plans WHERE plan_code LIKE ? ORDER BY plan_code DESC LIMIT 1").get(`${prefix}%`) as any;
        
        let nextNum = 1;
        if (latest && latest.plan_code) {
          const parts = latest.plan_code.split('-');
          const lastNum = parseInt(parts[parts.length - 1]);
          if (!isNaN(lastNum)) {
            nextNum = lastNum + 1;
          }
        }
        
        const planCode = `${prefix}${nextNum.toString().padStart(3, '0')}`;
        await db.prepare("UPDATE audit_plans SET plan_code = ? WHERE id = ?").run(planCode, existingPlans[i].id);
      }
    }
  } catch (e) {
    console.error("[MIGRATION] Backfill failed:", e);
  }

  // Backfill employee_id for existing users
  try {
    const existingUsers = await db.prepare("SELECT id, department FROM users WHERE employee_id IS NULL OR employee_id = ''").all();
    if (existingUsers && existingUsers.length > 0) {
      for (let i = 0; i < existingUsers.length; i++) {
        const user = existingUsers[i];
        let deptCode = 'EMP';
        if (user.department) {
           try {
             const dept = await db.prepare("SELECT entity_code FROM org_entities WHERE name_ar = ? OR name_en = ?").get(user.department, user.department) as any;
             if (dept && dept.entity_code) deptCode = dept.entity_code;
           } catch(e) {}
        }
        
        const latestEmp = await db.prepare("SELECT employee_id FROM users WHERE employee_id LIKE ? ORDER BY employee_id DESC LIMIT 1").get(`${deptCode}-%`) as any;
        let nextNum = 1001;
        if (latestEmp && latestEmp.employee_id) {
           const parts = latestEmp.employee_id.split('-');
           const lastNum = parseInt(parts[1], 10);
           if (!isNaN(lastNum)) nextNum = lastNum + 1;
        }
        const employee_id = `${deptCode}-${nextNum}`;
        await db.prepare("UPDATE users SET employee_id = ? WHERE id = ?").run(employee_id, user.id);
      }
    }
  } catch (e) {
    console.error("[MIGRATION] Backfill employee_id failed:", e);
  }

  // Performance Indexes
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_audit_trail_timestamp ON audit_trail(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_audit_trail_user ON audit_trail(\"user\")",
    "CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)",
    "CREATE INDEX IF NOT EXISTS idx_users_department ON users(department)",
    "CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)",
    "CREATE INDEX IF NOT EXISTS idx_incoming_correspondence_is_archived ON incoming_correspondence(is_archived)",
    "CREATE INDEX IF NOT EXISTS idx_incoming_correspondence_status ON incoming_correspondence(status)",
    "CREATE INDEX IF NOT EXISTS idx_incoming_correspondence_seq ON incoming_correspondence(sequence_number)",
    "CREATE INDEX IF NOT EXISTS idx_incoming_correspondence_date ON incoming_correspondence(letter_date)",
    "CREATE INDEX IF NOT EXISTS idx_outgoing_correspondence_is_archived ON outgoing_correspondence(is_archived)",
    "CREATE INDEX IF NOT EXISTS idx_outgoing_correspondence_seq ON outgoing_correspondence(sequence_number)",
    "CREATE INDEX IF NOT EXISTS idx_outgoing_correspondence_date ON outgoing_correspondence(letter_date)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_status ON notifications(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_date ON notifications(user_id, date DESC)",
    "CREATE INDEX IF NOT EXISTS idx_audit_plans_status ON audit_plans(status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_plans_risk ON audit_plans(risk_rating)",
    "CREATE INDEX IF NOT EXISTS idx_audit_plans_program_id ON audit_plans(program_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_findings_audit_id ON audit_findings(audit_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_findings_risk ON audit_findings(risk_level)",
    "CREATE INDEX IF NOT EXISTS idx_audit_trail_module ON audit_trail(module)",
    "CREATE INDEX IF NOT EXISTS idx_audit_trail_action ON audit_trail(action)",
    "CREATE INDEX IF NOT EXISTS idx_risk_register_rating ON risk_register(rating)",
    "CREATE INDEX IF NOT EXISTS idx_risk_register_status ON risk_register(status)",
    "CREATE INDEX IF NOT EXISTS idx_recommendations_finding_id ON recommendations(finding_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_tasks_plan_id ON audit_tasks(plan_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_plans_type ON audit_plans(type)",
    "CREATE INDEX IF NOT EXISTS idx_audit_plans_department ON audit_plans(department)",
    "CREATE INDEX IF NOT EXISTS idx_risk_register_type ON risk_register(type)",
    // Additional performance indexes
    "CREATE INDEX IF NOT EXISTS idx_audit_tasks_assigned_to ON audit_tasks(assigned_to)",
    "CREATE INDEX IF NOT EXISTS idx_audit_tasks_status ON audit_tasks(status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_tasks_deleted_at ON audit_tasks(deleted_at)",
    "CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON audit_findings(status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_findings_deleted_at ON audit_findings(deleted_at)",
    "CREATE INDEX IF NOT EXISTS idx_audit_evidence_audit_id ON audit_evidence(audit_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_evidence_finding_id ON audit_evidence(finding_id)",
    "CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status)",
    "CREATE INDEX IF NOT EXISTS idx_recommendations_responsible ON recommendations(responsible_person_id)",
    "CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_login_history_login_time ON login_history(login_time)",
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_user_sessions_status ON user_sessions(status)",
    "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_system_error_log_timestamp ON system_error_log(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_system_error_log_severity ON system_error_log(severity)",
    "CREATE INDEX IF NOT EXISTS idx_correspondence_attachments_corr_id ON correspondence_attachments(correspondence_id)",
    "CREATE INDEX IF NOT EXISTS idx_correspondence_referrals_incoming_id ON correspondence_referrals(incoming_id)",
    "CREATE INDEX IF NOT EXISTS idx_password_history_user_id ON password_history(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_compliance_items_status ON compliance_items(compliance_status)",
    "CREATE INDEX IF NOT EXISTS idx_compliance_items_source_type ON compliance_items(source_type)",
    "CREATE INDEX IF NOT EXISTS idx_compliance_items_deleted_at ON compliance_items(deleted_at)"
  ];

  for (const indexSql of indexes) {
    try {
      await db.prepare(indexSql).run();
    } catch (e) {
      console.error("Error creating index:", e);
    }
  }

  // --- COMPLIANCE MATRIX MIGRATION (idempotent) ---
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS compliance_items (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref_number            TEXT NOT NULL,
        title                 TEXT NOT NULL,
        source_type           TEXT NOT NULL,
        issuing_authority     TEXT,
        category              TEXT,
        issue_date            TEXT,
        effective_date        TEXT,
        review_date           TEXT,
        compliance_status     TEXT NOT NULL DEFAULT 'under_review',
        maturity_score        INTEGER CHECK(maturity_score BETWEEN 0 AND 100),
        gap_notes             TEXT,
        responsible_person_id UUID REFERENCES users(id),
        department_id         UUID REFERENCES org_entities(id),
        description           TEXT,
        keywords              TEXT,
        version               TEXT,
        attachment_path       TEXT,
        created_by            UUID REFERENCES users(id),
        created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        deleted_at            TIMESTAMPTZ
      )
    `).run();

    // Ensure columns added in the expanded schema exist (handles case where
    // the table was created from the older, minimal definition above)
    const addColumnIfNotExists = [
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS source_type TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS category TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS effective_date TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS review_date TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS maturity_score INTEGER`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS gap_notes TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES org_entities(id)`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS description TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS keywords TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS version TEXT`,
      `ALTER TABLE compliance_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    ];
    for (const ddl of addColumnIfNotExists) {
      try { await db.prepare(ddl).run(); } catch (_) { /* column already exists */ }
    }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS finding_compliance (
        finding_id     UUID NOT NULL REFERENCES audit_findings(id),
        compliance_id  UUID NOT NULL REFERENCES compliance_items(id),
        PRIMARY KEY (finding_id, compliance_id)
      )
    `).run();

    // Only seed data if compliance_items is empty (first-time migration)
    const complianceCount = await db.prepare("SELECT count(*) as count FROM compliance_items").get() as any;
    if (complianceCount && complianceCount.count === 0) {
      console.log("[MIGRATION] Seeding compliance_items from existing data...");

      await db.prepare(`
        INSERT INTO compliance_items
          (ref_number, title, source_type, issuing_authority, category,
           issue_date, description, compliance_status, created_at)
        SELECT
          COALESCE(reference_number, 'REF-' || id::text),
          title,
          'cbi_instruction',
          'البنك المركزي العراقي',
          category,
          NULLIF(issue_date, '')::date,
          description,
          CASE WHEN status = 'Active' THEN 'compliant' ELSE 'under_review' END,
          CURRENT_TIMESTAMP
        FROM central_bank_instructions
        WHERE title IS NOT NULL
      `).run();

      await db.prepare(`
        INSERT INTO compliance_items
          (ref_number, title, source_type, issuing_authority,
           issue_date, keywords, compliance_status, created_at)
        SELECT
          'LAW-' || id::text,
          title,
          'law',
          authority,
          NULLIF(issue_date, '')::date,
          keywords,
          'under_review',
          CURRENT_TIMESTAMP
        FROM law_bank
        WHERE title IS NOT NULL
      `).run();

      await db.prepare(`
        INSERT INTO compliance_items
          (ref_number, title, source_type, version,
           issue_date, attachment_path, compliance_status, created_at)
        SELECT
          'POL-' || id::text,
          title,
          'internal_policy',
          version,
          NULLIF(upload_date, '')::date,
          file_url,
          CASE WHEN status = 'Active' THEN 'compliant' ELSE 'under_review' END,
          CURRENT_TIMESTAMP
        FROM internal_policies
        WHERE title IS NOT NULL
      `).run();

      console.log("[MIGRATION] Compliance items seeded successfully.");
    }
  } catch (e) {
    console.error("Error creating compliance matrix tables:", e);
  }
  // --- COMPLIANCE MATRIX MIGRATION END ---

  // Phase 3: No longer dropping any tables to be safe
  try {
    // Keep tables
  } catch (e) {
    console.warn("Could not drop legacy tables:", e);
  }

  // Seed Roles and Permissions if missing
  try {
    const rolesCount = await db.prepare("SELECT count(*) as count FROM roles").get();
    if (rolesCount && (rolesCount as any).count === 0) {
      console.log("[SEED] Seeding default roles and permissions...");
      
      // 1. Seed All Possible Permissions
      const permissionMap: Record<string, string> = {};
      for (const module of Object.values(MODULES)) {
        for (const action of Object.values(PERMISSIONS)) {
          const res = await db.prepare(
            "INSERT INTO permissions (module, action, description) VALUES (?, ?, ?) ON CONFLICT (module, action) DO UPDATE SET module=EXCLUDED.module RETURNING id"
          ).run(module, action, `${action} permission for ${module}`);
          
          if (res && res.lastInsertRowid) {
            permissionMap[`${module}:${action}`] = String(res.lastInsertRowid);
          }
        }
      }

      // 2. Seed Roles and Link to Permissions
      for (const [roleName, rolePerms] of Object.entries(DEFAULT_PERMISSIONS)) {
        console.log(`[SEED] Seeding role: ${roleName}`);
        const roleRes = await db.prepare(
          "INSERT INTO roles (name, description) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id"
        ).run(roleName, `${roleName} default system role`);
        
        const roleId = roleRes.lastInsertRowid;

        if (roleId) {
          for (const [module, actions] of Object.entries(rolePerms)) {
            for (const action of actions) {
              const permissionId = permissionMap[`${module}:${action}`];
              if (permissionId) {
                await db.prepare(
                  "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
                ).run(roleId, permissionId);
              }
            }
          }
        }
      }
      console.log("[SEED] Roles and permissions seeding completed.");
    }
  } catch (seedError) {
    console.error("[SEED] Error during roles/permissions seeding:", seedError);
  }

  // Seed default Users (Admin and Test)
  try {
    const bcryptModule = await import("bcryptjs");
    const bcrypt = bcryptModule.default || bcryptModule;
    const password = "admin";
    const hashedPassword = bcrypt.hashSync(password, 12);

    // 1. Seed Admin
    const adminExists = await db.prepare("SELECT * FROM users WHERE username = 'admin' LIMIT 1").get();
    if (!adminExists) {
      console.log("[SEED] Admin user not found. Seeding...");
      const adminRole = await db.prepare("SELECT id FROM roles WHERE name = ?").get(ROLES.ADMIN);
      const roleId = adminRole ? adminRole.id : null;
      console.log(`[SEED] Admin Role ID: ${roleId}`);

      await db.prepare(`
        INSERT INTO users (username, password, name, role, role_id, department, status, created_at) 
        VALUES ('admin', ?, 'System Administrator', 'Admin', ?, 'Management', 'active', CURRENT_TIMESTAMP)
      `).run(hashedPassword, roleId);
      console.log("[SEED] Default admin user seeded.");
    } else {
      console.log("[SEED] Admin user already exists. Checking role_id...");
      // Update role_id if missing or incorrect
      const adminRole = await db.prepare("SELECT id FROM roles WHERE name = ?").get(ROLES.ADMIN);
      if (adminRole && adminRole.id) {
        console.log(`[SEED] Found Admin Role ID: ${adminRole.id}. Updating admin user...`);
        const result = await db.prepare("UPDATE users SET role_id = ? WHERE username = 'admin' AND (role_id IS NULL OR role_id != ?)").run(adminRole.id, adminRole.id);
        console.log(`[SEED] Admin update rows: ${result.changes}`);
      }
    }

    // 2. Seed Test User
    const testExists = await db.prepare("SELECT id FROM users WHERE username = 'test' LIMIT 1").get();
    if (!testExists) {
      console.log("[SEED] Test user not found. Seeding...");
      const testHashedPassword = bcrypt.hashSync("test", 12);
      const auditorRole = await db.prepare("SELECT id FROM roles WHERE name = ?").get(ROLES.INTERNAL_AUDITOR);
      const roleId = auditorRole ? auditorRole.id : null;
      console.log(`[SEED] Test User Role ID: ${roleId}`);

      await db.prepare(`
        INSERT INTO users (username, password, name, role, role_id, department, status, created_at) 
        VALUES ('test', ?, 'Test Auditor', 'Internal Auditor', ?, 'Audit', 'active', CURRENT_TIMESTAMP)
      `).run(testHashedPassword, roleId);
      console.log("[SEED] Default test user seeded.");
    } else {
      console.log("[SEED] Test user exists.");
    }
  } catch (e) {
    console.error("Error seeding default users:", e);
  }

  // Audit trail immutability trigger
  try {
    await db.exec(`
      CREATE OR REPLACE FUNCTION prevent_audit_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Audit trail records cannot be modified or deleted';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_trail_immutable') THEN
          CREATE TRIGGER audit_trail_immutable
          BEFORE UPDATE OR DELETE ON audit_trail
          FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
        END IF;
      END $$;
    `);
    console.log("[MIGRATION] Audit trail immutability trigger created.");
  } catch (e) {
    console.warn("[MIGRATION] Could not create audit trail trigger (may not be supported in PGlite):", (e as any)?.message);
  }

  console.log("Migrations completed successfully.");
};

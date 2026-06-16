-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║               ALSAQI - نظام الساقي لإدارة التدقيق الداخلي                  ║
-- ║                   PostgreSQL Database Schema v1.0                           ║
-- ║                                                                            ║
-- ║  تاريخ الإنشاء: 2025                                                       ║
-- ║  الإصدار: PostgreSQL 15+                                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ============================================================================
-- المرحلة 0: الامتدادات والإعدادات الأولية
-- Phase 0: Extensions & Initial Setup
-- ============================================================================

-- لا حاجة لامتداد uuid-ossp لأن gen_random_uuid() متوفرة أصلاً في PG 13+
-- pgcrypto needed only if using crypt() for password hashing at DB level

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- Create schema
CREATE SCHEMA IF NOT EXISTS public;
COMMENT ON SCHEMA public IS 'مخطط قاعدة بيانات نظام الساقي - ALSAQI Audit Management System';

-- ============================================================================
-- المرحلة 1: الجداول الأساسية المستقلة (لا تعتمد على جداول أخرى)
-- Phase 1: Independent Base Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول المستخدمين
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id TEXT UNIQUE,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    department TEXT,
    role TEXT NOT NULL DEFAULT 'Viewer'
        CHECK (role IN ('Admin', 'Internal Auditor', 'Compliance Officer', 'Risk Officer', 'Manager', 'Viewer')),
    status TEXT NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive', 'Suspended')),
    last_login TIMESTAMPTZ,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    profile_picture TEXT,
    language TEXT NOT NULL DEFAULT 'ar'
        CHECK (language IN ('ar', 'en')),
    theme TEXT NOT NULL DEFAULT 'light'
        CHECK (theme IN ('light', 'dark')),
    dashboard_layout TEXT DEFAULT 'standard',
    notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    job_title_id UUID,
    role_id UUID,
    unit TEXT,
    reporting_manager_id UUID,
    access_scope TEXT DEFAULT 'Department'
        CHECK (access_scope IN ('Global', 'Department', 'Unit')),
    phone_number TEXT,
    notes TEXT,
    session_version INTEGER NOT NULL DEFAULT 1,
    requires_password_change BOOLEAN NOT NULL DEFAULT FALSE,
    requires_2fa_setup BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE users IS 'جدول المستخدمين - يحتوي على جميع حسابات المستخدمين في النظام';
COMMENT ON COLUMN users.employee_id IS 'الرقم الوظيفي للموظف';
COMMENT ON COLUMN users.session_version IS 'إصدار الجلسة - يتم زيادته لإبطال جميع الجلسات';
COMMENT ON COLUMN users.access_scope IS 'نطاق الصلاحية: عام، إدارة، وحدة';
COMMENT ON COLUMN users.requires_2fa_setup IS 'يتطلب إعداد المصادقة الثنائية عند تسجيل الدخول التالي';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الأدوار
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_custom BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE roles IS 'جدول الأدوار - يحدد أدوار المستخدمين في النظام';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الصلاحيات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT,
    UNIQUE (module, action)
);

COMMENT ON TABLE permissions IS 'جدول الصلاحيات - يحدد الإجراءات المتاحة لكل وحدة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الهيكل التنظيمي
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_code TEXT UNIQUE NOT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT,
    entity_type TEXT NOT NULL
        CHECK (entity_type IN ('Top Management', 'Department', 'Division', 'Unit', 'Branch', 'Office', 'Committee', 'Other')),
    parent_id UUID REFERENCES org_entities(id),
    manager_id UUID REFERENCES users(id),
    manager_name TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Inactive', 'Archived')),
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    cost_center_code TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE org_entities IS 'جدول الكيانات التنظيمية - الهيكل الهرمي للمؤسسة';
COMMENT ON COLUMN org_entities.entity_type IS 'نوع الكيان: إدارة عليا، إدارة، قسم، وحدة، فرع، مكتب، لجنة';
COMMENT ON COLUMN org_entities.level IS 'المستوى في الهيكل الهرمي (1 = الأعلى)';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الأقسام (مبسط)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE departments IS 'جدول الأقسام - قائمة بسيطة بالأقسام';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول المسميات الوظيفية
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_titles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    job_level TEXT NOT NULL,
    description TEXT,
    reporting_to UUID REFERENCES job_titles(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE job_titles IS 'جدول المسميات الوظيفية';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول إعدادات التطبيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
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
);

COMMENT ON TABLE app_settings IS 'إعدادات التطبيق - سجل واحد فقط (singleton)';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول إعدادات إدارة المستخدمين
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_management_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    failed_login_threshold INTEGER NOT NULL DEFAULT 3,
    inactive_account_threshold_days INTEGER NOT NULL DEFAULT 90,
    password_min_length INTEGER NOT NULL DEFAULT 8,
    password_require_uppercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_lowercase BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_numbers BOOLEAN NOT NULL DEFAULT TRUE,
    password_require_symbols BOOLEAN NOT NULL DEFAULT TRUE,
    password_expiry_days INTEGER NOT NULL DEFAULT 90,
    enforce_single_session BOOLEAN NOT NULL DEFAULT FALSE,
    session_timeout_minutes INTEGER NOT NULL DEFAULT 30,
    bulk_import_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    admin_approval_required BOOLEAN NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE user_management_settings IS 'إعدادات سياسات إدارة المستخدمين - سجل واحد فقط';


-- ============================================================================
-- المرحلة 2: جداول التدقيق الأساسية
-- Phase 2: Core Audit Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول برامج التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_code TEXT UNIQUE,
    program_title TEXT NOT NULL,
    audit_area TEXT,
    department TEXT,
    audit_type TEXT NOT NULL
        CHECK (audit_type IN ('Operational', 'Financial', 'Compliance', 'IT', 'AML', 'Governance')),
    audit_objective TEXT,
    audit_scope TEXT,
    key_risks TEXT,
    control_objectives TEXT,
    reference_standard TEXT,
    status TEXT NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Active', 'Archived', 'Draft', 'Submitted', 'Approved')),
    version_number INTEGER NOT NULL DEFAULT 1,
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_programs IS 'جدول برامج التدقيق - يحدد نطاق وأهداف كل برنامج تدقيق';
COMMENT ON COLUMN audit_programs.audit_type IS 'نوع التدقيق: تشغيلي، مالي، امتثال، تقنية معلومات، غسل أموال، حوكمة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول خطط التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_code TEXT UNIQUE,
    program_id UUID REFERENCES audit_programs(id),
    title TEXT NOT NULL,
    department TEXT,
    type TEXT
        CHECK (type IN ('Operational', 'Financial', 'Compliance', 'IT', 'AML', 'Governance')),
    risk_rating TEXT
        CHECK (risk_rating IN ('Low', 'Medium', 'High', 'Critical')),
    planned_start_date DATE,
    planned_end_date DATE,
    status TEXT NOT NULL DEFAULT 'Planned'
        CHECK (status IN ('Planned', 'Fieldwork', 'Reporting', 'Closed')),
    lead_auditor TEXT,
    team_members TEXT,
    objectives TEXT,
    scope TEXT,
    notes TEXT,
    year INTEGER,
    quarter TEXT DEFAULT 'Annual'
        CHECK (quarter IN ('Q1', 'Q2', 'Q3', 'Q4', 'Annual')),
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    archived_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_plans IS 'جدول خطط التدقيق - الخطط السنوية والربعية';
COMMENT ON COLUMN audit_plans.year IS 'سنة الخطة';
COMMENT ON COLUMN audit_plans.quarter IS 'الربع: Q1-Q4 أو سنوي';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل المخاطر
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_register (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    risk_id TEXT UNIQUE,
    description TEXT NOT NULL,
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
    status TEXT NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Mitigated', 'Closed')),
    target_date DATE,
    review_date DATE,
    notes TEXT,
    entry_date DATE,
    entered_by TEXT,
    -- Calculated risk scoring (1-5 scale)
    likelihood_num INTEGER CHECK (likelihood_num BETWEEN 1 AND 5),
    impact_num INTEGER CHECK (impact_num BETWEEN 1 AND 5),
    risk_score_calc INTEGER GENERATED ALWAYS AS (likelihood_num * impact_num) STORED,
    risk_level_calc TEXT GENERATED ALWAYS AS (
        CASE
            WHEN likelihood_num * impact_num >= 20 THEN 'Critical'
            WHEN likelihood_num * impact_num >= 12 THEN 'High'
            WHEN likelihood_num * impact_num >= 6 THEN 'Medium'
            ELSE 'Low'
        END
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE risk_register IS 'سجل المخاطر - جميع المخاطر المحددة مع التقييم والمعالجة';
COMMENT ON COLUMN risk_register.risk_score_calc IS 'درجة المخاطرة المحسوبة تلقائياً = الاحتمالية × الأثر';
COMMENT ON COLUMN risk_register.risk_level_calc IS 'مستوى المخاطرة المحسوب تلقائياً بناءً على الدرجة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول تعليمات البنك المركزي
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_bank_instructions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    issue_date DATE,
    reference_number TEXT,
    category TEXT,
    description TEXT,
    related_department TEXT,
    attachment TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    related_instruction_id UUID REFERENCES central_bank_instructions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE central_bank_instructions IS 'تعليمات البنك المركزي - التعليمات والتعاميم الرقابية';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول عناصر الامتثال
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_number TEXT NOT NULL,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    issuing_authority TEXT,
    category TEXT,
    issue_date TEXT,
    effective_date TEXT,
    review_date TEXT,
    compliance_status TEXT NOT NULL DEFAULT 'under_review'
        CHECK (compliance_status IN ('compliant', 'non_compliant', 'under_review')),
    maturity_score INTEGER CHECK (maturity_score BETWEEN 0 AND 100),
    gap_notes TEXT,
    responsible_person_id UUID REFERENCES users(id),
    department_id UUID REFERENCES org_entities(id),
    description TEXT,
    keywords TEXT,
    version TEXT,
    attachment_path TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE compliance_items IS 'عناصر الامتثال - متابعة الالتزام بالتعليمات والقوانين';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول بنك القوانين
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS law_bank (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    type TEXT,
    authority TEXT,
    issue_date DATE,
    keywords TEXT,
    bookmarked BOOLEAN NOT NULL DEFAULT FALSE,
    file_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE law_bank IS 'بنك القوانين - المكتبة القانونية المرجعية';


-- ============================================================================
-- المرحلة 3: الجداول المعتمدة على المرحلة 1 و 2
-- Phase 3: Dependent Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول إجراءات التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_procedures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES audit_programs(id),
    procedure_number TEXT,
    audit_step TEXT NOT NULL,
    audit_test_description TEXT,
    risk_addressed TEXT,
    control_test_type TEXT
        CHECK (control_test_type IN ('Walkthrough', 'Inspection', 'Observation', 'Recalculation', 'Reperformance', 'Inquiry', 'Analytical Review')),
    expected_evidence TEXT,
    sampling_method TEXT,
    responsible_auditor TEXT,
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE audit_procedures IS 'إجراءات التدقيق - خطوات الاختبار ضمن برنامج التدقيق';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول مهام التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_number VARCHAR(30) UNIQUE NOT NULL,
    title TEXT NOT NULL,
    plan_id UUID REFERENCES audit_plans(id),
    program_id UUID REFERENCES audit_programs(id),
    task_type VARCHAR(20) NOT NULL DEFAULT 'audit_plan'
        CHECK (task_type IN ('audit_plan', 'routine')),
    audit_type TEXT NOT NULL
        CHECK (audit_type IN ('Operational', 'Financial', 'Compliance', 'IT', 'AML', 'Governance')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_progress', 'review', 'approved', 'completed')),
    assigned_to UUID REFERENCES users(id),
    audited_unit_id UUID REFERENCES org_entities(id),
    planned_hours INTEGER,
    actual_hours INTEGER NOT NULL DEFAULT 0,
    period_from DATE,
    period_to DATE,
    due_date DATE,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_tasks IS 'مهام التدقيق - المهام المرتبطة بخطط التدقيق أو المهام الروتينية';
COMMENT ON COLUMN audit_tasks.task_type IS 'نوع المهمة: audit_plan = مرتبطة بخطة, routine = روتينية';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول ملاحظات التدقيق (النتائج)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID REFERENCES audit_plans(id),
    finding_number VARCHAR(50) UNIQUE,
    title TEXT NOT NULL,
    finding_type TEXT NOT NULL DEFAULT 'control_design_deficiency'
        CHECK (finding_type IN ('control_design_deficiency', 'control_operating_deficiency', 'compliance_violation', 'process_gap', 'other')),
    description TEXT,
    criteria TEXT,
    condition TEXT,
    cause TEXT,
    consequence TEXT,
    impact TEXT,
    root_cause TEXT,
    recommendation TEXT,
    risk_level TEXT
        CHECK (risk_level IN ('Low', 'Medium', 'High', 'Critical')),
    status TEXT NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'In Progress', 'Closed')),
    responsible_unit_id UUID REFERENCES org_entities(id),
    risk_id UUID REFERENCES risk_register(id),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_findings IS 'ملاحظات التدقيق - النتائج والملاحظات المكتشفة أثناء التدقيق';
COMMENT ON COLUMN audit_findings.finding_type IS 'نوع الملاحظة: قصور في تصميم الرقابة، قصور في تشغيل الرقابة، مخالفة امتثال، فجوة إجرائية';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول التوصيات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finding_id UUID NOT NULL REFERENCES audit_findings(id),
    plan_id UUID REFERENCES audit_plans(id),
    rec_number VARCHAR(70) UNIQUE,
    department TEXT,
    responsible TEXT,
    responsible_person_id UUID REFERENCES users(id),
    action_plan TEXT,
    due_date DATE,
    follow_up_date DATE,
    status TEXT NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'In Progress', 'Implemented', 'Overdue')),
    risk_level TEXT
        CHECK (risk_level IN ('Low', 'Medium', 'High')),
    priority TEXT DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    closure_evidence_path TEXT,
    closed_by UUID REFERENCES users(id),
    closed_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE recommendations IS 'التوصيات - الإجراءات التصحيحية المطلوبة لمعالجة الملاحظات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أدلة التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID REFERENCES audit_plans(id),
    finding_id UUID REFERENCES audit_findings(id),
    evidence_number TEXT,
    type TEXT
        CHECK (type IN ('Document', 'Email', 'Screenshot', 'System Log', 'Contract')),
    description TEXT,
    uploaded_by TEXT,
    upload_date DATE,
    file_name TEXT,
    file_path TEXT,
    file_data TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_evidence IS 'أدلة التدقيق - المستندات والأدلة الداعمة للملاحظات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول تقارير التدقيق
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID REFERENCES audit_plans(id),
    title TEXT NOT NULL,
    report_type TEXT,
    generated_by TEXT,
    date_generated DATE,
    status TEXT NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Final')),
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE audit_reports IS 'تقارير التدقيق - التقارير النهائية والمسودات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل الاحتيال
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_date DATE,
    description TEXT,
    reported_by TEXT,
    status TEXT DEFAULT 'Open'
        CHECK (status IN ('Open', 'Under Investigation', 'Closed', 'Escalated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE fraud_log IS 'سجل الاحتيال - تتبع حالات الاحتيال المبلغ عنها';


-- ============================================================================
-- المرحلة 4: جداول الربط والعلاقات
-- Phase 4: Junction/Relationship Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ربط الأدوار بالصلاحيات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

COMMENT ON TABLE role_permissions IS 'ربط الأدوار بالصلاحيات - يحدد صلاحيات كل دور';

-- ─────────────────────────────────────────────────────────────────────────────
-- صلاحيات المستخدم المخصصة (Override)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_permissions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (user_id, permission_id)
);

COMMENT ON TABLE user_permissions IS 'صلاحيات المستخدم المخصصة - تجاوز صلاحيات الدور';

-- ─────────────────────────────────────────────────────────────────────────────
-- ربط الملاحظات بالمخاطر
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finding_risks (
    finding_id UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
    risk_id UUID NOT NULL REFERENCES risk_register(id),
    PRIMARY KEY (finding_id, risk_id)
);

COMMENT ON TABLE finding_risks IS 'ربط الملاحظات بالمخاطر - العلاقة بين ملاحظات التدقيق وسجل المخاطر';

-- ─────────────────────────────────────────────────────────────────────────────
-- ربط الملاحظات بالامتثال
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finding_compliance (
    finding_id UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
    compliance_id UUID NOT NULL REFERENCES compliance_items(id),
    PRIMARY KEY (finding_id, compliance_id)
);

COMMENT ON TABLE finding_compliance IS 'ربط الملاحظات بعناصر الامتثال';

-- ─────────────────────────────────────────────────────────────────────────────
-- تعيين مهام التدقيق (متعدد المدققين)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES audit_tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id),
    UNIQUE (task_id, user_id)
);

COMMENT ON TABLE task_assignments IS 'تعيينات المهام - ربط المهام بعدة مدققين';

-- ─────────────────────────────────────────────────────────────────────────────
-- ربط البرامج بالمخاطر
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS program_risk_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES audit_programs(id) ON DELETE CASCADE,
    risk_id UUID NOT NULL REFERENCES risk_register(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (program_id, risk_id)
);

COMMENT ON TABLE program_risk_links IS 'ربط برامج التدقيق بالمخاطر المعنية';

-- ─────────────────────────────────────────────────────────────────────────────
-- ربط البرامج بعناصر الامتثال
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS program_compliance_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id UUID NOT NULL REFERENCES audit_programs(id) ON DELETE CASCADE,
    compliance_item_id UUID NOT NULL REFERENCES compliance_items(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (program_id, compliance_item_id)
);

COMMENT ON TABLE program_compliance_links IS 'ربط برامج التدقيق بعناصر الامتثال';

-- ─────────────────────────────────────────────────────────────────────────────
-- عداد الترقيم الموحد
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS numbering_counters (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    last_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_type, scope_id)
);

COMMENT ON TABLE numbering_counters IS 'عدادات الترقيم الهرمي - لإنشاء أرقام متسلسلة لكل نطاق';
COMMENT ON COLUMN numbering_counters.scope_type IS 'نوع النطاق: plan_year, task, finding, rec, evidence';
COMMENT ON COLUMN numbering_counters.scope_id IS 'معرف النطاق: السنة أو معرف الخطة أو معرف الملاحظة';


-- ============================================================================
-- المرحلة 5: جداول المراسلات
-- Phase 5: Correspondence Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول المراسلات الواردة
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incoming_correspondence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_number TEXT UNIQUE NOT NULL,
    letter_number TEXT,
    sender_entity TEXT NOT NULL,
    sender_entity_type TEXT
        CHECK (sender_entity_type IN ('Government', 'Private', 'Internal', 'Regulatory')),
    subject TEXT NOT NULL,
    letter_date DATE,
    receipt_date DATE,
    registration_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    classification TEXT
        CHECK (classification IN ('General', 'Audit Related', 'Compliance', 'Administrative', 'Financial', 'HR Related')),
    priority TEXT NOT NULL DEFAULT 'Normal'
        CHECK (priority IN ('Normal', 'Urgent', 'Very Urgent', 'Confidential', 'Restricted')),
    method TEXT
        CHECK (method IN ('Official Mail', 'Hand Delivery', 'Electronic System', 'Email')),
    receiving_dept_id UUID REFERENCES org_entities(id),
    assigned_dept_id UUID REFERENCES org_entities(id),
    assigned_user_id UUID REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'Received'
        CHECK (status IN ('Received', 'Registered', 'Under Review', 'Referred', 'Action Taken', 'Closed', 'Archived', 'Cancelled')),
    follow_up_required BOOLEAN NOT NULL DEFAULT FALSE,
    follow_up_date DATE,
    response_required BOOLEAN NOT NULL DEFAULT FALSE,
    response_due_date DATE,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE incoming_correspondence IS 'المراسلات الواردة - الخطابات والمراسلات المستلمة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول المراسلات الصادرة
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outgoing_correspondence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_number TEXT UNIQUE NOT NULL,
    official_number TEXT UNIQUE,
    letter_date DATE,
    registration_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recipient_entity TEXT NOT NULL,
    recipient_entity_type TEXT
        CHECK (recipient_entity_type IN ('Government', 'Private', 'Internal', 'Regulatory')),
    subject TEXT NOT NULL,
    classification TEXT
        CHECK (classification IN ('General', 'Audit Related', 'Compliance', 'Administrative', 'Financial', 'HR Related')),
    priority TEXT NOT NULL DEFAULT 'Normal'
        CHECK (priority IN ('Normal', 'Urgent', 'Very Urgent', 'Confidential', 'Restricted')),
    method TEXT
        CHECK (method IN ('Official Mail', 'Hand Delivery', 'Electronic System', 'Email')),
    status TEXT NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Pending Approval', 'Approved', 'Sent', 'Delivered', 'Archived', 'Cancelled')),
    source_dept_id UUID REFERENCES org_entities(id),
    sent_date TIMESTAMPTZ,
    delivery_ref TEXT,
    recipient_contact TEXT,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE outgoing_correspondence IS 'المراسلات الصادرة - الخطابات والمراسلات المرسلة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول مرفقات المراسلات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correspondence_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correspondence_id UUID NOT NULL,
    correspondence_type TEXT NOT NULL
        CHECK (correspondence_type IN ('Incoming', 'Outgoing')),
    file_name TEXT NOT NULL,
    file_type TEXT,
    file_data TEXT,
    description TEXT,
    uploaded_by UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id)
);

COMMENT ON TABLE correspondence_attachments IS 'مرفقات المراسلات - الملفات المرفقة بالمراسلات الواردة والصادرة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول إحالات المراسلات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correspondence_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incoming_id UUID NOT NULL REFERENCES incoming_correspondence(id),
    from_user_id UUID NOT NULL REFERENCES users(id),
    to_dept_id UUID REFERENCES org_entities(id),
    to_user_id UUID REFERENCES users(id),
    referral_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Acknowledged', 'Completed', 'Returned'))
);

COMMENT ON TABLE correspondence_referrals IS 'إحالات المراسلات - تتبع إحالة المراسلات الواردة بين الإدارات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول روابط المراسلات (وارد ↔ صادر)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correspondence_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incoming_id UUID NOT NULL REFERENCES incoming_correspondence(id),
    outgoing_id UUID NOT NULL REFERENCES outgoing_correspondence(id),
    link_type TEXT NOT NULL DEFAULT 'Reply'
        CHECK (link_type IN ('Reply', 'Follow-up', 'Related')),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    linked_by UUID REFERENCES users(id),
    UNIQUE (incoming_id, outgoing_id)
);

COMMENT ON TABLE correspondence_links IS 'روابط المراسلات - ربط الخطابات الواردة بالردود الصادرة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل حالات المراسلات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correspondence_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correspondence_id UUID NOT NULL,
    correspondence_type TEXT NOT NULL
        CHECK (correspondence_type IN ('Incoming', 'Outgoing')),
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by UUID REFERENCES users(id),
    change_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

COMMENT ON TABLE correspondence_status_history IS 'سجل تغييرات حالات المراسلات - يحفظ تاريخ كل تغيير';


-- ============================================================================
-- المرحلة 6: جداول النظام والأمان
-- Phase 6: System & Security Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل التدقيق (Audit Trail) - مقسم شهرياً في الإنتاج
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_trail (
    id UUID DEFAULT gen_random_uuid(),
    "user" TEXT NOT NULL,
    action TEXT NOT NULL,
    module TEXT NOT NULL,
    details TEXT,
    -- Tamper-evident hash-chain columns. AuditChainService is the sole writer:
    -- each entry stores its SHA-256 `hash` over its content + the `previous_hash`
    -- (the hash of the prior entry), and `seq` is a strictly-increasing insertion
    -- sequence used as the deterministic chain-ordering tiebreaker.
    hash TEXT,
    previous_hash TEXT,
    seq BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

COMMENT ON TABLE audit_trail IS 'سجل التدقيق - يسجل جميع العمليات في النظام (مقسم شهرياً)';

-- إنشاء أقسام الأشهر (يجب تحديثها دورياً عبر cron job)
-- مثال: إنشاء قسم لشهر يناير 2025
-- CREATE TABLE audit_trail_y2025m01
--     PARTITION OF audit_trail
--     FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الإشعارات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    title TEXT,
    description TEXT NOT NULL,
    related_module TEXT,
    link TEXT,
    entity_id TEXT,
    entity_type TEXT,
    actor_id UUID REFERENCES users(id),
    data JSONB,
    status TEXT NOT NULL DEFAULT 'Unread'
        CHECK (status IN ('Read', 'Unread')),
    date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE notifications IS 'الإشعارات - إشعارات النظام للمستخدمين';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول مستلمي الإشعارات (عزل لكل مستخدم)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    is_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE notification_recipients IS 'مستلمو الإشعارات - تتبع حالة القراءة لكل مستلم';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الجلسات النشطة
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    refresh_token TEXT,
    login_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active', 'Terminated', 'Expired')),
    ip_address TEXT,
    device TEXT,
    browser TEXT
);

COMMENT ON TABLE user_sessions IS 'جلسات المستخدمين النشطة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول رموز التحديث (Refresh Tokens)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ
);

COMMENT ON TABLE refresh_tokens IS 'رموز التحديث - JWT refresh tokens لتجديد الجلسات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل تسجيل الدخول
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    username TEXT,
    login_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    logout_time TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT,
    device TEXT,
    browser TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('Success', 'Failed', 'Locked')),
    failure_reason TEXT
);

COMMENT ON TABLE login_history IS 'سجل تسجيل الدخول - يحفظ جميع محاولات الدخول';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل كلمات المرور
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE password_history IS 'سجل كلمات المرور - لمنع إعادة استخدام كلمات المرور السابقة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول طلبات إعادة تعيين كلمة المرور
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    request_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE password_reset_requests IS 'طلبات إعادة تعيين كلمة المرور';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول المصادقة الثنائية (TOTP)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_totp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL UNIQUE,
    secret_encrypted TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    enabled_at TIMESTAMPTZ,
    backup_codes_hash TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_totp IS 'المصادقة الثنائية - أسرار TOTP المشفرة وأكواد الاسترداد';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل تغيير الصلاحيات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permission_change_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    changed_by_id UUID NOT NULL REFERENCES users(id),
    old_role TEXT,
    new_role TEXT,
    old_permissions JSONB,
    new_permissions JSONB,
    change_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

COMMENT ON TABLE permission_change_logs IS 'سجل تغيير الصلاحيات - يوثق كل تغيير في أدوار وصلاحيات المستخدمين';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل تدقيق الصلاحيات (Append-only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permission_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL
        CHECK (event_type IN ('role_permission_change', 'user_override_change', 'custom_role_created', 'custom_role_deleted')),
    actor_user_id TEXT NOT NULL,
    target_role_id TEXT,
    target_user_id TEXT,
    old_state JSONB,
    new_state JSONB,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE permission_audit_logs IS 'سجل تدقيق الصلاحيات - سجل للإضافة فقط (append-only) لجميع تغييرات الصلاحيات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل أخطاء النظام
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_error_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message TEXT NOT NULL,
    stack TEXT,
    module TEXT NOT NULL,
    user_id UUID REFERENCES users(id),
    severity TEXT NOT NULL DEFAULT 'error'
        CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    user_agent TEXT,
    url TEXT,
    request_data TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE system_error_log IS 'سجل أخطاء النظام - تتبع الأخطاء والاستثناءات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل الطلبات (HTTP Request Logs)
-- ─────────────────────────────────────────────────────────────────────────────
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE request_logs IS 'سجل طلبات HTTP - تتبع جميع الطلبات الواردة للخادم';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل الوصول للملفات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_access_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    access_type TEXT NOT NULL
        CHECK (access_type IN ('upload', 'download', 'delete', 'view')),
    result TEXT NOT NULL
        CHECK (result IN ('success', 'denied', 'error')),
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE file_access_logs IS 'سجل الوصول للملفات - تدقيق عمليات الملفات';


-- ============================================================================
-- المرحلة 7: جداول الأرشفة والدعم
-- Phase 7: Archive & Support Tables
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أرشفة الخطط
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS archived_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_plan_id UUID NOT NULL,
    plan_data JSONB NOT NULL,
    year INTEGER NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    archived_by UUID REFERENCES users(id)
);

COMMENT ON TABLE archived_plans IS 'أرشيف خطط التدقيق - نسخ JSONB كاملة من الخطط المؤرشفة';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أرشفة المهام
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS archived_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_task_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    task_data JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE archived_tasks IS 'أرشيف مهام التدقيق';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أرشفة الملاحظات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS archived_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_finding_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    finding_data JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE archived_findings IS 'أرشيف ملاحظات التدقيق';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أرشفة التوصيات
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS archived_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_recommendation_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    recommendation_data JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE archived_recommendations IS 'أرشيف التوصيات';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول أرشفة الأدلة
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS archived_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_evidence_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    evidence_data JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE archived_evidence IS 'أرشيف أدلة التدقيق';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول مفاتيح الاستجابة الفريدة (Idempotency)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL,
    user_id UUID NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (idempotency_key, user_id)
);

COMMENT ON TABLE idempotency_keys IS 'مفاتيح الاستجابة الفريدة - لمنع تكرار العمليات عند إعادة الإرسال';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول قائمة الرسائل الميتة (Dead Letter Queue)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    failure_reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retry_count INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE dead_letter_queue IS 'قائمة الرسائل الميتة - الأحداث التي فشلت معالجتها';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول الملفات المشفرة
-- ─────────────────────────────────────────────────────────────────────────────
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
    encrypted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    uploaded_by TEXT NOT NULL,
    module TEXT NOT NULL
        CHECK (module IN ('audit', 'fraud', 'coi', 'correspondence'))
);

COMMENT ON TABLE encrypted_files IS 'الملفات المشفرة - بيانات تشفير الملفات المرفوعة (AES-256-GCM)';

-- ─────────────────────────────────────────────────────────────────────────────
-- جدول سجل النسخ الاحتياطي
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL
        CHECK (status IN ('running', 'success', 'partial', 'failed')),
    type TEXT NOT NULL
        CHECK (type IN ('scheduled', 'manual')),
    size_bytes BIGINT DEFAULT 0,
    tables_count INTEGER DEFAULT 0,
    file_path TEXT,
    error_message TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ
);

COMMENT ON TABLE backup_history IS 'سجل النسخ الاحتياطي - تتبع جميع عمليات النسخ الاحتياطي';

-- ─────────────────────────────────────────────────────────────────────────────
-- جداول متنوعة
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    related_type TEXT NOT NULL,
    related_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE comments IS 'التعليقات - تعليقات عامة مرتبطة بأي كيان في النظام';

CREATE TABLE IF NOT EXISTS system_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_key TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE system_policies IS 'السياسات العامة - محتوى السياسات (مكافحة الاحتيال، تضارب المصالح، إلخ)';

CREATE TABLE IF NOT EXISTS internal_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    department TEXT NOT NULL,
    version TEXT NOT NULL,
    upload_date DATE NOT NULL,
    file_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived', 'draft')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE internal_policies IS 'السياسات الداخلية - الوثائق والسياسات المؤسسية';

CREATE TABLE IF NOT EXISTS conflict_of_interest (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    user_name TEXT NOT NULL,
    declaration_date DATE NOT NULL,
    description TEXT NOT NULL,
    related_party TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE conflict_of_interest IS 'إقرارات تضارب المصالح';

CREATE TABLE IF NOT EXISTS fraud_access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    user_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    request_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE fraud_access_requests IS 'طلبات الوصول لوحدة الاحتيال';

-- ─────────────────────────────────────────────────────────────────────────────
-- جداول إعدادات PDF
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pdf_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    arabic_font_name TEXT NOT NULL DEFAULT 'Simplified Arabic',
    arabic_font_size INTEGER NOT NULL DEFAULT 14,
    heading_font_size INTEGER NOT NULL DEFAULT 16,
    subheading_font_size INTEGER NOT NULL DEFAULT 14,
    table_font_size INTEGER NOT NULL DEFAULT 14,
    rtl_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    margin_top INTEGER NOT NULL DEFAULT 20,
    margin_right INTEGER NOT NULL DEFAULT 20,
    margin_bottom INTEGER NOT NULL DEFAULT 20,
    margin_left INTEGER NOT NULL DEFAULT 20,
    header_template TEXT DEFAULT '',
    footer_template TEXT DEFAULT '',
    logo_position TEXT NOT NULL DEFAULT 'right',
    show_page_number BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE pdf_settings IS 'إعدادات توليد ملفات PDF - singleton';

CREATE TABLE IF NOT EXISTS pdf_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name TEXT NOT NULL,
    template_type TEXT NOT NULL,
    template_type_key VARCHAR(50) NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Approved', 'Archived')),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE pdf_templates IS 'قوالب PDF - قوالب التقارير والخطابات';


-- ============================================================================
-- المرحلة 8: الفهارس (Indexes)
-- Phase 8: Performance Indexes
-- ============================================================================

-- ─── المستخدمون ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department) WHERE department IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id) WHERE role_id IS NOT NULL;

-- ─── الهيكل التنظيمي ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_org_entities_parent_id ON org_entities(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_entities_entity_type ON org_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_org_entities_status ON org_entities(status);

-- ─── برامج التدقيق ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_programs_status ON audit_programs(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_programs_audit_type ON audit_programs(audit_type);
CREATE INDEX IF NOT EXISTS idx_audit_programs_deleted_at ON audit_programs(deleted_at);

-- ─── خطط التدقيق ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_plans_program_id ON audit_plans(program_id);
CREATE INDEX IF NOT EXISTS idx_audit_plans_status ON audit_plans(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_plans_year ON audit_plans(year);
CREATE INDEX IF NOT EXISTS idx_audit_plans_quarter ON audit_plans(quarter);
CREATE INDEX IF NOT EXISTS idx_audit_plans_is_archived ON audit_plans(is_archived);
CREATE INDEX IF NOT EXISTS idx_audit_plans_deleted_at ON audit_plans(deleted_at);

-- ─── مهام التدقيق ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_tasks_plan_id ON audit_tasks(plan_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_tasks_assigned_to ON audit_tasks(assigned_to) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_tasks_status ON audit_tasks(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_tasks_due_date ON audit_tasks(due_date) WHERE deleted_at IS NULL AND status != 'completed';
CREATE INDEX IF NOT EXISTS idx_audit_tasks_deleted_at ON audit_tasks(deleted_at);

-- ─── ملاحظات التدقيق ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_findings_audit_id ON audit_findings(audit_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON audit_findings(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_findings_risk_level ON audit_findings(risk_level) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_findings_created_by ON audit_findings(created_by);
CREATE INDEX IF NOT EXISTS idx_audit_findings_deleted_at ON audit_findings(deleted_at);

-- ─── التوصيات ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_recommendations_finding_id ON recommendations(finding_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recommendations_plan_id ON recommendations(plan_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recommendations_due_date ON recommendations(due_date) WHERE status IN ('Open', 'In Progress');
CREATE INDEX IF NOT EXISTS idx_recommendations_deleted_at ON recommendations(deleted_at);

-- ─── أدلة التدقيق ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_evidence_finding_id ON audit_evidence(finding_id);
CREATE INDEX IF NOT EXISTS idx_audit_evidence_audit_id ON audit_evidence(audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_evidence_deleted_at ON audit_evidence(deleted_at);

-- ─── سجل المخاطر ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_risk_register_status ON risk_register(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_risk_register_rating ON risk_register(rating) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_risk_register_risk_level_calc ON risk_register(risk_level_calc) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_risk_register_deleted_at ON risk_register(deleted_at);

-- ─── تعيينات المهام ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_task_assignments_task_id ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_user_id ON task_assignments(user_id);

-- ─── المراسلات الواردة ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_incoming_corr_status ON incoming_correspondence(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_corr_priority ON incoming_correspondence(priority) WHERE status NOT IN ('Closed', 'Archived');
CREATE INDEX IF NOT EXISTS idx_incoming_corr_assigned_user ON incoming_correspondence(assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_corr_letter_date ON incoming_correspondence(letter_date);
CREATE INDEX IF NOT EXISTS idx_incoming_corr_deleted_at ON incoming_correspondence(deleted_at);

-- ─── المراسلات الصادرة ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_outgoing_corr_status ON outgoing_correspondence(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outgoing_corr_letter_date ON outgoing_correspondence(letter_date);
CREATE INDEX IF NOT EXISTS idx_outgoing_corr_deleted_at ON outgoing_correspondence(deleted_at);

-- ─── الإشعارات ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_recip_user_read ON notification_recipients(recipient_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_recip_user_date ON notification_recipients(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_recip_notif_id ON notification_recipients(notification_id);

-- ─── الجلسات والمصادقة ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id) WHERE status = 'Active';
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_login_history_time ON login_history(login_time DESC);
CREATE INDEX IF NOT EXISTS idx_user_totp_user_id ON user_totp(user_id);

-- ─── سجلات التدقيق ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_permission_audit_actor ON permission_audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_target_role ON permission_audit_logs(target_role_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_target_user ON permission_audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_permission_audit_event_type ON permission_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_permission_audit_timestamp ON permission_audit_logs(timestamp);

-- ─── سجلات الطلبات ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs(status_code);

-- ─── سجل الوصول للملفات ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_file_access_logs_user_id ON file_access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_file_path ON file_access_logs(file_path);
CREATE INDEX IF NOT EXISTS idx_file_access_logs_created_at ON file_access_logs(created_at);

-- ─── مفاتيح الاستجابة الفريدة ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key_user ON idempotency_keys(idempotency_key, user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

-- ─── قائمة الرسائل الميتة ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_event_type ON dead_letter_queue(event_type);
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at ON dead_letter_queue(created_at);

-- ─── الملفات المشفرة ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_encrypted_files_uploaded_by ON encrypted_files(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_encrypted_files_module ON encrypted_files(module);
CREATE INDEX IF NOT EXISTS idx_encrypted_files_key_version ON encrypted_files(key_version);

-- ─── النسخ الاحتياطي ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_backup_history_started_at ON backup_history(started_at);

-- ─── الأرشفة ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_archived_plans_year ON archived_plans(year);
CREATE INDEX IF NOT EXISTS idx_archived_plans_original_id ON archived_plans(original_plan_id);

-- ─── قوالب PDF ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pdf_templates_type_key_status ON pdf_templates(template_type_key, status) WHERE is_default = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_default_per_type ON pdf_templates(template_type_key) WHERE is_default = TRUE AND status = 'Approved';

-- ─── التعليقات ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_comments_related ON comments(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);


-- ============================================================================
-- المرحلة 9: الدوال والمحفزات (Functions & Triggers)
-- Phase 9: Functions & Triggers
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- دالة تحديث updated_at تلقائياً
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_updated_at_column() IS 'تحديث عمود updated_at تلقائياً عند أي تعديل';

-- تطبيق المحفز على جميع الجداول التي تحتوي على updated_at
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN
        SELECT table_name FROM information_schema.columns
        WHERE column_name = 'updated_at'
        AND table_schema = 'public'
        AND table_name NOT LIKE 'archived_%'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW
             EXECUTE FUNCTION update_updated_at_column()',
            tbl, tbl
        );
    END LOOP;
EXCEPTION WHEN OTHERS THEN
    -- Triggers may already exist
    NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- دالة إنشاء أقسام audit_trail الشهرية
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_audit_trail_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    start_date := date_trunc('month', target_date)::DATE;
    end_date := (start_date + INTERVAL '1 month')::DATE;
    partition_name := 'audit_trail_y' || to_char(start_date, 'YYYY') || 'm' || to_char(start_date, 'MM');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_trail FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );

    RETURN partition_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_audit_trail_partition(DATE) IS 'إنشاء قسم جديد لجدول audit_trail لشهر محدد';

-- إنشاء أقسام للأشهر القادمة (3 أشهر مستقبلية)
DO $$
DECLARE
    i INTEGER;
    target DATE;
BEGIN
    FOR i IN -1..3 LOOP
        target := (CURRENT_DATE + (i || ' months')::INTERVAL)::DATE;
        PERFORM create_audit_trail_partition(target);
    END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- دالة الترقيم التسلسلي
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION next_sequence_number(
    p_scope_type TEXT,
    p_scope_id TEXT,
    p_prefix TEXT DEFAULT '',
    p_padding INTEGER DEFAULT 3
)
RETURNS TEXT AS $$
DECLARE
    next_val INTEGER;
BEGIN
    INSERT INTO numbering_counters (scope_type, scope_id, last_value)
    VALUES (p_scope_type, p_scope_id, 1)
    ON CONFLICT (scope_type, scope_id)
    DO UPDATE SET last_value = numbering_counters.last_value + 1
    RETURNING last_value INTO next_val;

    RETURN p_prefix || lpad(next_val::TEXT, p_padding, '0');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION next_sequence_number(TEXT, TEXT, TEXT, INTEGER) IS 'إنشاء رقم تسلسلي جديد ضمن نطاق محدد';

-- أمثلة الاستخدام:
-- SELECT next_sequence_number('plan_year', '2025', 'AP-2025-');  → 'AP-2025-001'
-- SELECT next_sequence_number('task', 'plan-uuid-here', 'T');    → 'T001'
-- SELECT next_sequence_number('finding', 'plan-uuid-here', 'F'); → 'F001'

-- ─────────────────────────────────────────────────────────────────────────────
-- دالة تنظيف السجلات المنتهية الصلاحية
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_expired_records()
RETURNS TABLE(table_name TEXT, deleted_count BIGINT) AS $$
BEGIN
    -- حذف مفاتيح الاستجابة المنتهية
    DELETE FROM idempotency_keys WHERE expires_at < CURRENT_TIMESTAMP;
    RETURN QUERY SELECT 'idempotency_keys'::TEXT, (SELECT count(*) FROM idempotency_keys WHERE expires_at < CURRENT_TIMESTAMP);

    -- حذف رموز التحديث المنتهية
    DELETE FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP;
    RETURN QUERY SELECT 'refresh_tokens'::TEXT, (SELECT count(*) FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP);

    -- إنهاء الجلسات المنتهية (أكثر من 24 ساعة بدون نشاط)
    UPDATE user_sessions SET status = 'Expired'
    WHERE status = 'Active' AND last_activity < CURRENT_TIMESTAMP - INTERVAL '24 hours';
    RETURN QUERY SELECT 'user_sessions'::TEXT, 0::BIGINT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_records() IS 'تنظيف السجلات المنتهية الصلاحية - يُنفذ دورياً عبر cron';

-- ============================================================================
-- المرحلة 10: البيانات الأولية (Seed Data)
-- Phase 10: Initial Seed Data
-- ============================================================================

-- ─── الأدوار الافتراضية ───────────────────────────────────────────────────────
INSERT INTO roles (name, description, is_custom) VALUES
    ('Admin', 'مدير النظام - صلاحيات كاملة', FALSE),
    ('Internal Auditor', 'مدقق داخلي', FALSE),
    ('Compliance Officer', 'مسؤول الامتثال', FALSE),
    ('Risk Officer', 'مسؤول المخاطر', FALSE),
    ('Manager', 'مدير إدارة', FALSE),
    ('Viewer', 'مشاهد فقط - قراءة', FALSE)
ON CONFLICT (name) DO NOTHING;

-- ─── إعدادات التطبيق الافتراضية ──────────────────────────────────────────────
INSERT INTO app_settings (id, app_name, app_version, system_environment, database_type)
VALUES (1, 'نظام الساقي', '1.0.0', 'production', 'PostgreSQL')
ON CONFLICT (id) DO NOTHING;

-- ─── إعدادات إدارة المستخدمين الافتراضية ─────────────────────────────────────
INSERT INTO user_management_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ─── إعدادات PDF الافتراضية ───────────────────────────────────────────────────
INSERT INTO pdf_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ─── سياسة مكافحة الاحتيال ────────────────────────────────────────────────────
INSERT INTO system_policies (policy_key, content) VALUES
    ('fraud_policy', '<h3>سياسة مكافحة الاحتيال والفساد</h3><p>تلتزم المؤسسة بأعلى معايير النزاهة والشفافية.</p>')
ON CONFLICT (policy_key) DO NOTHING;

-- ============================================================================
-- نهاية المخطط
-- End of Schema
-- ============================================================================

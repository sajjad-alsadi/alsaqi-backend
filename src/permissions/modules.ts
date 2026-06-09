/**
 * Module Definitions - Single source of truth for all permission modules.
 *
 * This file registers all 19 existing modules in the ModuleRegistry.
 * Adding a new module = ONE entry here. That's it.
 *
 * Each module defines:
 * - name: PascalCase identifier used in DB, middleware, and frontend
 * - label: Bilingual labels (en/ar) for UI display
 * - actions: Which permission actions this module supports
 * - defaults: Default permissions per built-in role (used for DB seeding & offline fallback)
 * - navigation: Sidebar/navigation configuration (icon, path, order)
 * - fileScope: Whether files can be scoped to this module
 */

import { ModuleRegistry } from './registry';
import { UserRole } from '@alsaqi/shared';

// ─── Dashboard ───────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Dashboard',
  label: { en: 'Dashboard', ar: 'لوحة التحكم' },
  actions: ['View'],
  defaults: {
    [UserRole.ADMIN]: ['View'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'LayoutDashboard',
    path: '/dashboard',
    order: 1,
  },
});

// ─── Analytics ────────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Analytics',
  label: { en: 'Analytics', ar: 'التحليلات' },
  actions: ['View'],
  defaults: {
    [UserRole.ADMIN]: ['View'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  // Navigation removed - merged into Dashboard
});

// ─── Policies ────────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Policies',
  label: { en: 'Internal Policies', ar: 'السياسات الداخلية' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View', 'Create', 'Edit'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  // Navigation removed - merged into ComplianceMatrix
});

// ─── Audit Charter ───────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditCharter',
  label: { en: 'Audit Charter', ar: 'ميثاق التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'BookOpen',
    path: '/charter',
    order: 2,
  },
});

// ─── Audit Plans ─────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditPlans',
  label: { en: 'Audit Plans', ar: 'خطط التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'CalendarRange',
    path: '/plan',
    order: 3,
  },
  fileScope: true,
});

// ─── Audit Tasks ─────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditTasks',
  label: { en: 'Audit Tasks', ar: 'مهام التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'ClipboardCheck',
    path: '/tasks',
    order: 4,
  },
  fileScope: true,
});

// ─── Audit Program Library ───────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditProgramLibrary',
  label: { en: 'Audit Program Library', ar: 'مكتبة برامج التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Library',
    path: '/library',
    order: 5,
  },
});

// ─── Audit Findings ──────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditFindings',
  label: { en: 'Audit Findings', ar: 'ملاحظات التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'FileSearch',
    path: '/findings',
    order: 6,
  },
  fileScope: true,
});

// ─── Audit Evidence ──────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'AuditEvidence',
  label: { en: 'Audit Evidence', ar: 'أدلة التدقيق' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'FileText',
    path: '/evidence',
    order: 7,
  },
  fileScope: true,
});

// ─── Recommendations ─────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Recommendations',
  label: { en: 'Recommendations', ar: 'التوصيات' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'TrendingUp',
    path: '/recommendations',
    order: 8,
  },
  fileScope: true,
});

// ─── Risk Register ───────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'RiskRegister',
  label: { en: 'Risk Register', ar: 'سجل المخاطر' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create', 'Edit'],
    [UserRole.COMPLIANCE_OFFICER]: ['View', 'Edit'],
    [UserRole.RISK_OFFICER]: ['View', 'Create', 'Edit', 'Approve'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'ShieldAlert',
    path: '/risks',
    order: 9,
  },
  fileScope: true,
});

// ─── Compliance Matrix ───────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'ComplianceMatrix',
  label: { en: 'Compliance Matrix', ar: 'مصفوفة الامتثال' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View', 'Create', 'Edit'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'ShieldCheck',
    path: '/compliance-matrix',
    order: 10,
  },
  fileScope: true,
});

// ─── Integrity Management ────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'IntegrityManagement',
  label: { en: 'Integrity Management', ar: 'إدارة النزاهة المؤسسية' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create'],
    [UserRole.COMPLIANCE_OFFICER]: ['View', 'Approve'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: [],
  },
  navigation: {
    icon: 'Scale',
    path: '/integrity',
    order: 11,
  },
  fileScope: true,
});

// ─── Departments ─────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Departments',
  label: { en: 'Departments', ar: 'الأقسام' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Building',
    path: '/departments',
    order: 12,
  },
});

// ─── Reports ─────────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Reports',
  label: { en: 'Reports & Analytics', ar: 'التقارير والتحليلات' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: ['View', 'Approve'],
    [UserRole.INTERNAL_AUDITOR]: ['View', 'Create'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View', 'Create'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'BarChart3',
    path: '/reports',
    order: 13,
  },
  fileScope: true,
});

// ─── Correspondence ──────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Correspondence',
  label: { en: 'Correspondence Management', ar: 'نظام المراسلات' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View', 'Create', 'Edit'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Network',
    path: '/cms',
    order: 14,
  },
  fileScope: true,
});

// ─── Notifications ───────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Notifications',
  label: { en: 'Notifications', ar: 'التنبيهات' },
  actions: ['View'],
  defaults: {
    [UserRole.ADMIN]: ['View'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Bell',
    path: '/notifications',
    order: 15,
  },
});

// ─── User Management ─────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'UserManagement',
  label: { en: 'User Management', ar: 'إدارة المستخدمين' },
  actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
    [UserRole.MANAGER]: [],
    [UserRole.INTERNAL_AUDITOR]: [],
    [UserRole.COMPLIANCE_OFFICER]: [],
    [UserRole.RISK_OFFICER]: [],
    [UserRole.VIEWER]: [],
  },
  navigation: {
    icon: 'Users',
    path: '/users',
    order: 16,
  },
});

// ─── System Logs ─────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'SystemLogs',
  label: { en: 'System Logs', ar: 'سجلات النظام' },
  actions: ['View'],
  defaults: {
    [UserRole.ADMIN]: ['View'],
    [UserRole.MANAGER]: [],
    [UserRole.INTERNAL_AUDITOR]: [],
    [UserRole.COMPLIANCE_OFFICER]: [],
    [UserRole.RISK_OFFICER]: [],
    [UserRole.VIEWER]: [],
  },
  navigation: {
    icon: 'Terminal',
    path: '/system-logs',
    order: 17,
  },
});

// ─── Organizational Structure ────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'OrgStructure',
  label: { en: 'Organizational Structure', ar: 'الهيكل التنظيمي' },
  actions: ['View', 'Create', 'Edit', 'Delete'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Create', 'Edit', 'Delete'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Building2',
    path: '/org-structure',
    order: 18,
    parent: 'Settings',
  },
});

// ─── Settings ────────────────────────────────────────────────────────────────

ModuleRegistry.register({
  name: 'Settings',
  label: { en: 'Settings', ar: 'الإعدادات' },
  actions: ['View', 'Edit'],
  defaults: {
    [UserRole.ADMIN]: ['View', 'Edit'],
    [UserRole.MANAGER]: ['View'],
    [UserRole.INTERNAL_AUDITOR]: ['View'],
    [UserRole.COMPLIANCE_OFFICER]: ['View'],
    [UserRole.RISK_OFFICER]: ['View'],
    [UserRole.VIEWER]: ['View'],
  },
  navigation: {
    icon: 'Settings',
    path: '/settings',
    order: 19,
  },
});

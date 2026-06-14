import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';

export class SettingsService {
  static async getPdfSettings() {
    const settings = await db.prepare("SELECT * FROM pdf_settings WHERE id = 1").get();
    if (!settings) {
      // Return defaults if not found
      return {
        arabic_font_name: "Amiri",
        arabic_font_size: 12,
        heading_font_size: 16,
        subheading_font_size: 14,
        table_font_size: 10,
        rtl_enabled: 1,
        margin_top: 20,
        margin_right: 20,
        margin_bottom: 20,
        margin_left: 20,
        header_template: "",
        footer_template: "",
        logo_position: "Right",
        show_page_number: 1
      };
    }
    return settings;
  }

  static async updatePdfSettings(data: any) {
    const { 
      arabic_font_name, arabic_font_size, heading_font_size, subheading_font_size, 
      table_font_size, rtl_enabled, margin_top, margin_right, margin_bottom, margin_left,
      header_template, footer_template, logo_position, show_page_number
    } = data;
    
    await db.prepare(`UPDATE pdf_settings SET 
      arabic_font_name = ?, arabic_font_size = ?, heading_font_size = ?, subheading_font_size = ?, 
      table_font_size = ?, rtl_enabled = ?, margin_top = ?, margin_right = ?, margin_bottom = ?, margin_left = ?,
      header_template = ?, footer_template = ?, logo_position = ?, show_page_number = ?
      WHERE id = 1`).run(
        arabic_font_name, arabic_font_size, heading_font_size, subheading_font_size, 
        table_font_size, rtl_enabled, margin_top, margin_right, margin_bottom, margin_left,
        header_template, footer_template, logo_position, show_page_number
      );
    return true;
  }

  static async getAppSettings() {
    const settings = await db.prepare("SELECT * FROM app_settings WHERE id = 1").get();
    if (!settings) {
      return {
        app_name: "نظام التدقيق الداخلي",
        app_version: "1.0.0",
        app_description: "نظام متكامل لإدارة عمليات التدقيق الداخلي",
        company_name: "شركة الساقي لخدمات الدفع الإلكتروني",
        system_owner: "الإدارة العليا",
        developer_name: "فريق التطوير",
        release_date: "2026-01-01",
        last_update_date: "2026-03-16",
        support_email: "support@alsaqi.com",
        support_phone: "07700000000",
        official_website: "https://alsaqi.com",
        copyright_notice: "© 2026 شركة الساقي لخدمات الدفع الإلكتروني",
        system_environment: "Production",
        database_type: "PostgreSQL",
        build_number: "1.0.0",
        app_status: "Active"
      };
    }
    return settings;
  }

  static async updateAppSettings(data: any) {
    const { 
      app_name, app_version, app_description, company_name, system_owner, 
      developer_name, release_date, last_update_date, support_email, 
      support_phone, official_website, copyright_notice, system_environment, 
      database_type, build_number, app_status 
    } = data;
    
    await db.prepare(`UPDATE app_settings SET 
      app_name = ?, app_version = ?, app_description = ?, company_name = ?, system_owner = ?, 
      developer_name = ?, release_date = ?, last_update_date = ?, support_email = ?, 
      support_phone = ?, official_website = ?, copyright_notice = ?, system_environment = ?, 
      database_type = ?, build_number = ?, app_status = ? 
      WHERE id = 1`).run(
        app_name, app_version, app_description, company_name, system_owner, 
        developer_name, release_date, last_update_date, support_email, 
        support_phone, official_website, copyright_notice, system_environment, 
        database_type, build_number, app_status
      );
    return true;
  }

  static async getUserManagementSettings() {
    const settings = await db.prepare("SELECT * FROM user_management_settings WHERE id = 1").get();
    if (!settings) {
      return {
        id: 1,
        failed_login_threshold: 3,
        inactive_account_threshold_days: 90,
        password_min_length: 8,
        password_require_uppercase: 1,
        password_require_lowercase: 1,
        password_require_numbers: 1,
        password_require_symbols: 1,
        password_expiry_days: 90,
        enforce_single_session: 0,
        session_timeout_minutes: 30,
        bulk_import_enabled: 1,
        admin_approval_required: 0,
        two_factor_auth: 0
      };
    }
    return settings;
  }

  static async updateUserManagementSettings(data: any) {
    // Partial-update semantics (Req 2.23): merge supplied fields with the currently
    // persisted values. `getUserManagementSettings` returns the persisted row, or a
    // full set of sensible defaults when no row exists yet, so every column has a
    // non-null fallback. We coalesce `provided ?? current` for every field, which
    // guarantees the NOT NULL columns are never written as NULL/undefined while a
    // provided value (including falsy values like 0) is always honored verbatim.
    const current: any = (await this.getUserManagementSettings()) ?? {};

    // NOT NULL columns: provided value, else currently persisted value, else default.
    const failed_login_threshold = data.failed_login_threshold ?? current.failed_login_threshold ?? 3;
    const inactive_account_threshold_days =
      data.inactive_account_threshold_days ?? current.inactive_account_threshold_days ?? 90;
    const password_min_length = data.password_min_length ?? current.password_min_length ?? 8;
    const session_timeout_minutes = data.session_timeout_minutes ?? current.session_timeout_minutes ?? 30;

    // Remaining editable columns (Req 2.16): coalesce provided value with persisted/default.
    const password_require_uppercase = data.password_require_uppercase ?? current.password_require_uppercase ?? 1;
    const password_require_lowercase = data.password_require_lowercase ?? current.password_require_lowercase ?? 1;
    const password_require_numbers = data.password_require_numbers ?? current.password_require_numbers ?? 1;
    const password_require_symbols = data.password_require_symbols ?? current.password_require_symbols ?? 1;
    const password_expiry_days = data.password_expiry_days ?? current.password_expiry_days ?? 90;
    const enforce_single_session = data.enforce_single_session ?? current.enforce_single_session ?? 0;
    const two_factor_auth = data.two_factor_auth ?? current.two_factor_auth ?? 0;
    // Newly-persisted editable settings (Req 2.16).
    const bulk_import_enabled = data.bulk_import_enabled ?? current.bulk_import_enabled ?? 1;
    const admin_approval_required = data.admin_approval_required ?? current.admin_approval_required ?? 0;

    // First check if it exists
    const exists = await db.prepare("SELECT 1 FROM user_management_settings WHERE id = 1").get();

    if (exists) {
      await db.prepare(`
        UPDATE user_management_settings 
        SET failed_login_threshold = ?, 
            inactive_account_threshold_days = ?, 
            password_min_length = ?, 
            session_timeout_minutes = ?,
            password_require_uppercase = ?,
            password_require_lowercase = ?,
            password_require_numbers = ?,
            password_require_symbols = ?,
            password_expiry_days = ?,
            enforce_single_session = ?,
            two_factor_auth = ?,
            bulk_import_enabled = ?,
            admin_approval_required = ?
        WHERE id = 1
      `).run(
        failed_login_threshold, 
        inactive_account_threshold_days, 
        password_min_length, 
        session_timeout_minutes,
        password_require_uppercase,
        password_require_lowercase,
        password_require_numbers,
        password_require_symbols,
        password_expiry_days,
        enforce_single_session,
        two_factor_auth,
        bulk_import_enabled,
        admin_approval_required
      );
    } else {
      await db.prepare(`
        INSERT INTO user_management_settings (
          id, failed_login_threshold, inactive_account_threshold_days, password_min_length, session_timeout_minutes,
          password_require_uppercase, password_require_lowercase, password_require_numbers, password_require_symbols,
          password_expiry_days, enforce_single_session, two_factor_auth, bulk_import_enabled, admin_approval_required
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        failed_login_threshold, 
        inactive_account_threshold_days, 
        password_min_length, 
        session_timeout_minutes,
        password_require_uppercase,
        password_require_lowercase,
        password_require_numbers,
        password_require_symbols,
        password_expiry_days,
        enforce_single_session,
        two_factor_auth,
        bulk_import_enabled,
        admin_approval_required
      );
    }
    return true;
  }
}

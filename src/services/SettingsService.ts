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
    const { 
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
      two_factor_auth
    } = data;
    
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
            two_factor_auth = ?
        WHERE id = 1
      `).run(
        failed_login_threshold, 
        inactive_account_threshold_days, 
        password_min_length, 
        session_timeout_minutes,
        password_require_uppercase ?? 1,
        password_require_lowercase ?? 1,
        password_require_numbers ?? 1,
        password_require_symbols ?? 1,
        password_expiry_days ?? 90,
        enforce_single_session ?? 0,
        two_factor_auth ?? 0
      );
    } else {
      await db.prepare(`
        INSERT INTO user_management_settings (
          id, failed_login_threshold, inactive_account_threshold_days, password_min_length, session_timeout_minutes,
          password_require_uppercase, password_require_lowercase, password_require_numbers, password_require_symbols,
          password_expiry_days, enforce_single_session, two_factor_auth
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        failed_login_threshold, 
        inactive_account_threshold_days, 
        password_min_length, 
        session_timeout_minutes,
        password_require_uppercase ?? 1,
        password_require_lowercase ?? 1,
        password_require_numbers ?? 1,
        password_require_symbols ?? 1,
        password_expiry_days ?? 90,
        enforce_single_session ?? 0,
        two_factor_auth ?? 0
      );
    }
    return true;
  }
}

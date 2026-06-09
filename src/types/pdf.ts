import type { TemplateTypeKey } from '../constants/templateTypes';

// ─── Service-layer interfaces (boolean values) ─────────────────────────────

export interface PdfTemplate {
  id: string;
  template_name: string;
  template_type_key: TemplateTypeKey;
  template_type_label?: string;
  content: string;
  status: 'Draft' | 'Approved' | 'Archived';
  is_default: boolean;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface PdfSettings {
  arabic_font_name: string;
  arabic_font_size: number;
  heading_font_size: number;
  subheading_font_size: number;
  table_font_size: number;
  rtl_enabled: boolean;
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  header_template: string | null;
  footer_template: string | null;
  logo_position: 'left' | 'center' | 'right' | 'none';
  show_page_number: boolean;
}

// ─── Database-layer interfaces (numeric booleans) ───────────────────────────

export interface PdfTemplateRow {
  id: string;
  template_name: string;
  template_type_key: string;
  template_type: string;
  content: string;
  status: string;
  is_default: number; // 0 or 1
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface PdfSettingsRow {
  id: number;
  arabic_font_name: string;
  arabic_font_size: number;
  heading_font_size: number;
  subheading_font_size: number;
  table_font_size: number;
  rtl_enabled: number; // 0 or 1
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  header_template: string | null;
  footer_template: string | null;
  logo_position: string;
  show_page_number: number; // 0 or 1
}

// ─── Render interfaces ──────────────────────────────────────────────────────

export interface RenderOptions {
  template?: PdfTemplate;
  data: Record<string, unknown>;
  settings: PdfSettings;
  language: 'ar' | 'en';
  fileName?: string;
}

export interface PdfResult {
  buffer: Buffer;
  pageCount: number;
  fileSize: number;
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface CreateTemplateDto {
  template_name: string;
  template_type_key: TemplateTypeKey;
  content: string;
  status?: 'Draft' | 'Approved' | 'Archived';
  is_default?: boolean;
}

export interface UpdateTemplateDto {
  template_name?: string;
  content?: string;
  status?: 'Draft' | 'Approved' | 'Archived';
  is_default?: boolean;
}

// ─── Mapper functions ───────────────────────────────────────────────────────

/**
 * Converts a database row (numeric is_default) to the service-layer
 * PdfTemplate interface (boolean is_default).
 */
export function mapRowToTemplate(row: PdfTemplateRow): PdfTemplate {
  return {
    ...row,
    is_default: row.is_default === 1,
    status: row.status as PdfTemplate['status'],
    template_type_key: row.template_type_key as TemplateTypeKey,
  };
}

/**
 * Converts a database settings row (numeric booleans) to the service-layer
 * PdfSettings interface (real booleans).
 */
export function mapRowToSettings(row: PdfSettingsRow): PdfSettings {
  return {
    ...row,
    rtl_enabled: row.rtl_enabled === 1,
    show_page_number: row.show_page_number === 1,
    logo_position: row.logo_position as PdfSettings['logo_position'],
  };
}

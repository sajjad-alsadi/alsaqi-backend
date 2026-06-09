import sanitize from 'sanitize-html';
import type { Page } from 'puppeteer';
import type { PdfSettings } from '../types/pdf.js';

/**
 * Wraps body HTML in a full HTML document with RTL support, Arabic fonts,
 * margins, print styles, and font sizes from PDF settings.
 *
 * Requirements:
 * - 4.6: Apply dir="rtl" when rtl_enabled is true or language is 'ar'
 * - 4.7: Apply margins in millimeters
 * - 4.8: Include header/footer templates (handled externally by Puppeteer)
 *
 * Style priority rule: Settings are applied as inline styles on <body>,
 * so they take priority over template <style> blocks unless !important is used.
 */
export function wrapWithStyles(
  bodyHtml: string,
  settings: PdfSettings,
  language: 'ar' | 'en'
): string {
  const isRtl = language === 'ar' || settings.rtl_enabled;
  const dir = isRtl ? 'rtl' : 'ltr';
  const fontFamily = isRtl
    ? `'${settings.arabic_font_name}', Tahoma, 'Amiri', sans-serif`
    : `'${settings.arabic_font_name}', sans-serif`;

  return `<!DOCTYPE html>
<html lang="${language}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @font-face {
      font-family: 'Tahoma';
      src: local('Tahoma');
    }
    @font-face {
      font-family: 'Amiri';
      src: local('Amiri');
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: ${fontFamily};
      font-size: ${settings.arabic_font_size}pt;
      direction: ${dir};
      margin: 0;
      padding: ${settings.margin_top}mm ${settings.margin_right}mm ${settings.margin_bottom}mm ${settings.margin_left}mm;
      line-height: 1.6;
    }

    h1, h2, h3 {
      font-size: ${settings.heading_font_size}pt;
    }

    h4, h5, h6 {
      font-size: ${settings.subheading_font_size}pt;
    }

    table {
      font-size: ${settings.table_font_size}pt;
      width: 100%;
      border-collapse: collapse;
    }

    table th, table td {
      border: 1px solid #ddd;
      padding: 6px 8px;
      text-align: ${isRtl ? 'right' : 'left'};
    }

    table th {
      background-color: #f5f5f5;
      font-weight: bold;
    }

    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      table {
        page-break-inside: auto;
      }

      tr {
        page-break-inside: avoid;
        page-break-after: auto;
      }

      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
      }

      img {
        max-width: 100%;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body dir="${dir}" style="font-family: ${fontFamily}; font-size: ${settings.arabic_font_size}pt; direction: ${dir}; margin: 0; padding: ${settings.margin_top}mm ${settings.margin_right}mm ${settings.margin_bottom}mm ${settings.margin_left}mm;">
  ${bodyHtml}
</body>
</html>`;
}

/**
 * Sanitizes HTML content by removing dangerous elements and attributes.
 *
 * Requirement 9.1:
 * - Remove: script, iframe, object, embed, form, input tags
 * - Remove: all on* event attributes (onclick, onerror, onload, etc.)
 * - Allow: common HTML tags (div, span, p, h1-h6, table, tr, td, th, etc.)
 * - Allow: style, class, id, dir attributes
 */
export function sanitizeHtml(content: string): string {
  return sanitize(content, {
    allowedTags: [
      // Block elements
      'div', 'span', 'p', 'br', 'hr',
      // Headings
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      // Tables
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
      // Lists
      'ul', 'ol', 'li',
      // Inline formatting
      'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark',
      // Links and images
      'a', 'img',
      // Semantic
      'blockquote', 'pre', 'code', 'section', 'article', 'header', 'footer', 'nav', 'aside',
      // Definition lists
      'dl', 'dt', 'dd',
      // Figure
      'figure', 'figcaption',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'dir', 'lang', 'title'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height'],
      'td': ['colspan', 'rowspan', 'style', 'class', 'id', 'dir'],
      'th': ['colspan', 'rowspan', 'scope', 'style', 'class', 'id', 'dir'],
      'col': ['span', 'style'],
      'colgroup': ['span'],
      'ol': ['start', 'type'],
    },
    // Explicitly disallow all on* event handler attributes
    allowedSchemes: ['data', 'http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: ['data', 'https', 'http'],
      a: ['http', 'https', 'mailto'],
    },
    // Remove script, iframe, object, embed, form, input (not in allowedTags)
    disallowedTagsMode: 'discard',
  });
}

/**
 * Builds the header template HTML string for Puppeteer's headerTemplate option.
 *
 * Requirement 4.8: Include header/footer templates.
 * Shows logo based on settings.logo_position.
 */
export function buildHeaderTemplate(settings: PdfSettings): string {
  if (settings.logo_position === 'none' && !settings.header_template) {
    // Empty but valid header (Puppeteer requires a valid HTML string)
    return '<div></div>';
  }

  // If custom header_template is provided, use it
  if (settings.header_template) {
    return `<div style="width: 100%; font-size: 9px; padding: 0 10mm;">
      ${settings.header_template}
    </div>`;
  }

  // Default header with logo positioning
  const alignMap: Record<string, string> = {
    left: 'flex-start',
    center: 'center',
    right: 'flex-end',
  };
  const justify = alignMap[settings.logo_position] || 'center';

  return `<div style="width: 100%; display: flex; justify-content: ${justify}; align-items: center; padding: 5mm 10mm; font-size: 9px;">
    <span class="logo-placeholder" style="font-size: 10px; color: #666;">&#9679;</span>
  </div>`;
}

/**
 * Builds the footer template HTML string for Puppeteer's footerTemplate option.
 *
 * Requirement 4.8: Include header/footer templates.
 * Shows page numbers if settings.show_page_number is true.
 */
export function buildFooterTemplate(settings: PdfSettings, language: 'ar' | 'en'): string {
  if (!settings.show_page_number && !settings.footer_template) {
    // Empty but valid footer
    return '<div></div>';
  }

  // If custom footer_template is provided, use it
  if (settings.footer_template) {
    return `<div style="width: 100%; font-size: 9px; padding: 0 10mm;">
      ${settings.footer_template}
    </div>`;
  }

  // Default footer with page numbers
  if (settings.show_page_number) {
    const pageLabel = language === 'ar' ? 'صفحة' : 'Page';
    const ofLabel = language === 'ar' ? 'من' : 'of';
    const dir = language === 'ar' ? 'rtl' : 'ltr';

    return `<div style="width: 100%; display: flex; justify-content: center; align-items: center; padding: 5mm 10mm; font-size: 9px; direction: ${dir};">
      <span>${pageLabel} <span class="pageNumber"></span> ${ofLabel} <span class="totalPages"></span></span>
    </div>`;
  }

  return '<div></div>';
}

/**
 * Sets up Puppeteer request interception to block all external network requests.
 *
 * Requirement 9.2: Block all external network requests during PDF rendering.
 * Only allows:
 * - data: URIs (inline resources)
 * - about:blank (Puppeteer's initial page)
 *
 * All other requests (http://, https://, etc.) are aborted.
 */
export async function setupRequestInterception(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url === 'about:blank') {
      req.continue();
    } else {
      req.abort('blockedbyclient');
    }
  });
}

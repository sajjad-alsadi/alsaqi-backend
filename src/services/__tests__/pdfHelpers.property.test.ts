// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { sanitizeHtml } from '../pdfHelpers';

/**
 * Property Tests for sanitizeHtml (Property 5)
 *
 * Feature: pdf-template-system-overhaul
 *
 * Property 5: Sanitization removes dangerous elements
 * For any HTML content containing script, iframe, or on-event attributes,
 * the sanitized output does not contain those dangerous elements.
 *
 * **Validates: Requirements 9.1**
 */

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Safe content that should pass through sanitization */
const safeTextArb = fc.string({ minLength: 0, maxLength: 100 }).map((s) =>
  s.replace(/[<>&"']/g, '') // Remove chars that would form tags or break attributes
);

/** On-event attribute names commonly used in XSS attacks */
const onEventAttrArb = fc.constantFrom(
  'onclick',
  'onerror',
  'onload',
  'onmouseover',
  'onmouseout',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onkeydown',
  'onkeyup',
  'onkeypress'
);

/** Safe HTML tags that should be preserved by sanitization */
const safeTagArb = fc.constantFrom(
  'div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'tr', 'td', 'th', 'thead', 'tbody',
  'ul', 'ol', 'li', 'strong', 'em', 'b', 'i'
);

/** Arbitrary JavaScript code for injecting into dangerous elements */
const jsPayloadArb = fc.string({ minLength: 1, maxLength: 50 }).map((s) =>
  s.replace(/[<>"']/g, 'x') // Keep payload safe enough to be valid attribute/tag content
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 5: Sanitization removes dangerous elements', () => {
  /**
   * **Validates: Requirements 9.1**
   *
   * For any HTML string containing <script> tags, the output of sanitizeHtml
   * does not contain <script.
   */
  it('removes all <script> tags from any generated HTML input', () => {
    fc.assert(
      fc.property(
        safeTextArb,
        jsPayloadArb,
        safeTextArb,
        (before, payload, after) => {
          const input = `<p>${before}</p><script>${payload}</script><p>${after}</p>`;
          const result = sanitizeHtml(input);

          expect(result.toLowerCase()).not.toContain('<script');
          expect(result.toLowerCase()).not.toContain('</script');
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.1**
   *
   * For any HTML string containing <iframe> tags, the output does not
   * contain <iframe.
   */
  it('removes all <iframe> tags from any generated HTML input', () => {
    fc.assert(
      fc.property(
        safeTextArb,
        fc.webUrl(),
        safeTextArb,
        (before, url, after) => {
          const input = `<div>${before}</div><iframe src="${url}"></iframe><div>${after}</div>`;
          const result = sanitizeHtml(input);

          expect(result.toLowerCase()).not.toContain('<iframe');
          expect(result.toLowerCase()).not.toContain('</iframe');
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.1**
   *
   * For any HTML string containing on-event attributes (onclick, onerror,
   * onload, etc.), the output does not contain those attributes.
   */
  it('removes all on-event attributes from any generated HTML input', () => {
    fc.assert(
      fc.property(
        safeTextArb,
        onEventAttrArb,
        jsPayloadArb,
        (content, eventAttr, handler) => {
          const input = `<div ${eventAttr}="${handler}">${content}</div>`;
          const result = sanitizeHtml(input);

          expect(result.toLowerCase()).not.toContain(eventAttr);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.1**
   *
   * For any HTML string containing safe tags (div, p, h1-h6, table, etc.),
   * those tags are preserved in the output.
   */
  it('preserves safe tags while removing dangerous elements', () => {
    fc.assert(
      fc.property(
        safeTagArb,
        safeTextArb,
        jsPayloadArb,
        (tag, safeContent, dangerousPayload) => {
          const input = `<${tag}>${safeContent}</${tag}><script>${dangerousPayload}</script>`;
          const result = sanitizeHtml(input);

          // Safe tag is preserved
          expect(result).toContain(`<${tag}>`);
          // Dangerous script is removed
          expect(result.toLowerCase()).not.toContain('<script');
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.1**
   *
   * Combined test: HTML with multiple dangerous elements mixed with safe content
   * has all dangerous elements removed while preserving safe structure.
   */
  it('removes combined dangerous elements (script + iframe + on-event) in a single input', () => {
    fc.assert(
      fc.property(
        safeTextArb,
        onEventAttrArb,
        jsPayloadArb,
        fc.webUrl(),
        (content, eventAttr, payload, iframeUrl) => {
          const input = [
            `<div>${content}</div>`,
            `<script>${payload}</script>`,
            `<iframe src="${iframeUrl}"></iframe>`,
            `<p ${eventAttr}="${payload}">text</p>`,
          ].join('');

          const result = sanitizeHtml(input);

          // All dangerous elements are removed
          expect(result.toLowerCase()).not.toContain('<script');
          expect(result.toLowerCase()).not.toContain('<iframe');
          expect(result.toLowerCase()).not.toContain(eventAttr);

          // Safe structure is preserved
          expect(result).toContain('<div>');
          expect(result).toContain('<p>');
        }
      ),
      { numRuns: 200 }
    );
  });
});

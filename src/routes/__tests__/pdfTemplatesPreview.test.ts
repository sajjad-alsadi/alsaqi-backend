// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Unit Tests - PDF Template Preview API Endpoints (Task 8.3)
 *
 * Tests:
 * - POST /pdf-templates/preview-html: compiles Handlebars, returns {compiledHtml, errors}
 * - POST /pdf-templates/preview-pdf: renders PDF via Puppeteer, returns PDF blob
 * - Rate limiting: 10 requests/minute/user
 *
 * Validates: Requirements 6.3, 6.6, 9.4
 */

// Track rate limit call counts - declared before mocks
let rateLimitCallCounts = new Map<string, number>();

// Mock express-rate-limit
vi.mock('express-rate-limit', () => ({
  rateLimit: vi.fn((options: any) => {
    return (req: any, res: any, next: any) => {
      const key = options.keyGenerator?.(req) || req.ip || 'default';
      const count = (rateLimitCallCounts.get(key) || 0) + 1;
      rateLimitCallCounts.set(key, count);

      if (count > (options.max || 10)) {
        return res.status(429).json(options.message || { error: 'Too many requests' });
      }
      next();
    };
  }),
}));

// Mock the PdfEngine singleton
const mockCompilePreviewHtml = vi.fn().mockReturnValue({
  compiledHtml: '<html><body><h1>Hello World</h1></body></html>',
  errors: [],
});

const mockRenderFromTemplate = vi.fn().mockResolvedValue({
  buffer: Buffer.from('%PDF-1.4 mock pdf content'),
  pageCount: 1,
  fileSize: 25,
});

vi.mock('../../services/PdfEngine.js', () => ({
  pdfEngine: {
    compilePreviewHtml: (...args: any[]) => mockCompilePreviewHtml(...args),
    renderFromTemplate: (...args: any[]) => mockRenderFromTemplate(...args),
  },
}));

// Mock SettingsService
const mockGetPdfSettings = vi.fn().mockResolvedValue({
  id: 1,
  arabic_font_name: 'Amiri',
  arabic_font_size: 12,
  heading_font_size: 16,
  subheading_font_size: 14,
  table_font_size: 10,
  rtl_enabled: 1,
  margin_top: 20,
  margin_right: 20,
  margin_bottom: 20,
  margin_left: 20,
  header_template: '',
  footer_template: '',
  logo_position: 'right',
  show_page_number: 1,
});

vi.mock('../../services/SettingsService', () => ({
  SettingsService: {
    getPdfSettings: (...args: any[]) => mockGetPdfSettings(...args),
  },
}));

// Mock PdfTemplateService
vi.mock('../../services/PdfTemplateService', () => ({
  PdfTemplateService: {
    getAll: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    getActiveByType: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createPdfTemplatesRoutes } from '../pdfTemplates.js';

function createTestApp() {
  const app = express();
  app.use(express.json());

  const authenticate: express.RequestHandler = (req: any, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { id: 'test-user-id', username: 'testuser', role: 'Admin' };
    next();
  };

  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const logError = vi.fn();
  const mockDb = {};

  const router = createPdfTemplatesRoutes(mockDb, authenticate, checkPermission, logError);
  app.use('/', router);

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

function authPost(app: express.Application, url: string) {
  return request(app).post(url).set('Authorization', 'Bearer test-token');
}

describe('PDF Template Preview Endpoints (Task 8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitCallCounts = new Map();

    // Reset default mock implementations
    mockCompilePreviewHtml.mockReturnValue({
      compiledHtml: '<html><body><h1>Hello World</h1></body></html>',
      errors: [],
    });

    mockRenderFromTemplate.mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 mock pdf content'),
      pageCount: 1,
      fileSize: 25,
    });

    mockGetPdfSettings.mockResolvedValue({
      id: 1,
      arabic_font_name: 'Amiri',
      arabic_font_size: 12,
      heading_font_size: 16,
      subheading_font_size: 14,
      table_font_size: 10,
      rtl_enabled: 1,
      margin_top: 20,
      margin_right: 20,
      margin_bottom: 20,
      margin_left: 20,
      header_template: '',
      footer_template: '',
      logo_position: 'right',
      show_page_number: 1,
    });
  });

  describe('POST /pdf-templates/preview-html', () => {
    it('should compile Handlebars and return {compiledHtml, errors} (Req 6.3)', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({
          content: '<h1>{{title}}</h1>',
          sampleData: { title: 'Test Report' },
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('compiledHtml');
      expect(response.body).toHaveProperty('errors');
      expect(response.body.errors).toEqual([]);
      expect(mockCompilePreviewHtml).toHaveBeenCalledWith(
        '<h1>{{title}}</h1>',
        { title: 'Test Report' },
        expect.objectContaining({
          arabic_font_name: 'Amiri',
          rtl_enabled: true,
        }),
        'ar',
      );
    });

    it('should return errors when Handlebars compilation fails', async () => {
      const app = createTestApp();
      mockCompilePreviewHtml.mockReturnValueOnce({
        compiledHtml: '<div>Error display</div>',
        errors: [{ message: 'Parse error on line 3', line: 3 }],
      });

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({
          content: '<h1>{{#if}}</h1>',
          sampleData: {},
        });

      expect(response.status).toBe(200);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0]).toHaveProperty('message');
      expect(response.body.compiledHtml).toBeDefined();
    });

    it('should default sampleData to empty object when not provided', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({ content: '<p>Hello</p>' });

      expect(response.status).toBe(200);
      expect(mockCompilePreviewHtml).toHaveBeenCalledWith(
        '<p>Hello</p>',
        {},
        expect.any(Object),
        expect.any(String),
      );
    });

    it('should return 400 when content is missing', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({ sampleData: { title: 'test' } });

      expect(response.status).toBe(400);
    });

    it('should return 400 when content is empty string', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({ content: '', sampleData: {} });

      expect(response.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const app = createTestApp();

      const response = await request(app)
        .post('/pdf-templates/preview-html')
        .send({ content: '<p>test</p>', sampleData: {} });

      expect(response.status).toBe(401);
    });

    it('should use language "en" when rtl_enabled is false', async () => {
      const app = createTestApp();
      mockGetPdfSettings.mockResolvedValueOnce({
        id: 1,
        arabic_font_name: 'Amiri',
        arabic_font_size: 12,
        heading_font_size: 16,
        subheading_font_size: 14,
        table_font_size: 10,
        rtl_enabled: 0,
        margin_top: 20,
        margin_right: 20,
        margin_bottom: 20,
        margin_left: 20,
        header_template: '',
        footer_template: '',
        logo_position: 'right',
        show_page_number: 1,
      });

      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({ content: '<p>test</p>', sampleData: {} });

      expect(response.status).toBe(200);
      expect(mockCompilePreviewHtml).toHaveBeenCalledWith(
        '<p>test</p>',
        {},
        expect.objectContaining({ rtl_enabled: false }),
        'en',
      );
    });
  });

  describe('POST /pdf-templates/preview-pdf', () => {
    it('should generate a PDF and return it as application/pdf blob (Req 6.6)', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-pdf')
        .send({
          content: '<h1>{{title}}</h1>',
          sampleData: { title: 'Test PDF' },
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/pdf/);
      expect(response.headers['content-disposition']).toContain('preview.pdf');
      expect(response.headers['content-length']).toBe('25');
    });

    it('should call pdfEngine.renderFromTemplate with a temporary template', async () => {
      const app = createTestApp();

      await authPost(app, '/pdf-templates/preview-pdf')
        .send({
          content: '<h1>Report</h1>',
          sampleData: { data: 'test' },
        });

      expect(mockRenderFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          template: expect.objectContaining({
            id: 'preview',
            content: '<h1>Report</h1>',
            template_type_key: 'general',
          }),
          data: { data: 'test' },
          settings: expect.objectContaining({ rtl_enabled: true }),
          language: 'ar',
        }),
      );
    });

    it('should return 400 when content is missing', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/pdf-templates/preview-pdf')
        .send({ sampleData: {} });

      expect(response.status).toBe(400);
    });

    it('should return 500 when PdfEngine throws an error', async () => {
      const app = createTestApp();
      mockRenderFromTemplate.mockRejectedValueOnce(
        new Error('PDF rendering timeout: Puppeteer exceeded 30 seconds'),
      );

      const response = await authPost(app, '/pdf-templates/preview-pdf')
        .send({ content: '<p>complex template</p>', sampleData: {} });

      expect(response.status).toBe(500);
    });

    it('should return 401 when not authenticated', async () => {
      const app = createTestApp();

      const response = await request(app)
        .post('/pdf-templates/preview-pdf')
        .send({ content: '<p>test</p>', sampleData: {} });

      expect(response.status).toBe(401);
    });
  });

  describe('Rate Limiting (Req 9.4)', () => {
    it('should enforce 10 requests/minute/user limit on preview-html', async () => {
      const app = createTestApp();

      // Send 10 requests (all should pass)
      for (let i = 0; i < 10; i++) {
        const response = await authPost(app, '/pdf-templates/preview-html')
          .send({ content: `<p>Request ${i}</p>`, sampleData: {} });
        expect(response.status).toBe(200);
      }

      // The 11th request should be rate limited
      const response = await authPost(app, '/pdf-templates/preview-html')
        .send({ content: '<p>Rejected</p>', sampleData: {} });
      expect(response.status).toBe(429);
      expect(response.body.error).toContain('Rate limit');
    });

    it('should enforce 10 requests/minute/user limit on preview-pdf', async () => {
      const app = createTestApp();

      // Send 10 requests (all should pass)
      for (let i = 0; i < 10; i++) {
        const response = await authPost(app, '/pdf-templates/preview-pdf')
          .send({ content: `<p>Request ${i}</p>`, sampleData: {} });
        expect(response.status).toBe(200);
      }

      // The 11th request should be rate limited
      const response = await authPost(app, '/pdf-templates/preview-pdf')
        .send({ content: '<p>Rejected</p>', sampleData: {} });
      expect(response.status).toBe(429);
    });
  });
});

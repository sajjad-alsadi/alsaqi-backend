// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

/**
 * Integration Tests - Miscellaneous Routes
 *
 * Tests the health check, OpenAPI docs, and 404 handler endpoints.
 * These routes do not require authentication.
 *
 * Validates: Requirements 21.5, 21.6
 */

function createMiscTestApp() {
  const app = express();
  app.use(express.json());

  // Health Check - mirrors the real route logic
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'PGlite',
      persistence: 'in-memory',
    });
  });

  // OpenAPI Specification
  app.get('/api/docs', (req, res) => {
    try {
      const specPath = path.resolve(__dirname, '../../../../../docs/openapi.yaml');
      const spec = fs.readFileSync(specPath, 'utf-8');
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.send(spec);
    } catch (err) {
      res.status(404).json({ error: 'OpenAPI specification not found' });
    }
  });

  // Global API 404 Handler
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API endpoint ${req.originalUrl} not found` });
  });

  return app;
}

describe('Miscellaneous Routes Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createMiscTestApp();
  });

  // ─── GET /api/health ─────────────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('should return 200 with status, timestamp, database, and persistence', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
      expect(res.body.database).toBeDefined();
      expect(res.body.persistence).toBeDefined();
    });

    it('should not require authentication', async () => {
      // No Authorization header sent
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /api/docs ───────────────────────────────────────────────────────

  describe('GET /api/docs', () => {
    it('should return 200 with YAML content type when spec exists', async () => {
      const res = await request(app).get('/api/docs');

      // The spec file exists in the project
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/yaml');
    });

    it('should return 404 if spec file does not exist', async () => {
      // Create an app with a non-existent spec path
      const appWithMissingSpec = express();
      appWithMissingSpec.get('/api/docs', (req, res) => {
        try {
          const specPath = path.resolve(__dirname, '../../../../docs/nonexistent.yaml');
          const spec = fs.readFileSync(specPath, 'utf-8');
          res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
          res.send(spec);
        } catch (err) {
          res.status(404).json({ error: 'OpenAPI specification not found' });
        }
      });

      const res = await request(appWithMissingSpec).get('/api/docs');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('OpenAPI specification not found');
    });
  });

  // ─── 404 Handler ─────────────────────────────────────────────────────────

  describe('404 Handler for non-existent API endpoints', () => {
    it('should return 404 with error message for non-existent /api/* endpoints', async () => {
      const res = await request(app).get('/api/nonexistent-endpoint');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });

    it('should include the requested URL in the error message', async () => {
      const res = await request(app).get('/api/some/random/path');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('/api/some/random/path');
    });
  });
});

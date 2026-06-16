/**
 * Web Vitals Metrics Route
 *
 * Receives Core Web Vitals data (LCP, FID, CLS, TTFB, INP) from the frontend
 * and logs them for performance monitoring. This endpoint is intentionally
 * unauthenticated so the frontend can report metrics before/during login.
 *
 * POST /api/v1/metrics/web-vitals
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_METRIC_NAMES = ['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB'] as const;
type MetricName = (typeof VALID_METRIC_NAMES)[number];

interface WebVitalEntry {
  name: MetricName;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  id: string;
  navigationType?: string;
  delta?: number;
}

function isValidMetricName(name: string): name is MetricName {
  return VALID_METRIC_NAMES.includes(name as MetricName);
}

function isValidRating(rating: string): rating is WebVitalEntry['rating'] {
  return ['good', 'needs-improvement', 'poor'].includes(rating);
}

/**
 * Validates a single web vital entry. Returns null if invalid.
 */
function validateEntry(entry: unknown): WebVitalEntry | null {
  if (!entry || typeof entry !== 'object') return null;

  const e = entry as Record<string, unknown>;

  if (typeof e.name !== 'string' || !isValidMetricName(e.name)) return null;
  if (typeof e.value !== 'number' || !isFinite(e.value)) return null;
  if (typeof e.rating !== 'string' || !isValidRating(e.rating)) return null;
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 128) return null;

  return {
    name: e.name,
    value: e.value,
    rating: e.rating,
    id: e.id,
    navigationType: typeof e.navigationType === 'string' ? e.navigationType : undefined,
    delta: typeof e.delta === 'number' ? e.delta : undefined,
  };
}

// ─── Route Factory ───────────────────────────────────────────────────────────

export function createWebVitalsRoutes(): Router {
  const router = Router();

  /**
   * POST /metrics/web-vitals
   *
   * Accepts a single metric or an array of metrics from the frontend.
   * Body: WebVitalEntry | WebVitalEntry[]
   *
   * Returns 204 on success (no content — fire-and-forget from the client's perspective).
   * Returns 400 if the payload is invalid.
   */
  router.post(
    '/web-vitals',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;

      // Accept single object or array
      const rawEntries: unknown[] = Array.isArray(body) ? body : [body];

      if (rawEntries.length === 0 || rawEntries.length > 50) {
        res.status(400).json({ error: 'Invalid payload: expected 1-50 metric entries' });
        return;
      }

      const validEntries: WebVitalEntry[] = [];
      for (const raw of rawEntries) {
        const entry = validateEntry(raw);
        if (entry) {
          validEntries.push(entry);
        }
      }

      if (validEntries.length === 0) {
        res.status(400).json({ error: 'No valid web vital entries in payload' });
        return;
      }

      // Log metrics for observability (structured JSON for log aggregation)
      for (const entry of validEntries) {
        console.log(
          JSON.stringify({
            level: 'info',
            category: 'web-vitals',
            metric: entry.name,
            value: entry.value,
            rating: entry.rating,
            id: entry.id,
            navigationType: entry.navigationType,
            delta: entry.delta,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // 204 No Content — acknowledged, no response body needed
      res.status(204).end();
    })
  );

  return router;
}

import express from 'express';
import { LogService } from '../services/LogService';
import { asyncHandler } from '../utils/asyncHandler';
import { createRateLimiter } from '../middleware/rateLimiter';

export const createLogRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  // Per-user rate limiter for the client-facing error-logging endpoints.
  // Caps how many error reports a single authenticated principal can submit
  // per window, preventing log-flooding / WebSocket-broadcast DoS.
  const errorReportLimiter = createRateLimiter({
    authenticatedLimit: 30,
    unauthenticatedLimit: 10,
    windowSeconds: 60,
  });

  // Maximum accepted length for any single client-supplied log field. Anything
  // longer is truncated before it is persisted or broadcast (DoS mitigation).
  const MAX_FIELD_LENGTH = 4096;

  /**
   * Escapes HTML-significant characters and bounds the length of any
   * client-supplied content before it is persisted or broadcast to WebSocket
   * clients. Prevents stored/reflected content injection (XSS) and oversized
   * payloads. Returns `undefined` for null/undefined so optional fields stay
   * optional.
   */
  const sanitizeContent = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str
      .slice(0, MAX_FIELD_LENGTH)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  router.get(`/login-history`, authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getLoginHistory(req.query);
    res.json(result);
  }));

  router.get(`/audit-trail`, authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getAuditTrail(req.query);
    res.json(result);
  }));

  router.post("/system-errors", authenticate, errorReportLimiter, asyncHandler(async (req, res) => {
    const { message, stack, module, severity, user_agent, url, request_data } = req.body;
    const userId = (req as any).user?.id;

    if (!message || !module) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: "Missing required fields" } });
    }

    // Escape + bound every client-supplied field before it is persisted or broadcast.
    const safeMessage = sanitizeContent(message);
    const safeModule = sanitizeContent(module);
    const safeSeverity = sanitizeContent(severity);

    await LogService.logSystemError({
      message: safeMessage,
      stack: sanitizeContent(stack),
      module: safeModule,
      userId,
      severity: safeSeverity,
      user_agent: sanitizeContent(user_agent),
      url: sanitizeContent(url),
      request_data: sanitizeContent(request_data),
    });

    // Broadcast via WebSocket (sanitized content only)
    const wss = (req.app as any).wss;
    if (wss) {
      wss.clients.forEach((client: any) => {
        if (client.readyState === 1 && (client as any).authenticated) {
          client.send(JSON.stringify({ type: 'NEW_SYSTEM_ERROR', message: safeMessage, module: safeModule, severity: safeSeverity }));
        }
      });
    }

    res.json({ success: true });
  }));

  router.get("/system-errors", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getSystemErrors(req.query);
    res.json(result);
  }));

  router.delete("/system-errors", authenticate, checkPermission('SystemLogs', 'Delete'), asyncHandler(async (req, res) => {
    await LogService.clearSystemErrors();
    res.json({ success: true });
  }));

  router.get("/system-errors/export", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const logs = await LogService.getSystemErrorsForExport();

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '';
      let str = String(val);
      // CSV/formula injection neutralization: a cell whose first character is
      // =, +, -, @ (or a leading tab/carriage-return) is prefixed with a single
      // quote so spreadsheet software treats it as literal text rather than
      // evaluating it as a formula.
      if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = ["ID", "Message", "Module", "Severity", "Timestamp", "URL", "UserAgent", "RequestData"];
    const csv = [headers.join(',')];

    logs.forEach((log: any) => {
      csv.push([
        escapeCsv(log.id),
        escapeCsv(log.message),
        escapeCsv(log.module),
        escapeCsv(log.severity),
        escapeCsv(log.timestamp),
        escapeCsv(log.url),
        escapeCsv(log.user_agent),
        escapeCsv(log.request_data)
      ].join(','));
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('system_errors.csv');
    res.send(csv.join('\n'));
  }));

  router.get("/system-errors/analytics", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const analytics = await LogService.getSystemErrorAnalytics();
    res.json(analytics);
  }));

  router.post("/log-error", authenticate, errorReportLimiter, asyncHandler(async (req, res) => {
    const { message, stack, module } = req.body;
    const userId = (req as any).user?.id;
    await LogService.logSystemError({
      message: sanitizeContent(message),
      stack: sanitizeContent(stack),
      module: sanitizeContent(module) || 'Frontend',
      severity: 'error',
      userId,
    });
    res.json({ success: true });
  }));

  return router;
};

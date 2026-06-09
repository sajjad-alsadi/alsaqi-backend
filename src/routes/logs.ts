import express from 'express';
import jwt from 'jsonwebtoken';
import { LogService } from '../services/LogService';
import { asyncHandler } from '../utils/asyncHandler';

export const createLogRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/login-history`, authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getLoginHistory(req.query);
    res.json(result);
  }));

  router.get(`/audit-trail`, authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getAuditTrail(req.query);
    res.json(result);
  }));

  // Optional authentication middleware for error logging
  const optionalAuthenticate = async (req: any, res: any, next: any) => {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    if (token) {
      try {
        const decodedToken = jwt.verify(token, process.env.JWT_PUBLIC_KEY as string, { algorithms: ['RS256'] }) as any;
        req.user = { id: decodedToken.id };
      } catch (err: any) {
        if (err.name === 'JsonWebTokenError') {
          // Reject malformed or tampered tokens to prevent security probing
          return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: "Invalid authentication token provided" } });
        }
        // Allow TokenExpiredError so users can still log errors during session timeouts
      }
    }
    next();
  };

  router.post("/system-errors", optionalAuthenticate, asyncHandler(async (req, res) => {
    const { message, stack, module, severity, user_agent, url, request_data } = req.body;
    const userId = (req as any).user?.id;
    
    if (!message || !module) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: "Missing required fields" } });
    }

    await LogService.logSystemError({
      message, stack, module, userId, severity, user_agent, url, request_data
    });
    
    // Broadcast via WebSocket
    const wss = (req.app as any).wss;
    if (wss) {
      wss.clients.forEach((client: any) => {
        if (client.readyState === 1 && (client as any).authenticated) {
          client.send(JSON.stringify({ type: 'NEW_SYSTEM_ERROR', message, module, severity }));
        }
      });
    }
    
    res.json({ success: true });
  }));

  router.get("/system-errors", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const result = await LogService.getSystemErrors(req.query);
    res.json(result);
  }));

  router.delete("/system-errors", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    await LogService.clearSystemErrors();
    res.json({ success: true });
  }));

  router.get("/system-errors/export", authenticate, checkPermission('SystemLogs', 'View'), asyncHandler(async (req, res) => {
    const logs = await LogService.getSystemErrorsForExport();
    
    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
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

  router.post("/log-error", optionalAuthenticate, asyncHandler(async (req, res) => {
    const { message, stack, module } = req.body;
    const userId = (req as any).user?.id;
    await LogService.logSystemError({
      message, stack, module: module || 'Frontend', severity: 'error', userId
    });
    res.json({ success: true });
  }));

  return router;
};

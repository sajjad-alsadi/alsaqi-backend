import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { DashboardService } from '../services/DashboardService';
import { parsePaginationParams } from '../utils/paginationService';

export const createDashboardRoutes = (
  db: any,
  authenticate: any,
  authorize: any,
  logError: any
) => {
  const router = express.Router();

  router.get(`/dashboard-stats`, authenticate, asyncHandler(async (req, res) => {
    const { department, riskLevel } = req.query;
    const stats = await DashboardService.getDashboardStats({ 
      department: department as string, 
      riskLevel: riskLevel as string 
    });
    res.json(stats);
  }));

  router.get(`/my-tasks`, authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as unknown as any;
    const userId = typedReq.user.id;
    const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);
    const tasks = await DashboardService.getMyTasks(userId, page, pageSize);
    res.json(tasks);
  }));

  return router;
};

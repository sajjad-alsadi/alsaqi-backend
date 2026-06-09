import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { AnalyticsService } from "../services/AnalyticsService";

export const createAnalyticsRoutes = (db: any, authenticate: any, checkPermission: any, logError: any) => {
  const router = Router();

  router.get("/findings-by-risk", authenticate, checkPermission('Analytics', 'View'), asyncHandler(async (req, res) => {
    const data = await AnalyticsService.getFindingsByRisk();
    res.json(data);
  }));

  router.get("/findings-by-status", authenticate, checkPermission('Analytics', 'View'), asyncHandler(async (req, res) => {
    const data = await AnalyticsService.getFindingsByStatus();
    res.json(data);
  }));

  router.get("/recommendations-by-status", authenticate, checkPermission('Analytics', 'View'), asyncHandler(async (req, res) => {
    const data = await AnalyticsService.getRecommendationsByStatus();
    res.json(data);
  }));

  return router;
};

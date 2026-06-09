import express from "express";
import { IntegrityService } from "../services/IntegrityService";
import { asyncHandler } from "../utils/asyncHandler";

export const createIntegrityRoutes = (authenticate: any) => {
  const router = express.Router();

  router.get("/integrity/stats", authenticate, asyncHandler(async (req, res) => {
    const stats = await IntegrityService.getIntegrityStats();
    res.json(stats);
  }));

  return router;
};

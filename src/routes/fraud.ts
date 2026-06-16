import { Router } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../types";
import { FraudService } from "../services/FraudService";
import { AuthService } from "../services/AuthService";
import { asyncHandler } from "../utils/asyncHandler";
import { ValidationError } from "../utils/errors";
import { UserRole } from "@alsaqi/shared";

const fraudRequestSchema = z.object({
  reason: z.string().min(5).max(1000),
});

const fraudApproveSchema = z.object({
  duration: z.coerce.number().int().positive().max(365),
});

const fraudRejectSchema = z.object({
  reason: z.string().min(5).max(1000),
});

export const createFraudRoutes = (db: any, authenticate: any, checkPermission: any, logError: any, createNotification: any) => {
  const router = Router();

  router.post("/", authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const validation = fraudRequestSchema.safeParse(typedReq.body);
    if (!validation.success) {
      throw new ValidationError("Invalid request data", validation.error.format());
    }
    const { reason } = validation.data;
    const userId = typedReq.user.id;
    const userName = typedReq.user.username;

    const requestId = await FraudService.createRequest(userId, userName, reason);

    // Notify Admins/Managers in Parallel (Fixing Sequential Awaiting Delay)
    const admins = await db.prepare(`SELECT id FROM users WHERE role IN (?, ?)`).all(UserRole.ADMIN, UserRole.MANAGER) as { id: number }[];
    
    await Promise.all(
      admins.map(admin => 
        createNotification(admin.id, "access_requested", `${userName} requested access to Fraud Log`, "Fraud Log", "/fraud-log", { actorId: userId, wss: (req.app as any).wss })
      )
    );

    // Using AuthService directly since it's correctly mapped or we can use BaseService later
    await AuthService.logAudit(userName, "Request Access", "Fraud Log", "User requested access to Fraud Log");

    res.json({ success: true, id: requestId });
  }));

  router.get("/", authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const requests = await FraudService.getRequests(typedReq.user);
    res.json(requests);
  }));

  router.get("/my-status", authenticate, asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const status = await FraudService.getMyStatus(typedReq.user.id);
    res.json(status);
  }));

  router.put("/:id/approve", authenticate, checkPermission('IntegrityManagement', 'Approve'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    const validation = fraudApproveSchema.safeParse(typedReq.body);
    if (!validation.success) {
      throw new ValidationError("Invalid duration", validation.error.format());
    }
    const { duration } = validation.data;
    const responderId = typedReq.user.id;
    
    const request = await FraudService.approveRequest(id, duration, responderId);

    // Notify User
    await createNotification(request.user_id, "access_approved", "Your access request to Fraud Log has been approved.", "Fraud Log", "/fraud-log", { actorId: typedReq.user.id, wss: (req.app as any).wss });

    await AuthService.logAudit(typedReq.user.username, "Approve Access", "Fraud Log", `Approved access for user ID ${request.user_id} for ${duration} days`);

    res.json({ success: true });
  }));

  router.put("/:id/reject", authenticate, checkPermission('IntegrityManagement', 'Approve'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    const validation = fraudRejectSchema.safeParse(typedReq.body);
    if (!validation.success) {
      throw new ValidationError("Invalid reject reason", validation.error.format());
    }
    const { reason } = validation.data;
    const responderId = typedReq.user.id;

    const request = await FraudService.rejectRequest(id, reason, responderId);

    // Notify User
    await createNotification(request.user_id, "access_rejected", `Your access request to Fraud Log was rejected: ${reason}`, "Fraud Log", "/fraud-log", { actorId: typedReq.user.id, wss: (req.app as any).wss });

    await AuthService.logAudit(typedReq.user.username, "Reject Access", "Fraud Log", `Rejected access for user ID ${request.user_id}`);

    res.json({ success: true });
  }));

  return router;
};

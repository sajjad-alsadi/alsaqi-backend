import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { PasswordService } from '../../services/PasswordService';
import { AuthService } from '../../services/AuthService';
import { asyncHandler } from '../../utils/asyncHandler';
import { ValidationError } from '../../utils/errors';
import { DEFAULT_PASSWORD_MIN_LENGTH } from '../../services/passwordPolicy';

const forgotPasswordSchema = z.object({
  username: z.string().min(1)
});

const approveResetSchema = z.object({
  requestId: z.string().min(1)
});

const changePasswordSchema = z.object({
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100)
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(100)
});

export const createPasswordRoutes = (
  db: any,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  authLimiter: any,
  authenticate: any,
  checkPermission: any,
  createNotification: any,
  logError: any
) => {
  const router = express.Router();

  // Forgot Password
  router.post("/forgot-password", authLimiter, asyncHandler(async (req, res) => {
    const validation = forgotPasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid username", validation.error.format());
    }
    const { username } = validation.data;
    const result = await PasswordService.requestReset(username);
    
    if (result.user && result.admins) {
      for (const admin of result.admins) {
        await createNotification(admin.id, 'password_reset_request', result.alertMsg, 'Security', '/users', { actorId: result.user.id, wss: (req.app as any).wss });
      }
      await AuthService.logAudit(result.user.username, "Password Reset Request", "Security", "User requested password reset");
    }

    res.json({ success: true, message: result.message });
  }));

  // Check Reset Status
  router.get("/reset-status/:username", authLimiter, asyncHandler(async (req, res) => {
    const username = req.params.username as string;
    const status = await PasswordService.getResetStatus(username);
    res.json({ status });
  }));

  // Admin: Get Reset Requests
  router.get("/reset-requests", authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const data = await PasswordService.getResetRequests();
    res.json(data);
  }));

  // Admin: Approve Reset Request
  router.post("/approve-reset", authenticate, checkPermission('UserManagement', 'Edit'), asyncHandler(async (req, res) => {
    const validation = approveResetSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid request ID", validation.error.format());
    }
    const { requestId } = validation.data;
    const adminId = (req as any).user.id;
    const result = await PasswordService.approveReset(requestId, adminId);

    await AuthService.logAudit((req as any).user.username, "Admin Password Reset", "Security", `Admin reset password for user: ${result.username}. Request ID: ${requestId}`);

    res.json({ success: true, tempPassword: result.tempPassword });
  }));

  // User: Change Password (Mandatory or Voluntary)
  router.post("/change-password", authLimiter, authenticate, asyncHandler(async (req, res) => {
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid password data", validation.error.format());
    }
    const { newPassword } = validation.data;
    const userId = (req as any).user.id;
    
    const user = await PasswordService.changePassword(userId, newPassword);
    
    await AuthService.logAudit(user.username, "Change Password", "Security", "User changed their password");
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
      JWT_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '15m' }
    );

    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.json({ success: true, token });
  }));

  // User: Update Password
  router.post("/update-password", authLimiter, authenticate, asyncHandler(async (req, res) => {
    const validation = updatePasswordSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid password data", validation.error.format());
    }
    const { currentPassword, newPassword } = validation.data;
    const userId = (req as any).user.id;
    
    const user = await PasswordService.updatePassword(userId, currentPassword, newPassword);
    
    await AuthService.logAudit(user.username, "Change Password", "Settings", "User changed their password");
    
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, session_version: user.session_version },
      JWT_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: '15m' }
    );

    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.json({ success: true, token });
  }));

  return router;
};

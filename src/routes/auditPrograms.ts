import { Router } from "express";
import { AuthenticatedRequest } from "../types";
import { asyncHandler } from "../utils/asyncHandler";
import { AuditProgramService } from "../services/AuditProgramService";
import { BaseService } from "../services/BaseService";
import { AuthService } from "../services/AuthService";
import { ValidationError, NotFoundError } from "../utils/errors";
import { parsePaginationParams } from "../utils/paginationService";

const TABLE_NAME = "audit_programs";
const MODULE_NAME = "AuditProgramLibrary";
const ALLOWED_FIELDS = [
  "program_code", "program_title", "audit_area", "department",
  "audit_type", "audit_objective", "audit_scope", "key_risks",
  "control_objectives", "reference_standard", "status", "version_number", "created_by"
];

export const createAuditProgramRoutes = (db: any, authenticate: any, checkPermission: any, logError: any) => {
  const router = Router();

  // ─── Custom Operations (must be before /:id to prevent matching) ──────────

  // POST /:id/duplicate — Duplicate an audit program
  router.post("/:id/duplicate", authenticate, checkPermission(MODULE_NAME, 'Create'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid audit program ID");
    }
    const user = typedReq.user.username;
    
    const newId = await AuditProgramService.duplicate(id, user);
    
    await AuthService.logAudit(user, "Duplicate", "Audit Program Library", `Duplicated program ID: ${id} to ${newId}`);
      
    res.json({ id: newId });
  }));

  // POST /:id/approve — Approve an audit program
  router.post("/:id/approve", authenticate, checkPermission(MODULE_NAME, 'Approve'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid audit program ID");
    }
    const user = typedReq.user.username;
    const userId = typedReq.user.id;
    const userRole = typedReq.user.role;
    
    await AuditProgramService.approveProgram(id, userId, userRole);
    
    await AuthService.logAudit(user, "Approve", "Audit Program Library", `Approved program ID: ${id}`);
      
    res.json({ success: true });
  }));

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  // GET / — List all audit programs (paginated)
  router.get("/", authenticate, checkPermission(MODULE_NAME, 'View'), asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);
    const { page: _, pageSize: __, ...filters } = req.query;

    const result = await BaseService.findAll(TABLE_NAME, {
      page,
      pageSize,
      where: filters,
    });
    res.json(result);
  }));

  // GET /:id — Get a single audit program by ID
  router.get("/:id", authenticate, checkPermission(MODULE_NAME, 'View'), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid audit program ID");
    }
    const result = await BaseService.findById(TABLE_NAME, id);
    if (!result) throw new NotFoundError("Audit program not found");
    res.json(result);
  }));

  // POST / — Create a new audit program
  router.post("/", authenticate, checkPermission(MODULE_NAME, 'Create'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const rawBody = { ...typedReq.body };

    // Strict field whitelisting
    const body: any = {};
    for (const key of Object.keys(rawBody)) {
      if (ALLOWED_FIELDS.includes(key)) {
        body[key] = rawBody[key];
      }
    }

    const result = await BaseService.create(TABLE_NAME, body);

    await AuthService.logAudit(
      typedReq.user.username,
      `Created ${TABLE_NAME}`,
      "audit-programs",
      JSON.stringify(body)
    );

    res.json(result);
  }));

  // PUT /:id — Update an existing audit program
  router.put("/:id", authenticate, checkPermission(MODULE_NAME, 'Edit'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid audit program ID");
    }

    const rawBody = { ...typedReq.body };

    // Strict field whitelisting
    const body: any = {};
    for (const key of Object.keys(rawBody)) {
      if (ALLOWED_FIELDS.includes(key)) {
        body[key] = rawBody[key];
      }
    }

    const result = await BaseService.update(TABLE_NAME, id, body);

    await AuthService.logAudit(
      typedReq.user.username,
      `Updated ${TABLE_NAME} ID: ${id}`,
      "audit-programs",
      JSON.stringify(body)
    );

    res.json(result);
  }));

  // DELETE /:id — Delete an audit program
  router.delete("/:id", authenticate, checkPermission(MODULE_NAME, 'Delete'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const id = req.params.id as string;
    if (!id || id === 'undefined') {
      throw new ValidationError("Invalid audit program ID");
    }

    await BaseService.delete(TABLE_NAME, id);

    await AuthService.logAudit(
      typedReq.user.username,
      `Deleted ${TABLE_NAME} ID: ${id}`,
      "audit-programs",
      JSON.stringify({ id })
    );

    res.json({ success: true });
  }));

  return router;
};

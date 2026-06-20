import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { CorrespondenceService } from '../services/CorrespondenceService';
import { AuthService } from '../services/AuthService';
import { ValidationError } from '../utils/errors';
import { parsePaginationParams } from '../utils/paginationService';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { correspondenceAttachmentSchema, idParamSchema, crudQuerySchema } from '../schemas';
import { PRIORITIES, CLASSIFICATIONS, METHODS, ENTITY_TYPES, LINK_TYPES, INCOMING_STATUSES, OUTGOING_STATUSES } from '@alsaqi/shared';

const typeParamSchema = z.object({
  type: z.enum(['incoming', 'outgoing'], { message: 'type must be "incoming" or "outgoing"' }),
});

const typeIdParamSchema = z.object({
  type: z.enum(['incoming', 'outgoing'], { message: 'type must be "incoming" or "outgoing"' }),
  id: z.string().refine(
    (val) =>
      /^\d+$/.test(val) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val),
    { message: 'id must be a valid integer or UUID' }
  ),
});

export const incomingSchema = z.object({
  letter_number: z.string().min(1).max(100),
  sender_entity: z.string().min(1).max(255),
  sender_entity_type: z.enum(ENTITY_TYPES).optional(),
  subject: z.string().min(1).max(500),
  letter_date: z.string().min(1),
  receipt_date: z.string().min(1),
  classification: z.enum(CLASSIFICATIONS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  method: z.enum(METHODS).optional(),
  receiving_dept_id: z.string().uuid().optional().nullable(),
  assigned_dept_id: z.string().uuid().optional().nullable(),
  assigned_user_id: z.string().uuid().optional().nullable(),
  follow_up_required: z.boolean().optional(),
  follow_up_date: z.string().optional().nullable(),
  response_required: z.boolean().optional(),
  response_due_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

export const outgoingSchema = z.object({
  letter_date: z.string().min(1),
  recipient_entity: z.string().min(1).max(255),
  subject: z.string().min(1).max(500),
  classification: z.enum(CLASSIFICATIONS).optional(),
  sending_method: z.enum(METHODS).optional(),
  attachment_file: z.string().optional().nullable()
});

const referSchema = z.object({
  incoming_id: z.string().uuid(),
  to_dept_id: z.string().uuid(),
  to_user_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable()
});

export const linkSchema = z.object({
  incoming_id: z.string().uuid(),
  outgoing_id: z.string().uuid(),
  link_type: z.enum(LINK_TYPES).optional().default('Reply')
});

export const incomingStatusUpdateSchema = z.object({
  new_status: z.enum(INCOMING_STATUSES),
  notes: z.string().optional().nullable(),
});

export const outgoingStatusUpdateSchema = z.object({
  new_status: z.enum(OUTGOING_STATUSES),
  notes: z.string().optional().nullable(),
});

// Archive list query schema (finding 1.2 -> 2.2): validate/normalize the optional
// `type` filter against the same lowercase set as the path params, so an unknown
// `type` (e.g. the capitalized `Incoming`) is a deterministic 400 and a valid one
// filters correctly — no silent fall-through to the combined incoming+outgoing set.
// `search`/`page`/`pageSize` are declared so they survive validation (Zod strips
// unknown keys by default). Pagination is intentionally kept permissive here:
// coerced optional numbers with NO upper-bound clamp and NO default. The GET /archive
// handler then routes `req.query` through parsePaginationParams (the shared clamp), so the
// upper-bound cap (pageSize <= MAX_PAGE_SIZE) is applied on top of this schema (finding 1.5).
const archiveQuerySchema = z.object({
  type: z.enum(['incoming', 'outgoing'], { message: 'type must be "incoming" or "outgoing"' }).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int({ message: 'page must be an integer' }).min(1, { message: 'page must be at least 1' }).optional(),
  pageSize: z.coerce.number().int({ message: 'pageSize must be an integer' }).min(1, { message: 'pageSize must be at least 1' }).optional(),
});

export const createCorrespondenceRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any,
  saveFile: any
) => {
  const router = express.Router();

  // 1. Incoming Correspondence
  router.get("/incoming", authenticate, validateQuery(crudQuerySchema), asyncHandler(async (req, res) => {
    const result = await CorrespondenceService.getIncoming(req.query);
    res.json(result);
  }));

  router.post("/incoming", authenticate, checkPermission('Correspondence', 'Create'), asyncHandler(async (req, res) => {
    const validation = incomingSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid incoming correspondence data", validation.error.format());
    }
    const userId = (req as any).user.id;
    const result = await CorrespondenceService.createIncoming(validation.data, userId);

    await AuthService.logAudit((req as any).user.username, "CREATE", "Correspondence", `Created incoming letter ${result.sequence_number}`);
    res.json(result);
  }));

  router.put("/incoming/:id", authenticate, checkPermission('Correspondence', 'Edit'), validateParams(idParamSchema), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const validation = incomingSchema.partial().safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid incoming correspondence data", validation.error.format());
    }
    await CorrespondenceService.updateIncoming(id, validation.data);
    
    await AuthService.logAudit((req as any).user.username, "UPDATE", "Correspondence", `Updated incoming letter ID: ${id}`);
    res.json({ success: true });
  }));

  router.delete("/incoming/:id", authenticate, checkPermission('Correspondence', 'Delete'), validateParams(idParamSchema), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    await CorrespondenceService.deleteIncoming(id);
    
    await AuthService.logAudit((req as any).user.username, "DELETE", "Correspondence", `Deleted incoming letter ID: ${id}`);
    res.json({ success: true });
  }));

  // 2. Status History and Updates
  router.put("/status/:type/:id", authenticate, checkPermission('Correspondence', 'Edit'), validateParams(typeIdParamSchema), asyncHandler(async (req, res) => {
    const type = req.params.type as string;
    const id = req.params.id as string;
    const schema = type === 'outgoing' ? outgoingStatusUpdateSchema : incomingStatusUpdateSchema;
    const validation = schema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid status update data", validation.error.format());
    }
    const { new_status, notes } = validation.data;
    const userId = (req as any).user.id;
    
    const result = await CorrespondenceService.updateStatus(type, id, new_status, notes || '', userId);

    await AuthService.logAudit((req as any).user.username, "UPDATE_STATUS", "Correspondence", `Changed ${type} ${id} status from ${result.oldStatus} to ${new_status}`);
    res.json({ success: true });
  }));

  // 4. Referrals
  router.post("/refer", authenticate, checkPermission('Correspondence', 'Edit'), asyncHandler(async (req, res) => {
    const validation = referSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid referral data", validation.error.format());
    }
    const userId = (req as any).user.id;
    await CorrespondenceService.refer(validation.data, userId);

    await AuthService.logAudit((req as any).user.username, "REFER", "Correspondence", `Referred incoming letter ${validation.data.incoming_id} to dept ${validation.data.to_dept_id}`);
    res.json({ success: true });
  }));

  // 5. Linking
  router.post("/link", authenticate, checkPermission('Correspondence', 'Edit'), asyncHandler(async (req, res) => {
    const validation = linkSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError("Invalid link data", validation.error.format());
    }
    const userId = (req as any).user.id;
    await CorrespondenceService.link(validation.data, userId);
    
    await AuthService.logAudit((req as any).user.username, "LINK", "Correspondence", `Linked incoming ${validation.data.incoming_id} with outgoing ${validation.data.outgoing_id}`);
    res.json({ success: true });
  }));

  // 6. Archiving
  router.put("/archive/:type/:id", authenticate, checkPermission('Correspondence', 'Edit'), validateParams(typeIdParamSchema), asyncHandler(async (req, res) => {
    const type = req.params.type as string;
    const id = req.params.id as string;
    await CorrespondenceService.archive(type, id);
    
    await AuthService.logAudit((req as any).user.username, "ARCHIVE", "Correspondence", `Archived ${type} ${id}`);
    res.json({ success: true });
  }));

  // 6.1 Archive List (Unified & Paginated)
  router.get("/archive", authenticate, validateQuery(archiveQuerySchema), asyncHandler(async (req, res) => {
    // Finding 1.5 -> 2.5: apply the shared pagination clamp, like the other list routes.
    // archiveQuerySchema (Task 3.2) has already validated `type` and coerced optional
    // `page`/`pageSize`; parsePaginationParams adds the upper-bound clamp (pageSize <=
    // MAX_PAGE_SIZE) so a huge `?pageSize` can never become an unbounded SQL LIMIT. Pass the
    // clamped NUMERIC page/pageSize to the service while preserving the validated type/search.
    const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);
    const result = await CorrespondenceService.getArchive({ ...req.query, page, pageSize });
    res.json(result);
  }));

  // 7. Attachments
  router.get("/attachments/:type/:id", authenticate, validateParams(typeIdParamSchema), asyncHandler(async (req, res) => {
    const type = req.params.type as string;
    const id = req.params.id as string;
    const data = await CorrespondenceService.getAttachments(type, id);
    res.json(data);
  }));

  router.post("/attachments", authenticate, checkPermission('Correspondence', 'Edit'), validateBody(correspondenceAttachmentSchema), asyncHandler(async (req, res) => {
    const userId = (req as any).user.id;
    await CorrespondenceService.addAttachment(req.body, userId);
    
    await AuthService.logAudit((req as any).user.username, "UPLOAD", "Correspondence", `Uploaded attachment for ${req.body.correspondence_type} ${req.body.correspondence_id}`);
    res.json({ success: true });
  }));

  // 8. Stats for Dashboard
  router.get("/stats", authenticate, asyncHandler(async (req, res) => {
    const stats = await CorrespondenceService.getStats();
    res.json(stats);
  }));

  // 9. Details (Unified)
  router.get("/details/:type/:id", authenticate, validateParams(typeIdParamSchema), asyncHandler(async (req, res) => {
    const type = req.params.type as string;
    const id = req.params.id as string;
    const details = await CorrespondenceService.getDetails(type, id);
    res.json(details);
  }));

  // Outgoing Letters Routes
  router.get("/outgoing", authenticate, asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);
    const result = await CorrespondenceService.getOutgoing(page, pageSize);
    res.json(result);
  }));

  router.post("/outgoing", authenticate, checkPermission('Correspondence', 'Create'), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as any;
    const body = { ...typedReq.body };
    const userId = typedReq.user.id;
    const username = typedReq.user.username;
    
    // Handle file upload if present
    const files = typedReq.files;
    if (files && files.attachment_file) {
      const fileOrFiles = files.attachment_file;
      const file = Array.isArray(fileOrFiles) ? fileOrFiles[0] : fileOrFiles;
      body.attachment_file = await saveFile(file);
    }

    const validation = outgoingSchema.safeParse(body);
    if (!validation.success) {
      throw new ValidationError("Invalid outgoing correspondence data", validation.error.format());
    }
    
    const result = await CorrespondenceService.createOutgoing(validation.data, userId);
    
    await AuthService.logAudit(username, "CREATE", "Correspondence", `Created outgoing letter: ${result.sequence_number}`);
        
    res.json(result);
  }));

  router.put("/outgoing/:id", authenticate, checkPermission('Correspondence', 'Edit'), validateParams(idParamSchema), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as any;
    const id = typedReq.params.id as string;
    const body = { ...typedReq.body };
    const username = typedReq.user.username;
    
    const files = typedReq.files;
    if (files && files.attachment_file) {
      const fileOrFiles = files.attachment_file;
      const file = Array.isArray(fileOrFiles) ? fileOrFiles[0] : fileOrFiles;
      body.attachment_file = await saveFile(file);
    }

    const validation = outgoingSchema.partial().safeParse(body);
    if (!validation.success) {
      throw new ValidationError("Invalid outgoing correspondence data", validation.error.format());
    }
    
    await CorrespondenceService.updateOutgoing(id, validation.data);
    
    await AuthService.logAudit(username, "UPDATE", "Correspondence", `Updated outgoing letter ID: ${id}`);
        
    res.json({ success: true });
  }));

  router.delete("/outgoing/:id", authenticate, checkPermission('Correspondence', 'Delete'), validateParams(idParamSchema), asyncHandler(async (req, res) => {
    const typedReq = req as unknown as any;
    const id = typedReq.params.id as string;
    const username = typedReq.user.username;
    
    await CorrespondenceService.deleteOutgoing(id);
    
    await AuthService.logAudit(username, "DELETE", "Correspondence", `Deleted outgoing letter ID: ${id}`);
        
    res.json({ success: true });
  }));

  return router;
};

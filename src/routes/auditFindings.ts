import express from 'express';
import { UploadedFile } from 'express-fileupload';
import { asyncHandler } from '../utils/asyncHandler';
import { AuditService, CreateFindingInput } from '../services/AuditService';
import { BaseService } from '../services/BaseService';
import { EvidenceStorageService } from '../services/EvidenceStorageService';
import { NotFoundError, ValidationError } from '../utils/errors';

export const createAuditFindingRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any
) => {
  const router = express.Router();

  // GET /audit-findings/by-plan/:planId - Get findings for a specific plan
  // Must be registered BEFORE /:id to prevent "by-plan" from matching as an id
  router.get('/by-plan/:planId', authenticate, checkPermission('AuditFindings', 'View'), asyncHandler(async (req, res) => {
    const planId = String(req.params.planId);
    const findings = await AuditService.getFindingsByPlan(planId);
    res.json({ success: true, data: findings });
  }));

  // GET /audit-findings - List findings with pagination
  router.get('/', authenticate, checkPermission('AuditFindings', 'View'), asyncHandler(async (req, res) => {
    const result = await AuditService.getFindings(req.query);
    res.json(result);
  }));

  // GET /audit-findings/:id - Get single finding
  router.get('/:id', authenticate, checkPermission('AuditFindings', 'View'), asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const result = await BaseService.findById('audit_findings', id);
    if (!result) throw new NotFoundError('Finding not found');
    res.json(result);
  }));

  // POST /audit-findings - Create finding with auto-recommendation
  router.post('/', authenticate, checkPermission('AuditFindings', 'Create'), asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const userId = typedReq.user.id;

    const input: CreateFindingInput = {
      audit_id: req.body.audit_id,
      title: req.body.title,
      description: req.body.description,
      criteria: req.body.criteria,
      condition: req.body.condition,
      finding_type: req.body.finding_type,
      consequence: req.body.consequence,
      risk_level: req.body.risk_level,
    };

    const result = await AuditService.createFinding(input, userId);

    res.status(201).json({
      success: true,
      findingId: result.findingId,
      recommendationId: result.recommendationId,
    });
  }));

  // PUT /audit-findings/:id - Update finding
  router.put('/:id', authenticate, checkPermission('AuditFindings', 'Edit'), asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const id = String(req.params.id);
    const userId = typedReq.user.id;

    await AuditService.updateFinding(id, req.body, userId);
    res.json({ success: true });
  }));

  // PATCH /audit-findings/:id/status - Change finding status
  router.patch('/:id/status', authenticate, checkPermission('AuditFindings', 'Edit'), asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const id = String(req.params.id);
    const { status } = req.body;
    const userId = typedReq.user.id;
    const userRole = typedReq.user.role;

    if (!status) {
      throw new ValidationError('الحالة مطلوبة / Status is required');
    }

    const result = await AuditService.changeFindingStatus(id, status, userId, userRole);
    res.json({ success: true, syncSuccess: result.syncSuccess });
  }));

  // DELETE /audit-findings/:id - Delete finding
  router.delete('/:id', authenticate, checkPermission('AuditFindings', 'Delete'), asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    await AuditService.deleteFinding(id);
    res.json({ success: true });
  }));

  // POST /audit-findings/:findingId/evidence - Upload evidence for a finding
  // Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
  router.post('/:findingId/evidence', authenticate, checkPermission('AuditFindings', 'Edit'), asyncHandler(async (req, res) => {
    const typedReq = req as any;
    const findingId = String(req.params.findingId);
    const userId = typedReq.user.id;

    // Validate file is present
    if (!typedReq.files || !typedReq.files.file) {
      throw new ValidationError('الملف مطلوب / File is required');
    }

    const uploadedFile: UploadedFile = Array.isArray(typedReq.files.file)
      ? typedReq.files.file[0]
      : typedReq.files.file;

    // Validate evidence metadata
    const { type, description } = req.body;
    if (!type || !description) {
      throw new ValidationError('نوع الدليل والوصف مطلوبان / Evidence type and description are required');
    }

    const validTypes = ['Document', 'Email', 'Screenshot', 'System Log', 'Contract'];
    if (!validTypes.includes(type)) {
      throw new ValidationError(`نوع الدليل غير صالح / Invalid evidence type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Map express-fileupload UploadedFile to EvidenceFile interface
    const evidenceFile = {
      originalname: uploadedFile.name,
      buffer: uploadedFile.data,
      mimetype: uploadedFile.mimetype,
    };

    const result = await EvidenceStorageService.attachEvidence(
      findingId,
      evidenceFile,
      { type, description },
      userId
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  }));

  // GET /audit-findings/:findingId/evidence - Get all evidence for a finding
  // Requirements: 8.1, 8.4
  router.get('/:findingId/evidence', authenticate, checkPermission('AuditFindings', 'View'), asyncHandler(async (req, res) => {
    const findingId = String(req.params.findingId);

    // Verify finding exists
    const finding = await BaseService.findById('audit_findings', findingId);
    if (!finding) {
      throw new NotFoundError('الملاحظة غير موجودة / Finding not found');
    }

    const evidence = await db.prepare(
      `SELECT id, audit_id, finding_id, evidence_number, type, description,
              uploaded_by, upload_date, file_name, file_path
       FROM audit_evidence
       WHERE finding_id = ?
       ORDER BY upload_date ASC`
    ).all(findingId);

    res.json({
      success: true,
      data: evidence,
    });
  }));

  return router;
};

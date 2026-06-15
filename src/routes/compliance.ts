import { Router } from 'express';
import { z } from 'zod';
import { ComplianceService } from '../services/ComplianceService';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

const itemSchema = z.object({
  ref_number:            z.string().min(1),
  title:                 z.string().min(1).max(500),
  source_type:           z.enum(['cbi_instruction', 'law', 'internal_policy', 'admin_decision']),
  issuing_authority:     z.string().optional().nullable(),
  category:              z.string().optional().nullable(),
  issue_date:            z.string().optional().nullable(),
  effective_date:        z.string().optional().nullable(),
  review_date:           z.string().optional().nullable(),
  compliance_status:     z.enum(['compliant', 'non_compliant', 'under_review']).optional(),
  maturity_score:        z.coerce.number().min(0).max(100).optional().nullable(),
  gap_notes:             z.string().optional().nullable(),
  responsible_person_id: z.string().uuid().optional().nullable(),
  department_id:         z.string().uuid().optional().nullable(),
  description:           z.string().optional().nullable(),
  keywords:              z.string().optional().nullable(),
  version:               z.string().optional().nullable(),
  attachment_path:       z.string().optional().nullable(),
});

export const createComplianceRoutes = (
  db: any, authenticate: any, checkPermission: any, logError: any, saveFile: any
) => {
  const router = Router();

  // GET /compliance
  router.get('/', authenticate, checkPermission('ComplianceMatrix', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const { source_type, compliance_status, search } = req.query as any;
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 20));
      const data = await ComplianceService.getAll({ source_type, compliance_status, search, page, pageSize });
      res.json({ success: true, data });
    })
  );

  // GET /compliance/summary
  router.get('/summary', authenticate, checkPermission('ComplianceMatrix', 'View'),
    asyncHandler(async (_req: any, res: any) => {
      const data = await ComplianceService.getSummary();
      res.json({ success: true, data });
    })
  );

  // GET /compliance/:id
  router.get('/:id', authenticate, checkPermission('ComplianceMatrix', 'View'),
    asyncHandler(async (req: any, res: any) => {
      const data = await ComplianceService.getById(req.params.id);
      res.json({ success: true, data });
    })
  );

  // POST /compliance
  router.post('/', authenticate, checkPermission('ComplianceMatrix', 'Create'),
    asyncHandler(async (req: any, res: any) => {
      const body = { ...req.body };
      
      // Handle file upload
      if (req.files && req.files.attachment) {
        const file = Array.isArray(req.files.attachment) ? req.files.attachment[0] : req.files.attachment;
        body.attachment_path = await saveFile(file);
      }

      const parsed = itemSchema.safeParse(body);
      if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.format());
      const result = await ComplianceService.create(parsed.data, req.user.id);
      res.status(201).json({ success: true, data: result });
    })
  );

  // PUT /compliance/:id
  router.put('/:id', authenticate, checkPermission('ComplianceMatrix', 'Edit'),
    asyncHandler(async (req: any, res: any) => {
      const body = { ...req.body };

      // Handle file upload
      if (req.files && req.files.attachment) {
        const file = Array.isArray(req.files.attachment) ? req.files.attachment[0] : req.files.attachment;
        body.attachment_path = await saveFile(file);
      }

      const parsed = itemSchema.partial().safeParse(body);
      if (!parsed.success) throw new ValidationError('Invalid data', parsed.error.format());
      await ComplianceService.update(req.params.id, parsed.data);
      res.json({ success: true });
    })
  );

  // PATCH /compliance/:id/status
  router.patch('/:id/status', authenticate, checkPermission('ComplianceMatrix', 'Edit'),
    asyncHandler(async (req: any, res: any) => {
      const { compliance_status } = req.body;
      const allowed = ['compliant', 'non_compliant', 'under_review'];
      if (!allowed.includes(compliance_status)) {
        throw new ValidationError('Invalid status value');
      }
      await ComplianceService.update(req.params.id, { compliance_status });
      res.json({ success: true });
    })
  );

  // DELETE /compliance/:id
  router.delete('/:id', authenticate, checkPermission('ComplianceMatrix', 'Delete'),
    asyncHandler(async (req: any, res: any) => {
      await ComplianceService.softDelete(req.params.id, req.user.id);
      res.json({ success: true });
    })
  );

  return router;
};

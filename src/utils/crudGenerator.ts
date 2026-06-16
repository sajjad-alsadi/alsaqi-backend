import express from 'express';
import { AuthenticatedRequest, FileUploadRequest } from '../types';
import { asyncHandler } from './asyncHandler';
import { ValidationError, NotFoundError } from './errors';
import { BaseService } from '../services/BaseService';
import { AuthService } from '../services/AuthService';
import { AuditPlanService } from '../services/AuditPlanService';
import { RiskService } from '../services/RiskService';
import { registerRoutes } from './routeRegistry';
import { parsePaginationParams } from './paginationService';
import fs from 'fs';
import path from 'path';

/**
 * Route names excluded from CRUD generation because they have custom route files.
 * These resources are handled by dedicated route modules with specialized logic.
 */
export const CRUD_EXCLUDED_ROUTES: string[] = [
  'audit-tasks',
  'audit-programs',
  'recommendations',
  'audit-findings',
  // compliance-items is served exclusively by the canonical custom route
  // /api/v1/compliance (createComplianceRoutes); excluding it here prevents the
  // generic generateRoutes call from registering a duplicate /api/compliance-items route.
  'compliance-items',
];

export const createCrudRoutes = (
  db: any,
  authenticate: any,
  checkPermission: any,
  logError: any,
  createNotification: any,
  saveFile: any
) => {
  const router = express.Router();

  const ALLOWED_TABLES = [
    "audit_plans", "audit_tasks", "audit_programs", "audit_procedures", 
    "audit_evidence", "risk_register", "fraud_log", "central_bank_instructions", 
    "law_bank", "audit_reports", "audit_findings", "recommendations", "compliance_items"
  ];

  const TABLE_ALLOWED_FIELDS: Record<string, string[]> = {
    "audit_plans": ["plan_code", "program_id", "title", "department", "type", "risk_rating", "planned_start_date", "planned_end_date", "status", "lead_auditor", "team_members", "objectives", "scope", "notes", "year", "quarter"],
    "audit_tasks": ["task_number", "title", "plan_id", "program_id", "audit_type", "task_type", "status", "assigned_to", "audited_unit_id", "planned_hours", "actual_hours", "period_from", "period_to", "due_date", "approved_by", "approved_at", "created_by", "deleted_at"],
    "audit_programs": ["program_code", "program_title", "audit_area", "department", "audit_type", "audit_objective", "audit_scope", "key_risks", "control_objectives", "reference_standard", "status", "version_number", "created_by"],
    "audit_procedures": ["program_id", "procedure_number", "audit_step", "audit_test_description", "risk_addressed", "control_test_type", "expected_evidence", "sampling_method", "responsible_auditor", "remarks"],
    "audit_evidence": ["audit_id", "finding_id", "type", "description", "uploaded_by", "file_name", "file_data", "upload_date"],
    "risk_register": ["risk_id", "description", "owner", "source", "early_warning", "type", "likelihood", "impact", "likelihood_num", "impact_num", "risk_score_calc", "risk_level_calc", "score", "rating", "controls", "control_assessment", "mitigation", "treatment_option", "residual_likelihood", "residual_impact", "residual_score", "residual_rating", "status", "target_date", "review_date", "notes", "entry_date", "entered_by"],
    "fraud_log": ["incident_date", "description", "reported_by", "status"],
    "central_bank_instructions": ["title", "issue_date", "reference_number", "category", "description", "related_department", "attachment", "status", "related_instruction_id"],
    "law_bank": ["title", "type", "authority", "issue_date", "keywords", "bookmarked", "file_url"],
    "audit_reports": ["audit_id", "title", "report_type", "generated_by", "date_generated", "status", "content"],
    "audit_findings": ["audit_id", "title", "description", "criteria", "condition", "cause", "consequence", "recommendation", "risk_level", "status", "finding_number", "finding_type", "impact", "root_cause", "responsible_unit_id", "risk_id", "created_by", "deleted_at"],
    "recommendations": ["finding_id", "department", "responsible", "due_date", "status", "risk_level", "rec_number", "action_plan", "responsible_person_id", "priority", "follow_up_date", "closure_evidence_path", "closed_by", "closed_at", "created_by"],
    "compliance_items": ["ref_number", "title", "type", "issuing_authority", "issue_date", "effective_date", "compliance_status", "responsible_person_id", "attachment_path", "notes", "created_by"]
  };

  const generateRoutes = (tableName: string, routeName: string, moduleName: string) => {
    if (!ALLOWED_TABLES.includes(tableName)) {
      console.error(`Attempt to generate CRUD routes for unauthorized table: ${tableName}`);
      return;
    }

    // Skip routes that have custom route files to prevent duplicate registration
    if (CRUD_EXCLUDED_ROUTES.includes(routeName)) {
      return;
    }

    // Register routes in the route registry for duplicate detection
    registerRoutes(
      ['GET', 'POST', 'PUT', 'DELETE'],
      `/api/${routeName}`,
      'crudGenerator'
    );

    router.get(`/${routeName}`, authenticate, checkPermission(moduleName, 'View'), asyncHandler(async (req, res) => {
      const { page, pageSize } = parsePaginationParams(req.query as Record<string, any>);

      // Extract all query params except page and pageSize as candidate filters
      const { page: _, pageSize: __, ...rawFilters } = req.query;

      const allowedFields = TABLE_ALLOWED_FIELDS[tableName] || [];

      // Only accept whitelisted filter keys (mass-filter / column-injection
      // prevention). Arbitrary req.query keys are no longer passed through as
      // `where` filters (finding 1.15 → 2.15).
      const filters: Record<string, any> = {};
      for (const key of Object.keys(rawFilters)) {
        if (allowedFields.includes(key)) {
          filters[key] = (rawFilters as Record<string, any>)[key];
        }
      }

      const excludeFromSelect = ['file_data', 'content', 'attachment_file', 'attachment', 'file_url'];
      const selectFields = ['id', 'created_at', 'updated_at', ...allowedFields.filter(f => !excludeFromSelect.includes(f))];

      const result = await BaseService.findAll(tableName, { 
        page, 
        pageSize,
        where: filters,
        select: selectFields
      });
      res.json(result);
    }));

    router.get(`/${routeName}/:id`, authenticate, checkPermission(moduleName, 'View'), asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const result = await BaseService.findById(tableName, id);
      if (!result) throw new NotFoundError(`${tableName} record not found`);
      res.json(result);
    }));

    router.post(`/${routeName}`, authenticate, checkPermission(moduleName, 'Create'), asyncHandler(async (req, res) => {
      const typedReq = req as unknown as FileUploadRequest;
      const rawBody = { ...typedReq.body };
      
      // Strict Whitelisting (Mass Assignment Prevention)
      const body: any = {};
      const allowedFields = TABLE_ALLOWED_FIELDS[tableName] || [];
      for (const key of Object.keys(rawBody)) {
        if (allowedFields.includes(key)) {
          body[key] = rawBody[key];
        }
      }
      
      // Handle file uploads if present
      const files = typedReq.files;
      if (files) {
        for (const key of Object.keys(files)) {
          if (!allowedFields.includes(key)) continue;
          const fileOrFiles = files[key];
          const file = Array.isArray(fileOrFiles) ? fileOrFiles[0] : fileOrFiles;
          body[key] = await saveFile(file);
        }
      }

      const service = tableName === 'audit_plans' ? AuditPlanService : (tableName === 'risk_register' ? RiskService : BaseService);
      let result;
      try {
        result = await service.create(tableName, body);
      } catch (err) {
        // Cleanup orphaned files if DB fails
        if (files) {
          for (const key of Object.keys(files)) {
            if (body[key] && typeof body[key] === 'string' && body[key].startsWith('/uploads/')) {
              const filePath = path.join(process.cwd(), body[key]);
              fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                  console.error(`[DB Failure Cleanup] Failed to delete orphaned file: ${filePath}`, unlinkErr);
                }
              });
            }
          }
        }
        throw err;
      }
      
      await AuthService.logAudit(typedReq.user.username, `Created ${tableName}`, routeName, JSON.stringify(body));
      
      // Targeted notification based on module type
      const actorId = typedReq.user?.id;
      const wss = (req.app as any).wss;
      const notifyOptions = { actorId, entityId: result?.id, entityType: tableName, wss };
      
      // Determine who to notify based on the table/module
      let targetUsers: string | string[] | 'all' = 'all';
      let notifType = 'record_created';
      let notifMessage = JSON.stringify({ key: 'notifications.newRecord', params: { module: tableName } });
      let notifTitle: string | undefined;
      
      if (tableName === 'risk_register' && body.owner) {
        // Notify risk owner + admins
        const { NotificationService: NS } = await import('../services/NotificationService');
        const ownerId = await NS.getUserIdByName(body.owner);
        const adminIds = await NS.getAdminIds();
        targetUsers = [...new Set([...(ownerId ? [ownerId] : []), ...adminIds])];
        notifType = 'risk_added';
        notifMessage = JSON.stringify({ key: 'notifications.riskAdded', params: { description: body.description || body.risk_id || '' } });
        notifTitle = JSON.stringify({ key: 'notifications.riskAdded' });
      } else if (tableName === 'recommendations' && body.responsible_person_id) {
        targetUsers = body.responsible_person_id;
        notifType = 'recommendation_added';
        notifMessage = JSON.stringify({ key: 'notifications.recommendationAdded' });
        notifTitle = JSON.stringify({ key: 'notifications.recommendationAdded' });
      } else if (tableName === 'audit_tasks' && body.assigned_to) {
        targetUsers = body.assigned_to;
        notifType = 'task_assigned';
        notifMessage = JSON.stringify({ key: 'notifications.taskAssigned', params: { title: body.title || '' } });
        notifTitle = JSON.stringify({ key: 'notifications.taskAssigned' });
      } else if (tableName === 'audit_findings') {
        // Notify admins for new findings
        const { NotificationService: NS } = await import('../services/NotificationService');
        targetUsers = await NS.getAdminIds();
        notifType = 'finding_added';
        notifMessage = JSON.stringify({ key: 'notifications.findingAdded', params: { title: body.title || '' } });
        notifTitle = JSON.stringify({ key: 'notifications.findingAdded' });
      } else if (tableName === 'audit_evidence') {
        notifType = 'evidence_uploaded';
        notifMessage = JSON.stringify({ key: 'notifications.evidenceUploaded', params: { description: body.description || body.file_name || '' } });
        notifTitle = JSON.stringify({ key: 'notifications.evidenceUploaded' });
      }
      
      await createNotification(targetUsers, notifType, notifMessage, routeName, `/${routeName}`, { ...notifyOptions, title: notifTitle });

      res.json(result);
    }));

    router.put(`/${routeName}/:id`, authenticate, checkPermission(moduleName, 'Edit'), asyncHandler(async (req, res) => {
      const typedReq = req as unknown as FileUploadRequest;
      const id = typedReq.params.id as string;
      const rawBody = { ...typedReq.body };
      
      // Strict Whitelisting (Mass Assignment Prevention)
      const body: any = {};
      const allowedFields = TABLE_ALLOWED_FIELDS[tableName] || [];
      for (const key of Object.keys(rawBody)) {
        if (allowedFields.includes(key)) {
          body[key] = rawBody[key];
        }
      }
      
      // Handle file uploads if present
      const files = typedReq.files;
      if (files) {
        for (const key of Object.keys(files)) {
          if (!allowedFields.includes(key)) continue;
          const fileOrFiles = files[key];
          const file = Array.isArray(fileOrFiles) ? fileOrFiles[0] : fileOrFiles;
          body[key] = await saveFile(file);
        }
      }

      const service = tableName === 'audit_plans' ? AuditPlanService : (tableName === 'risk_register' ? RiskService : BaseService);
      let result;
      try {
        result = await service.update(tableName, id, body);
      } catch (err) {
        // Cleanup orphaned files if DB fails
        if (files) {
          for (const key of Object.keys(files)) {
            if (body[key] && typeof body[key] === 'string' && body[key].startsWith('/uploads/')) {
              const filePath = path.join(process.cwd(), body[key]);
              fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                  console.error(`[DB Failure Cleanup] Failed to delete orphaned file: ${filePath}`, unlinkErr);
                }
              });
            }
          }
        }
        throw err;
      }

      await AuthService.logAudit(typedReq.user.username, `Updated ${tableName} ID: ${id}`, routeName, JSON.stringify(body));

      res.json(result);
    }));

    router.delete(`/${routeName}/:id`, authenticate, checkPermission(moduleName, 'Delete'), asyncHandler(async (req, res) => {
      const typedReq = req as unknown as AuthenticatedRequest;
      const id = typedReq.params.id as string;
      
      await BaseService.delete(tableName, id);
      
      await AuthService.logAudit(typedReq.user.username, `Deleted ${tableName} ID: ${id}`, routeName, JSON.stringify({ id }));
      res.json({ success: true });
    }));
  };

  generateRoutes("audit_plans", "audit-plans", "AuditPlans");
  generateRoutes("audit_tasks", "audit-tasks", "AuditTasks");
  generateRoutes("audit_programs", "audit-programs", "AuditProgramLibrary");
  generateRoutes("audit_procedures", "audit-procedures", "AuditProgramLibrary");
  generateRoutes("audit_evidence", "audit-evidence", "AuditEvidence");
  generateRoutes("risk_register", "risk-register", "RiskRegister");
  generateRoutes("fraud_log", "fraud-log", "IntegrityManagement");
  generateRoutes("central_bank_instructions", "central-bank-instructions", "Policies");
  generateRoutes("law_bank", "law-bank", "Policies");
  generateRoutes("audit_reports", "audit-reports", "Reports");
  generateRoutes("audit_findings", "audit-findings", "AuditFindings");
  generateRoutes("recommendations", "recommendations", "Recommendations");
  generateRoutes("compliance_items", "compliance-items", "ComplianceMatrix");

  return router;
};

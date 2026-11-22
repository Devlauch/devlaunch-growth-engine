import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  evaluateQualification,
  requireQualifiedOrOverride,
  findOrCreateCompanyForLead,
  findOrCreateContactForLead,
  assignLeadToUser,
  autoAssignLeadRoundRobin,
  getQualificationThreshold,
  type LeadRow,
  type LeadScoreRow,
} from "../lib/leadPromotion.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/promote-to-crm
 *
 * The one explicit action that turns a qualified `leads` row (discovery
 * pipeline, public widget, manual entry — any source) into a real,
 * assignable CRM record: a `companies` link, a `contacts` row, and
 * (optionally) a `lead_assignments` row. See apps/api/src/lib/
 * leadPromotion.ts's header comment for the full design rationale and the
 * exact gap this closes. Never automatic/silent — this only runs when a
 * human calls this endpoint for one specific lead.
 */
export const leadPromotionRouter = Router({ mergeParams: true });
leadPromotionRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

const promoteBodySchema = z
  .object({
    override: z.boolean().optional().default(false),
    overrideReason: z.string().trim().max(2000).optional(),
    assignedUserId: z.string().uuid().optional(),
    autoAssign: z.boolean().optional().default(false),
  })
  .refine((body) => !(body.assignedUserId && body.autoAssign), {
    message: "Provide either assignedUserId or autoAssign, not both",
  });

/**
 * POST /leads/:leadId/promote-to-crm
 *
 * Body (all optional):
 *   override        - promote even if the lead hasn't crossed the
 *                      qualification threshold yet (status 'qualified' or
 *                      lead_scores.total_score >= 50 — see
 *                      QUALIFIED_SCORE_THRESHOLD).
 *   overrideReason   - recorded on the audit event when override is used.
 *   assignedUserId   - assign the lead to this specific active tenant
 *                      member (validated the same way POST
 *                      /deals/assignments validates it).
 *   autoAssign       - round-robin-assign to an active tenant member if the
 *                      lead has no current assignment yet.
 *
 * Idempotent: calling this again for the same lead reuses the existing
 * company/contact rather than duplicating them, and autoAssign is a no-op
 * once the lead already has an assignment.
 */
leadPromotionRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    const body = promoteBodySchema.parse(req.body);

    const leadResult = await req.tenantDb!.query<LeadRow>(
      `SELECT id, tenant_id, project_id, name, email, company, company_id, status, custom_fields
       FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    if (leadResult.rowCount === 0) throw Errors.notFound("Lead not found");
    const lead = leadResult.rows[0];

    const scoreResult = await req.tenantDb!.query<LeadScoreRow>(
      `SELECT total_score FROM lead_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    const threshold = await getQualificationThreshold(req.tenantDb!, req.tenantId!, projectId);
    const qualification = evaluateQualification(lead, scoreResult.rows[0] ?? null, threshold);
    requireQualifiedOrOverride(qualification, body.override);

    const companyResult = await findOrCreateCompanyForLead(req.tenantDb!, req.tenantId!, projectId, req.userId!, lead);
    if (companyResult.company && !lead.company_id) {
      await req.tenantDb!.query(`UPDATE leads SET company_id = $1 WHERE id = $2 AND tenant_id = $3`, [
        companyResult.company.id,
        leadId,
        req.tenantId,
      ]);
    }

    const contactResult = await findOrCreateContactForLead(
      req.tenantDb!,
      req.tenantId!,
      projectId,
      req.userId!,
      lead,
      (companyResult.company?.id as string | undefined) ?? lead.company_id ?? null,
    );

    let assignmentResult: Awaited<ReturnType<typeof assignLeadToUser>> | null = null;
    if (body.assignedUserId) {
      assignmentResult = await assignLeadToUser(
        req.tenantDb!,
        req.tenantId!,
        projectId,
        leadId,
        body.assignedUserId,
        req.userId!,
      );
    } else if (body.autoAssign) {
      assignmentResult = await autoAssignLeadRoundRobin(req.tenantDb!, req.tenantId!, projectId, leadId, req.userId!);
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'lead.promoted_to_crm', 'lead', $3, $4::jsonb)`,
      [
        req.tenantId,
        req.userId,
        leadId,
        JSON.stringify({
          qualification,
          overridden: !qualification.met && body.override,
          overrideReason: body.overrideReason ?? null,
          companyId: companyResult.company?.id ?? null,
          companyCreated: companyResult.created,
          contactId: contactResult.contact.id,
          contactCreated: contactResult.created,
          assignmentId: assignmentResult?.assignment?.id ?? null,
          assignmentCreated: assignmentResult?.created ?? false,
          assignmentSkippedReason: assignmentResult?.skippedReason ?? null,
        }),
      ],
    );

    res.status(200).json({
      promotion: {
        leadId,
        qualification,
        company: companyResult.company,
        companyCreated: companyResult.created,
        contact: contactResult.contact,
        contactCreated: contactResult.created,
        assignment: assignmentResult?.assignment ?? null,
        assignmentCreated: assignmentResult?.created ?? false,
        assignmentSkippedReason: assignmentResult?.skippedReason ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

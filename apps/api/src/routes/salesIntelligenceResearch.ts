import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { getCompanyIntelligence } from "../lib/companyIntelligence.js";
import { buildProspectResearchSummary, DEFAULT_TARGET_ROLES } from "../lib/prospectResearchSummary.js";

/**
 * Workstream G1 — company-level research + decision-maker identification.
 *
 * Mounted (see this file's handback for the exact app.ts line, NOT applied
 * here per this workstream's hard rule against editing app.ts) at:
 *   /api/v1/tenants/:tenantId/projects/:projectId/companies/:companyId/intelligence
 *
 * Same auth/tenant-membership/mergeParams convention as every other nested
 * router in this codebase (e.g. routes/replies.ts mounted under
 * .../leads/:leadId/replies). Read-only: this route aggregates existing
 * data via companyIntelligence.ts / prospectResearchSummary.ts — it never
 * writes a new fact about a company.
 */
export const salesIntelligenceResearchRouter = Router({ mergeParams: true });
salesIntelligenceResearchRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

const querySchema = z.object({
  targetRoles: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined)),
});

/**
 * GET / — the full aggregated company-intelligence result: tracked
 * contacts + a live decision-maker provider waterfall run, firmographics,
 * website intelligence (best-effort), deal/lead history, a deterministic
 * research summary, and decision-makers ranked against `targetRoles`
 * (comma-separated query param, defaults to DEFAULT_TARGET_ROLES).
 */
salesIntelligenceResearchRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const companyId = paramId(req, "companyId");
    const { targetRoles } = querySchema.parse(req.query);

    const [intelligence, researchSummary] = await Promise.all([
      getCompanyIntelligence(req.tenantDb!, req.tenantId!, projectId, companyId),
      buildProspectResearchSummary(req.tenantDb!, req.tenantId!, projectId, companyId, {
        targetRoles: targetRoles ?? DEFAULT_TARGET_ROLES,
      }),
    ]);

    res.json({ intelligence, researchSummary });
  } catch (err) {
    next(err);
  }
});

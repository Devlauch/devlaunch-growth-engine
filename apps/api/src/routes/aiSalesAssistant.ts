import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { summarizeDealForHandoff, draftObjectionResponse } from "../lib/aiSalesAssistant.js";

/**
 * aiSalesAssistantRouter: Milestone 5 (P4) section 4 — a NEW route (does
 * NOT touch apps/api/src/routes/deals.ts or dealHealth.ts), mounted at
 *   /api/v1/tenants/:tenantId/projects/:projectId/deals/:dealId/ai-assistant
 * (exact app.ts wiring line given in this milestone's handback — app.ts
 * itself is never edited per this task's constraints).
 *
 * Both endpoints ALWAYS return a complete, real, deterministic result (see
 * aiSalesAssistant.ts's header comment) plus an `llm` field whose `status`
 * honestly reports "not_configured" (no ANTHROPIC_API_KEY set — every
 * environment this codebase has actually run in today),
 * "budget_exceeded", "error", or "ok" with real generated text. Never a 5xx
 * just because no LLM is configured.
 */
export const aiSalesAssistantRouter = Router({ mergeParams: true });
aiSalesAssistantRouter.use(requireAuth, requireTenantMembership);

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

/** GET /deals/:dealId/ai-assistant/handoff-summary */
aiSalesAssistantRouter.get("/handoff-summary", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const dealId = paramId(req, "dealId");
    await assertProjectInTenant(req, projectId);

    const summary = await summarizeDealForHandoff(req.tenantDb!, req.tenantId!, projectId, dealId);
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

const objectionSchema = z.object({
  objectionText: z.string().trim().min(1).max(2000),
});

/** POST /deals/:dealId/ai-assistant/objection-response */
aiSalesAssistantRouter.post("/objection-response", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const dealId = paramId(req, "dealId");
    await assertProjectInTenant(req, projectId);
    const body = objectionSchema.parse(req.body);

    const draft = await draftObjectionResponse(req.tenantDb!, req.tenantId!, projectId, dealId, body.objectionText);
    res.json({ draft });
  } catch (err) {
    next(err);
  }
});

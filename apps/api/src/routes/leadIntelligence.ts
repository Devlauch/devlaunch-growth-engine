import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { enrichLead } from "../lib/companyEnrichment.js";
import { matchLeadToAllIcps } from "../lib/icpMatching.js";
import { detectBuyingSignals } from "../lib/buyingSignals.js";

/**
 * Lead Intelligence: a complementary layer on top of the EXISTING
 * rubric-based scoring system (scoring_rubrics/lead_scores, see
 * routes/scoring.ts). Nothing here edits or recomputes lead_scores — the
 * /explain endpoint only *reads* it (read-only) to compose a combined
 * explanation alongside this feature's own data: company enrichment,
 * ICP-fit matches, and buying signals.
 *
 * Mounted at:
 *   /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/intelligence
 */
export const leadIntelligenceRouter = Router({ mergeParams: true });
leadIntelligenceRouter.use(requireAuth, requireTenantMembership);

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

async function loadLeadOr404(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Company enrichment
// ---------------------------------------------------------------------------

/** POST /enrich */
leadIntelligenceRouter.post("/enrich", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);

    const result = await enrichLead(req.tenantDb!, req.tenantId!, projectId, leadId);
    res.status(201).json({ enrichment: result.enrichment });
  } catch (err) {
    next(err);
  }
});

/** GET /enrichment */
leadIntelligenceRouter.get("/enrichment", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM company_enrichment WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No enrichment computed for this lead yet");

    res.json({ enrichment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ICP matching
// ---------------------------------------------------------------------------

/** POST /icp-match */
leadIntelligenceRouter.post("/icp-match", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);

    const matches = await matchLeadToAllIcps(req.tenantDb!, req.tenantId!, projectId, leadId);
    res.status(201).json({ matches });
  } catch (err) {
    next(err);
  }
});

/** GET /icp-match */
leadIntelligenceRouter.get("/icp-match", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM icp_match_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3 ORDER BY match_score DESC`,
      [leadId, req.tenantId, projectId],
    );
    res.json({ matches: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Buying signals
// ---------------------------------------------------------------------------

const buyingSignalsInputSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  sourceUrl: z.string().trim().url().max(2000).optional(),
});

/**
 * POST /buying-signals — the caller supplies the text to scan (e.g. from a
 * discovered org's raw_metadata or a crawled page, assembled elsewhere);
 * this endpoint doesn't fetch anything itself, it only classifies text it's
 * handed.
 */
leadIntelligenceRouter.post("/buying-signals", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);
    const body = buyingSignalsInputSchema.parse(req.body);

    const detected = detectBuyingSignals(body.text, body.sourceUrl);

    const inserted: unknown[] = [];
    for (const signal of detected) {
      const result = await req.tenantDb!.query(
        `INSERT INTO buying_signals (tenant_id, project_id, lead_id, signal_type, detail, source_url, confidence, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         RETURNING *`,
        [req.tenantId, projectId, leadId, signal.signalType, signal.detail, signal.sourceUrl ?? null, signal.confidence],
      );
      inserted.push(result.rows[0]);
    }

    res.status(201).json({ signals: inserted });
  } catch (err) {
    next(err);
  }
});

/** GET /buying-signals */
leadIntelligenceRouter.get("/buying-signals", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM buying_signals WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3 ORDER BY detected_at DESC`,
      [leadId, req.tenantId, projectId],
    );
    res.json({ signals: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

function buildExplanationSummary(
  rubricScore: Record<string, unknown> | null,
  icpMatches: Record<string, unknown>[],
  buyingSignalRows: Record<string, unknown>[],
): string {
  const sentences: string[] = [];

  if (rubricScore) {
    sentences.push(`Scored ${rubricScore.total_score}/100 on the active rubric.`);
  }

  const bestIcpMatch = icpMatches[0];
  if (bestIcpMatch && Number(bestIcpMatch.match_score) > 0) {
    const name = (bestIcpMatch as Record<string, unknown>).icp_profile_name;
    const reasons = ((bestIcpMatch.match_reasons ?? []) as string[]) ?? [];
    const reasonText = reasons.length > 0 ? `: ${reasons[0]}` : "";
    sentences.push(`Matches the '${name ?? "best-fit"}' ICP (${bestIcpMatch.match_score}% fit${reasonText}).`);
  }

  if (buyingSignalRows.length > 0) {
    const first = buyingSignalRows[0];
    const suffix = buyingSignalRows.length === 1 ? "" : "s";
    sentences.push(
      `${buyingSignalRows.length} buying signal${suffix} detected: ${first.signal_type} (${first.confidence} confidence).`,
    );
  }

  if (sentences.length === 0) {
    return "No rubric score, ICP match, or buying signal is available yet for this lead.";
  }

  return sentences.join(" ");
}

/**
 * GET /explain — composes a real summary from whichever of the following
 * are actually present for this lead: the EXISTING lead_scores row
 * (read-only — never written by this route), this lead's icp_match_scores,
 * its buying_signals, and its company_enrichment. Any clause for data that
 * doesn't exist is simply omitted — never padded with invented detail.
 */
leadIntelligenceRouter.get("/explain", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const [rubricScoreResult, icpMatchesResult, buyingSignalsResult, enrichmentResult] = await Promise.all([
      req.tenantDb!.query(`SELECT * FROM lead_scores WHERE lead_id = $1`, [leadId]),
      req.tenantDb!.query(
        `SELECT ims.*, icp.name AS icp_profile_name
         FROM icp_match_scores ims
         JOIN icp_profiles icp ON icp.id = ims.icp_profile_id
         WHERE ims.lead_id = $1 AND ims.tenant_id = $2 AND ims.project_id = $3
         ORDER BY ims.match_score DESC`,
        [leadId, req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT * FROM buying_signals WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3 ORDER BY detected_at DESC`,
        [leadId, req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT * FROM company_enrichment WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
        [leadId, req.tenantId, projectId],
      ),
    ]);

    const rubricScore = rubricScoreResult.rowCount && rubricScoreResult.rowCount > 0 ? rubricScoreResult.rows[0] : null;
    const icpMatches = icpMatchesResult.rows;
    const buyingSignalRows = buyingSignalsResult.rows;
    const enrichment = enrichmentResult.rowCount && enrichmentResult.rowCount > 0 ? enrichmentResult.rows[0] : null;

    res.json({
      rubricScore,
      icpMatches,
      buyingSignals: buyingSignalRows,
      enrichment,
      summary: buildExplanationSummary(rubricScore, icpMatches, buyingSignalRows),
    });
  } catch (err) {
    next(err);
  }
});

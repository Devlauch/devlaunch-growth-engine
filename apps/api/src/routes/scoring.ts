import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { normalizeDomain, normalizeOrgName } from "../lib/dedup.js";
import { scoreLead, type ScoreLeadCriterion, type ScoreLeadEvidenceEntry } from "../lib/scoreLead.js";

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

// ---------------------------------------------------------------------------
// scoring_rubrics
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/scoring-rubrics */
export const scoringRubricsRouter = Router({ mergeParams: true });
scoringRubricsRouter.use(requireAuth, requireTenantMembership);

const rubricCriterionSchema = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(500),
  weight: z.number().positive(),
  description: z.string().trim().max(2000).optional(),
});

const createRubricSchema = z.object({
  name: z.string().trim().min(1).max(200),
  criteria: z.array(rubricCriterionSchema).min(1).max(100).default([]),
  isActive: z.boolean().optional(),
});

const updateRubricSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    criteria: z.array(rubricCriterionSchema).min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET /scoring-rubrics */
scoringRubricsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
      [req.tenantId, projectId],
    );
    res.json({ scoringRubrics: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /scoring-rubrics */
scoringRubricsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createRubricSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO scoring_rubrics (tenant_id, project_id, name, criteria, is_active)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [req.tenantId, projectId, body.name, JSON.stringify(body.criteria), body.isActive ?? true],
    );

    res.status(201).json({ scoringRubric: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /scoring-rubrics/:id */
scoringRubricsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const rubricId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const body = updateRubricSchema.parse(req.body);

    const existing = await req.tenantDb!.query(
      `SELECT 1 FROM scoring_rubrics WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [rubricId, req.tenantId, projectId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Scoring rubric not found");

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) {
      fields.push(`name = $${++i}`);
      values.push(body.name);
    }
    if (body.criteria !== undefined) {
      fields.push(`criteria = $${++i}::jsonb`);
      values.push(JSON.stringify(body.criteria));
    }
    if (body.isActive !== undefined) {
      fields.push(`is_active = $${++i}`);
      values.push(body.isActive);
    }

    const result = await req.tenantDb!.query(
      `UPDATE scoring_rubrics SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      [rubricId, ...values],
    );

    res.json({ scoringRubric: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// lead_scores (+ lead_score_feedback)
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/lead-scores */
export const leadScoresRouter = Router({ mergeParams: true });
leadScoresRouter.use(requireAuth, requireTenantMembership);

async function loadLeadOr404(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
  return r.rows[0];
}

/** GET /lead-scores/:leadId — the current score for a lead, 404 if none exists yet. */
leadScoresRouter.get("/:leadId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM lead_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No score computed for this lead yet");

    res.json({ leadScore: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const feedbackSchema = z.object({
  feedback: z.enum(["good", "bad"]),
  note: z.string().trim().max(2000).optional(),
});

/** POST /lead-scores/:leadId/feedback — "good lead / bad lead" button. */
leadScoresRouter.post("/:leadId/feedback", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);
    const body = feedbackSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO lead_score_feedback (tenant_id, lead_id, user_id, feedback, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.tenantId, leadId, req.userId, body.feedback, body.note ?? null],
    );

    res.status(201).json({ feedback: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

function isNonEmptyEvidenceValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true; // numbers, booleans
}

/**
 * Best-effort, honestly-heuristic evidence assembly for /recompute. This is
 * NOT NLP, has no access to crawled pages, and will under-match — false
 * negatives (marking a criterion absent when it's secretly true) are
 * accepted as the cost of never over-claiming evidence that isn't really
 * there (false positives are not acceptable). Per rubric criterion, in
 * order:
 *   1. The lead's own `custom_fields` jsonb for a key matching the
 *      criterion's `key` case-insensitively, with a non-empty value.
 *   2. Failing that, a `discovered_organizations` row in the same project
 *      matched by normalized email domain (if the lead has an email) or
 *      normalized company name (if the lead has a company) — and, if one
 *      matches, that org's `raw_metadata` plus its `discovered_contacts`
 *      rows (name/role/email/phone/source_url) searched case-insensitively
 *      for the criterion's key (read with underscores/dashes as spaces) or
 *      its exact label text.
 * Anything not matched by either check is marked `present: false` — when
 * genuinely unsure, we say so rather than guess.
 */
function buildRecomputeEvidenceMap(
  lead: Record<string, unknown>,
  criteria: ScoreLeadCriterion[],
  matchedOrg: Record<string, unknown> | null,
  contacts: Record<string, unknown>[],
): Record<string, ScoreLeadEvidenceEntry> {
  const customFields = (lead.custom_fields ?? {}) as Record<string, unknown>;
  const customFieldsLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(customFields)) {
    customFieldsLower.set(k.toLowerCase(), v);
  }

  const orgHaystackParts: string[] = [];
  if (matchedOrg) {
    orgHaystackParts.push(String(matchedOrg.name ?? ""));
    orgHaystackParts.push(JSON.stringify(matchedOrg.raw_metadata ?? {}));
  }
  for (const contact of contacts) {
    orgHaystackParts.push(
      [contact.name, contact.role_title, contact.email, contact.phone, contact.source_url]
        .filter((v): v is string => typeof v === "string")
        .join(" "),
    );
  }
  const orgHaystack = orgHaystackParts.join(" \n ").toLowerCase();

  const evidence: Record<string, ScoreLeadEvidenceEntry> = {};
  for (const criterion of criteria) {
    const fieldValue = customFieldsLower.get(criterion.key.toLowerCase());
    if (isNonEmptyEvidenceValue(fieldValue)) {
      evidence[criterion.key] = {
        present: true,
        summary: `Lead's custom_fields.${criterion.key} is set`,
        source: "lead.custom_fields",
      };
      continue;
    }

    if (matchedOrg) {
      const keyPhrase = criterion.key.replace(/[_-]+/g, " ").trim().toLowerCase();
      const labelLower = criterion.label.trim().toLowerCase();
      const matchedKeyPhrase = keyPhrase.length >= 3 && orgHaystack.includes(keyPhrase);
      const matchedLabel = labelLower.length >= 3 && orgHaystack.includes(labelLower);
      if (matchedKeyPhrase || matchedLabel) {
        evidence[criterion.key] = {
          present: true,
          summary: `Found "${matchedKeyPhrase ? keyPhrase : labelLower}" in discovered org/contact data for ${String(matchedOrg.name ?? "this organization")}`,
          source: `discovered_organizations:${String(matchedOrg.id)}`,
        };
        continue;
      }
    }

    evidence[criterion.key] = { present: false };
  }

  return evidence;
}

/**
 * POST /lead-scores/:leadId/recompute
 *
 * Loads the project's active scoring_rubrics row (404 if none), assembles a
 * best-effort evidence map per criterion (see buildRecomputeEvidenceMap's
 * doc comment for exactly what it checks and why it's a heuristic), scores
 * the lead with the same pure algorithm as the worker's `lead-scoring`
 * agent (ported to apps/api/src/lib/scoreLead.ts — apps/api has no runtime
 * dependency on @devlaunch/worker, so this small, pure function is
 * duplicated rather than adding one for a single computation), and
 * upserts (on lead_id) the lead_scores row. This runs synchronously inline
 * rather than via the BullMQ agent-execution path since it's a cheap, pure
 * computation over already-persisted data, not an external call.
 */
leadScoresRouter.post("/:leadId/recompute", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    const lead = await loadLeadOr404(req, projectId, leadId);

    const rubricResult = await req.tenantDb!.query(
      `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND is_active = true
       ORDER BY updated_at DESC LIMIT 1`,
      [req.tenantId, projectId],
    );
    if (rubricResult.rowCount === 0) throw Errors.notFound("No active rubric for this project");
    const rubric = rubricResult.rows[0];
    const criteria = (rubric.criteria ?? []) as ScoreLeadCriterion[];

    const emailDomain = typeof lead.email === "string" ? normalizeDomain(lead.email.split("@")[1]) : null;
    const companyName = typeof lead.company === "string" ? normalizeOrgName(lead.company) : null;

    let matchedOrg: Record<string, unknown> | null = null;
    if (emailDomain) {
      const byDomain = await req.tenantDb!.query(
        `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3 LIMIT 1`,
        [req.tenantId, projectId, emailDomain],
      );
      if (byDomain.rowCount && byDomain.rowCount > 0) matchedOrg = byDomain.rows[0];
    }
    if (!matchedOrg && companyName) {
      const byName = await req.tenantDb!.query(
        `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_name = $3 LIMIT 1`,
        [req.tenantId, projectId, companyName],
      );
      if (byName.rowCount && byName.rowCount > 0) matchedOrg = byName.rows[0];
    }

    let contacts: Record<string, unknown>[] = [];
    if (matchedOrg) {
      const contactsResult = await req.tenantDb!.query(
        `SELECT * FROM discovered_contacts WHERE organization_id = $1 AND tenant_id = $2`,
        [matchedOrg.id, req.tenantId],
      );
      contacts = contactsResult.rows;
    }

    const evidence = buildRecomputeEvidenceMap(lead, criteria, matchedOrg, contacts);
    const scored = scoreLead(criteria, evidence);

    const upserted = await req.tenantDb!.query(
      `INSERT INTO lead_scores (tenant_id, project_id, lead_id, rubric_id, total_score, criteria_evidence, why_summary, next_research_note, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
       ON CONFLICT (lead_id) DO UPDATE SET
         rubric_id = EXCLUDED.rubric_id,
         total_score = EXCLUDED.total_score,
         criteria_evidence = EXCLUDED.criteria_evidence,
         why_summary = EXCLUDED.why_summary,
         next_research_note = EXCLUDED.next_research_note,
         computed_at = EXCLUDED.computed_at
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        leadId,
        rubric.id,
        scored.totalScore,
        JSON.stringify(scored.criteriaEvidence),
        scored.whySummary,
        scored.nextResearchNote,
      ],
    );

    res.status(200).json({ score: upserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

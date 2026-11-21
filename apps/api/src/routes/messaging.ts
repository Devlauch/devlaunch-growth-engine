import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { draftMessage, type DraftMessageChannel } from "../lib/draftMessage.js";
import { checkSendEligibility, type SendEligibilityResult } from "../lib/suppression.js";

/**
 * Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/message-drafts
 *
 * Roadmap items 9 ("Personalized message drafting") and 12 ("Approval
 * screen"). Reuses the existing `approvals` table/state machine exactly
 * like campaigns.ts does (see that file's submit-for-approval handler and
 * packages/db/migrations/023_add_campaign_id_to_approvals.sql) rather than
 * inventing a parallel approval mechanism — a message_drafts row carries
 * its own `approval_id` FK the same way campaigns carries `campaign_id` on
 * `approvals`.
 *
 * Evidence/approvedClaims input: this route accepts `approvedClaims` and
 * `evidenceFacts`/`evidenceSummary` directly in the POST / body rather than
 * assembling them automatically from discovered_organizations/
 * discovered_contacts. Chosen deliberately over auto-assembly (like
 * scoring.ts's /recompute does for rubric criteria) because: (a) approved
 * claims are inherently tenant/offer-specific marketing copy decisions, not
 * something derivable from lead data at all, and (b) auto-assembling
 * evidence facts would duplicate the same heuristic matching
 * scoring.ts already has, for comparatively low benefit at this stage —
 * callers (e.g. a future "draft from lead" UI action) are expected to pull
 * evidence from the lead/discovery data themselves and pass it in. This is
 * a documented simplification, not an oversight.
 *
 * Send eligibility: drafting is never blocked by suppression/consent (an
 * ineligible lead can still get an evidence-based draft prepared for
 * review), but every draft's response honestly surfaces `sendEligibility`
 * (via apps/api/src/lib/suppression.ts's checkSendEligibility) so the
 * approval screen can show a warning before anyone approves it.
 *
 * No real sending integration exists in this codebase (consistent with
 * integrations.ts / campaigns.ts) — approving a batch of drafts below only
 * ever flips status to 'approved' via the approvals table. It never sends
 * anything.
 */
export const messageDraftsRouter = Router({ mergeParams: true });
messageDraftsRouter.use(requireAuth, requireTenantMembership);

const MESSAGE_DRAFT_COLUMNS = `id, tenant_id, project_id, lead_id, status, approval_id, evidence_summary, unsourced_claims, created_by, created_at, updated_at`;

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

async function loadDraftOr404(req: Request, projectId: string, draftId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${MESSAGE_DRAFT_COLUMNS} FROM message_drafts WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [draftId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Message draft not found");
  return r.rows[0];
}

/** Best-effort sendEligibility surfaced honestly in draft responses — never blocks draft creation. */
async function assembleSendEligibility(
  req: Request,
  lead: Record<string, unknown>,
): Promise<SendEligibilityResult> {
  const email = typeof lead.email === "string" ? lead.email : null;
  if (!email) {
    // No email on this lead (and leads has no phone column) — nothing for
    // suppression/consent to key off of yet, so we honestly report
    // eligible rather than guessing.
    return { eligible: true, blockReasons: [] };
  }
  return checkSendEligibility(req.tenantDb!, req.tenantId!, {
    leadId: typeof lead.id === "string" ? lead.id : null,
    email,
    channel: "email",
  });
}

const createDraftSchema = z.object({
  leadId: z.string().uuid(),
  approvedClaims: z.array(z.string().trim().min(1).max(500)).default([]),
  evidenceSummary: z.string().trim().min(1).max(5000),
  evidenceFacts: z.array(z.string().trim().min(1).max(1000)).default([]),
  senderIdentity: z.string().trim().min(1).max(300).optional(),
});

/** POST /message-drafts */
messageDraftsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createDraftSchema.parse(req.body);

    const lead = await loadLeadOr404(req, projectId, body.leadId);
    const sendEligibility = await assembleSendEligibility(req, lead);

    const { variants, unsourcedClaims } = draftMessage(body.approvedClaims, {
      summary: body.evidenceSummary,
      facts: body.evidenceFacts,
    });

    const senderIdentity = body.senderIdentity ?? "Unconfigured sender identity (no sending integration connected)";
    const recipientDisplay =
      typeof lead.name === "string" && lead.name && typeof lead.email === "string" && lead.email
        ? `${lead.name} <${lead.email}>`
        : (typeof lead.email === "string" ? lead.email : null) ?? (typeof lead.name === "string" ? lead.name : null);

    const draftResult = await req.tenantDb!.query(
      `INSERT INTO message_drafts (tenant_id, project_id, lead_id, evidence_summary, unsourced_claims, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING ${MESSAGE_DRAFT_COLUMNS}`,
      [req.tenantId, projectId, body.leadId, body.evidenceSummary, JSON.stringify(unsourcedClaims), req.userId],
    );
    const draft = draftResult.rows[0];

    const variantRows: Record<string, unknown>[] = [];
    for (const variant of variants) {
      const r = await req.tenantDb!.query(
        `INSERT INTO message_draft_variants (tenant_id, message_draft_id, channel, subject, body, recipient_display, sender_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, message_draft_id, channel, subject, body, recipient_display, sender_identity, created_at`,
        [
          req.tenantId,
          draft.id,
          variant.channel,
          variant.subject ?? null,
          variant.body,
          recipientDisplay,
          senderIdentity,
        ],
      );
      variantRows.push(r.rows[0]);
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'message_draft.created', 'message_draft', $3, $4::jsonb)`,
      [req.tenantId, req.userId, draft.id, JSON.stringify({ leadId: body.leadId, unsourcedClaims })],
    );

    res.status(201).json({ messageDraft: draft, variants: variantRows, sendEligibility });
  } catch (err) {
    next(err);
  }
});

/** GET /message-drafts — filterable by status/leadId */
messageDraftsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    if (leadId) z.string().uuid().parse(leadId);

    const result = await req.tenantDb!.query(
      `SELECT ${MESSAGE_DRAFT_COLUMNS} FROM message_drafts
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR status = $3)
         AND ($4::uuid IS NULL OR lead_id = $4)
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId, status ?? null, leadId ?? null],
    );
    res.json({ messageDrafts: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /message-drafts/:id — one draft + its variants + evidence/unsourced claims */
messageDraftsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const draftId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const draft = await loadDraftOr404(req, projectId, draftId);

    const variants = await req.tenantDb!.query(
      `SELECT id, tenant_id, message_draft_id, channel, subject, body, recipient_display, sender_identity, created_at
       FROM message_draft_variants
       WHERE tenant_id = $1 AND message_draft_id = $2
       ORDER BY created_at ASC`,
      [req.tenantId, draftId],
    );

    const lead = await loadLeadOr404(req, projectId, draft.lead_id);
    const sendEligibility = await assembleSendEligibility(req, lead);

    res.json({ messageDraft: draft, variants: variants.rows, sendEligibility });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /message-drafts/:id/submit-for-approval
 *
 * draft -> pending_approval, mirroring campaigns.ts's
 * submit-for-approval handler exactly: creates a real approvals row that
 * the existing approvals queue/decision routes already handle generically.
 */
messageDraftsRouter.post("/:id/submit-for-approval", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const draftId = paramId(req, "id");
    const existing = await loadDraftOr404(req, projectId, draftId);
    if (existing.status !== "draft") {
      throw Errors.conflict("Only a draft message can be submitted for approval");
    }

    const approval = await req.tenantDb!.query(
      `INSERT INTO approvals (tenant_id, message_draft_id, requested_by, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, message_draft_id, status, requested_by, requested_at`,
      [req.tenantId, draftId, req.userId, `Message draft for lead ${existing.lead_id} submitted for approval`],
    );

    const updated = await req.tenantDb!.query(
      `UPDATE message_drafts SET status = 'pending_approval', approval_id = $3
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
       RETURNING ${MESSAGE_DRAFT_COLUMNS}`,
      [draftId, req.tenantId, approval.rows[0].id],
    );
    if (updated.rowCount === 0) throw Errors.conflict("Only a draft message can be submitted for approval");

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'message_draft.submitted_for_approval', 'message_draft', $3, $4::jsonb)`,
      [req.tenantId, req.userId, draftId, JSON.stringify({ approvalId: approval.rows[0].id })],
    );

    res.status(201).json({ messageDraft: updated.rows[0], approval: approval.rows[0] });
  } catch (err) {
    next(err);
  }
});

const batchApproveSchema = z.object({
  draftIds: z.array(z.string().uuid()).min(1).max(500),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * POST /message-drafts/batch-approve
 *
 * Approves each draft id via the same approvals-table decision path as a
 * single approve (approvals.status -> 'approved', message_drafts.status ->
 * 'approved'), respecting tenants.message_approval_daily_limit. Counts
 * today's already-approved message_drafts for the tenant; if approving
 * this whole batch would exceed the limit, the ENTIRE batch is rejected
 * with a clear error — no partial approval. This never sends anything; it
 * only records a human decision, exactly like campaigns' approval flow.
 */
messageDraftsRouter.post("/batch-approve", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = batchApproveSchema.parse(req.body);

    const tenantResult = await req.tenantDb!.query(
      `SELECT message_approval_daily_limit FROM tenants WHERE id = $1`,
      [req.tenantId],
    );
    if (tenantResult.rowCount === 0) throw Errors.notFound("Tenant not found");
    const dailyLimit: number | null = tenantResult.rows[0].message_approval_daily_limit;

    const draftsResult = await req.tenantDb!.query(
      `SELECT ${MESSAGE_DRAFT_COLUMNS} FROM message_drafts
       WHERE tenant_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
      [req.tenantId, projectId, body.draftIds],
    );
    const drafts = draftsResult.rows;
    if (drafts.length !== body.draftIds.length) {
      throw Errors.notFound("One or more message drafts were not found in this project");
    }
    const notPending = drafts.filter((d) => d.status !== "pending_approval");
    if (notPending.length > 0) {
      throw Errors.conflict(
        `Only drafts pending approval can be batch-approved (draft(s) not pending: ${notPending.map((d) => d.id).join(", ")})`,
      );
    }

    if (dailyLimit !== null) {
      const approvedTodayResult = await req.tenantDb!.query(
        `SELECT count(*)::int AS count FROM message_drafts
         WHERE tenant_id = $1 AND status = 'approved' AND updated_at >= date_trunc('day', now())`,
        [req.tenantId],
      );
      const approvedToday: number = approvedTodayResult.rows[0].count;
      if (approvedToday + drafts.length > dailyLimit) {
        throw Errors.conflict(
          `Approving this batch of ${drafts.length} would exceed the tenant's daily message approval limit ` +
            `(${dailyLimit}); ${approvedToday} already approved today. No drafts in this batch were approved.`,
        );
      }
    }

    const approvedDrafts: Record<string, unknown>[] = [];
    for (const draft of drafts) {
      if (!draft.approval_id) {
        throw Errors.conflict(`Draft ${draft.id} has no associated approval row`);
      }
      await req.tenantDb!.query(
        `UPDATE approvals SET status = 'approved', reviewed_by = $3, decision_notes = $4, reviewed_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
        [draft.approval_id, req.tenantId, req.userId, body.notes ?? null],
      );
      const updated = await req.tenantDb!.query(
        `UPDATE message_drafts SET status = 'approved'
         WHERE id = $1 AND tenant_id = $2 AND status = 'pending_approval'
         RETURNING ${MESSAGE_DRAFT_COLUMNS}`,
        [draft.id, req.tenantId],
      );
      if (updated.rowCount === 0) {
        throw Errors.conflict(`Draft ${draft.id} could not be approved (unexpected state change)`);
      }
      approvedDrafts.push(updated.rows[0]);

      await req.tenantDb!.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'user', $2, 'message_draft.approved', 'message_draft', $3, $4::jsonb)`,
        [req.tenantId, req.userId, draft.id, JSON.stringify({ batch: true, approvalId: draft.approval_id })],
      );
    }

    res.json({ messageDrafts: approvedDrafts });
  } catch (err) {
    next(err);
  }
});

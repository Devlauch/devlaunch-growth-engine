import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { classifyReply } from "../lib/classifyReply.js";
import { recomputeLeadScore } from "./scoring.js";
import { logger } from "../lib/logger.js";

/**
 * repliesRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/replies
 *
 * Roadmap item 13, "Reply handling": read replies, classify them
 * (interested, not now, wrong person, unsubscribe), and draft a response
 * for approval; create a CRM task for every positive reply.
 *
 * No live inbox integration exists yet in this codebase (see
 * src/lib/integrations.ts's not-connected registry), so this is a
 * manual/webhook ingestion endpoint: today a human pastes a reply in here;
 * a future real inbox integration can POST to this exact same endpoint
 * without any contract change. The classification (classifyReply.ts) and
 * every downstream effect below are real, not stubbed.
 *
 * message_drafts, crm_tasks, suppression_list, and sequence_enrollments are
 * owned by parallel efforts and may not exist on disk yet. Every write to
 * one of those tables is wrapped in its own SAVEPOINT and defensively
 * catches a "relation does not exist" (42P01) error: on that specific
 * error we roll back to the savepoint (not the whole request), skip just
 * that side effect, and note it in the response instead of failing the
 * whole request.
 */
export const repliesRouter = Router({ mergeParams: true });
repliesRouter.use(requireAuth, requireTenantMembership);

const CHANNELS = ["email", "whatsapp", "linkedin", "phone", "other"] as const;

const createReplySchema = z.object({
  channel: z.enum(CHANNELS),
  content: z.string().trim().min(1).max(20_000),
});

const REPLY_COLUMNS = `id, tenant_id, project_id, lead_id, channel, raw_content, classification,
       classification_confidence, draft_response_id, crm_task_id, received_at, created_at`;

async function loadLeadOr404(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  leadId: string,
) {
  const result = await tenantDb.query(
    `SELECT id, name, email FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Lead not found");
  return result.rows[0] as { id: string; name: string | null; email: string | null };
}

function isMissingRelationError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "42P01";
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/replies */
repliesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const leadId = z.string().uuid().parse((req.params as Record<string, string>).leadId);
    await loadLeadOr404(req.tenantDb!, req.tenantId!, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT ${REPLY_COLUMNS} FROM lead_replies
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY received_at DESC`,
      [req.tenantId, projectId, leadId],
    );
    res.json({ replies: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/replies */
repliesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const leadId = z.string().uuid().parse((req.params as Record<string, string>).leadId);
    const body = createReplySchema.parse(req.body);
    const lead = await loadLeadOr404(req.tenantDb!, req.tenantId!, projectId, leadId);

    const db = req.tenantDb!;
    const { classification, confidence } = classifyReply(body.content);

    const notes: string[] = [];
    const sideEffects = {
      crmTaskCreated: false,
      draftCreated: false,
      suppressed: false,
      enrollmentsStopped: 0,
    };

    let crmTaskId: string | null = null;
    let draftResponseId: string | null = null;

    if (classification === "interested") {
      // "Create a CRM task for every positive reply."
      await db.query("SAVEPOINT reply_crm_task");
      try {
        const leadLabel = lead.name ?? lead.email ?? leadId;
        const taskResult = await db.query(
          `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status)
           VALUES ($1, $2, $3, 'review_reply', $4, $5, 'open')
           RETURNING id`,
          [
            req.tenantId,
            projectId,
            leadId,
            `Review positive reply from ${leadLabel}`,
            "Lead replied with interest. Review the reply and approve/edit the drafted response.",
          ],
        );
        crmTaskId = taskResult.rows[0].id;
        sideEffects.crmTaskCreated = true;
        await db.query("RELEASE SAVEPOINT reply_crm_task");
      } catch (err) {
        await db.query("ROLLBACK TO SAVEPOINT reply_crm_task").catch(() => undefined);
        if (isMissingRelationError(err)) {
          notes.push("crm_tasks table not available yet, skipped CRM task creation");
        } else {
          throw err;
        }
      }

      // Skeleton draft row only — a full AI-drafted response body is a
      // parallel feature's responsibility; this just gives a human
      // something to fill in via that feature.
      await db.query("SAVEPOINT reply_draft");
      try {
        const draftResult = await db.query(
          `INSERT INTO message_drafts (tenant_id, project_id, lead_id, status, evidence_summary, unsourced_claims, created_by)
           VALUES ($1, $2, $3, 'draft', $4, '[]'::jsonb, $5)
           RETURNING id`,
          [
            req.tenantId,
            projectId,
            leadId,
            "Reply-response draft: lead replied with interest; awaiting a human-authored (or future AI-drafted) response.",
            req.userId ?? null,
          ],
        );
        draftResponseId = draftResult.rows[0].id;
        sideEffects.draftCreated = true;
        await db.query("RELEASE SAVEPOINT reply_draft");
      } catch (err) {
        await db.query("ROLLBACK TO SAVEPOINT reply_draft").catch(() => undefined);
        if (isMissingRelationError(err)) {
          notes.push("message_drafts table not available yet, skipped draft response creation");
        } else {
          throw err;
        }
      }
    } else if (classification === "unsubscribe") {
      // Suppress the lead's identifier for all channels (an unsubscribe
      // reply is an opt-out of further outreach entirely, not just the
      // channel it arrived on) and stop any active sequence enrollment.
      if (lead.email) {
        await db.query("SAVEPOINT reply_suppression");
        try {
          await db.query(
            `INSERT INTO suppression_list (tenant_id, email, reason, channel, source_note)
             VALUES ($1, $2, 'unsubscribed', 'all', $3)
             ON CONFLICT DO NOTHING`,
            [req.tenantId, lead.email, `Unsubscribe reply received on lead ${leadId}`],
          );
          sideEffects.suppressed = true;
          await db.query("RELEASE SAVEPOINT reply_suppression");
        } catch (err) {
          await db.query("ROLLBACK TO SAVEPOINT reply_suppression").catch(() => undefined);
          if (isMissingRelationError(err)) {
            notes.push("suppression_list table not available yet, skipped suppression");
          } else {
            throw err;
          }
        }
      } else {
        notes.push("Lead has no email on file, skipped suppression_list insert");
      }

      await db.query("SAVEPOINT reply_stop_enrollments");
      try {
        const stopResult = await db.query(
          `UPDATE sequence_enrollments SET status = 'stopped_unsubscribed', stopped_at = now()
           WHERE lead_id = $1 AND status = 'active'`,
          [leadId],
        );
        sideEffects.enrollmentsStopped = stopResult.rowCount ?? 0;
        await db.query("RELEASE SAVEPOINT reply_stop_enrollments");
      } catch (err) {
        await db.query("ROLLBACK TO SAVEPOINT reply_stop_enrollments").catch(() => undefined);
        if (isMissingRelationError(err)) {
          notes.push("sequence_enrollments table not available yet, skipped stopping enrollments");
        } else {
          throw err;
        }
      }
    }
    // wrong_person / not_now / unclassified: just record the classified
    // reply, no side effects.

    const replyResult = await db.query(
      `INSERT INTO lead_replies (tenant_id, project_id, lead_id, channel, raw_content, classification,
                                  classification_confidence, draft_response_id, crm_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${REPLY_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        leadId,
        body.channel,
        body.content,
        classification,
        confidence,
        draftResponseId,
        crmTaskId,
      ],
    );

    // A classified reply is new evidence about this lead (engagement,
    // interest, or an opt-out) — recompute its rubric score now rather
    // than waiting on a human /recompute call or a periodic sweep. Reuses
    // this request's own tenantDb client, so it's awaited, not
    // fire-and-forget; best-effort, since a scoring failure must never
    // fail a reply that was already recorded.
    try {
      await recomputeLeadScore(db, req.tenantId!, projectId, leadId);
    } catch (err) {
      logger.error({ err, leadId, projectId }, "lead score recompute after reply classification failed");
    }

    res.status(201).json({
      reply: replyResult.rows[0],
      classification: { classification, confidence },
      sideEffects,
      notes,
    });
  } catch (err) {
    next(err);
  }
});

import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getBookingProvider } from "../lib/bookingProvider.js";
import { createMeetingOutcomeFollowUpIfNeeded } from "../lib/salesPipeline.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/meetings
 *
 * Sales Conversion Agent: "Booking integration" + "Meeting outcome
 * tracking" (roadmap items 6/7). The real, always-available path is manual
 * entry (POST /, bookingProvider defaults to 'manual') — a sales rep
 * records a scheduled meeting themselves. The 'calendly' bookingProvider
 * value exists in the schema for a real external booking-provider
 * integration that is NOT implemented in this codebase (see
 * apps/api/src/lib/bookingProvider.ts); requesting it returns an honest
 * 501, never a fabricated booking.
 */
export const meetingsRouter = Router({ mergeParams: true });
meetingsRouter.use(requireAuth, requireTenantMembership);

const MEETING_COLUMNS = `id, tenant_id, project_id, lead_id, deal_id, type, scheduled_at, status, outcome_notes, next_step, booking_provider, external_event_id, created_by, created_at, updated_at`;
const MEETING_TYPES = ["call", "demo"] as const;
const MEETING_STATUSES = ["scheduled", "completed", "no_show", "rescheduled", "cancelled"] as const;

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

async function assertLeadInProject(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

async function loadMeetingOr404(req: Request, projectId: string, meetingId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [meetingId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Meeting not found");
  return r.rows[0];
}

/**
 * GET /meetings/booking-provider-status — honestly reports whether a real
 * external booking integration is configured. Never claims 'connected'
 * without real credentials (see bookingProvider.ts).
 */
meetingsRouter.get("/booking-provider-status", async (_req, res, next) => {
  try {
    res.json({ provider: getBookingProvider().describe() });
  } catch (err) {
    next(err);
  }
});

const createMeetingSchema = z.object({
  leadId: z.string().uuid(),
  dealId: z.string().uuid().optional(),
  type: z.enum(MEETING_TYPES),
  scheduledAt: z.string().datetime(),
  bookingProvider: z.enum(["manual", "calendly"]).default("manual"),
});

/** POST /meetings — manual-entry recording (the one always-available path) */
meetingsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createMeetingSchema.parse(req.body);
    await assertLeadInProject(req, projectId, body.leadId);

    if (body.bookingProvider === "calendly") {
      // Never fabricate a real external booking — see bookingProvider.ts.
      const provider = getBookingProvider();
      const status = provider.describe();
      throw Errors.badRequest(
        `Calendly booking is not available (${status.status}): ${status.note} Use bookingProvider: "manual" to record this meeting directly.`,
      );
    }

    if (body.dealId) {
      const deal = await req.tenantDb!.query(
        "SELECT 1 FROM deals WHERE id = $1 AND tenant_id = $2 AND project_id = $3",
        [body.dealId, req.tenantId, projectId],
      );
      if (deal.rowCount === 0) throw Errors.notFound("Deal not found");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO meetings (tenant_id, project_id, lead_id, deal_id, type, scheduled_at, booking_provider, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
       RETURNING ${MEETING_COLUMNS}`,
      [req.tenantId, projectId, body.leadId, body.dealId ?? null, body.type, body.scheduledAt, req.userId],
    );
    const meeting = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'meeting.created', 'meeting', $3, $4::jsonb)`,
      [req.tenantId, req.userId, meeting.id, JSON.stringify({ leadId: body.leadId, type: body.type })],
    );

    res.status(201).json({ meeting });
  } catch (err) {
    next(err);
  }
});

/** GET /meetings — filterable by leadId/dealId/status */
meetingsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    if (leadId) z.string().uuid().parse(leadId);
    const dealId = typeof req.query.dealId === "string" ? req.query.dealId : undefined;
    if (dealId) z.string().uuid().parse(dealId);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status) z.enum(MEETING_STATUSES).parse(status);

    const result = await req.tenantDb!.query(
      `SELECT ${MEETING_COLUMNS} FROM meetings
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::uuid IS NULL OR lead_id = $3)
         AND ($4::uuid IS NULL OR deal_id = $4)
         AND ($5::text IS NULL OR status = $5)
       ORDER BY scheduled_at DESC
       LIMIT 200`,
      [req.tenantId, projectId, leadId ?? null, dealId ?? null, status ?? null],
    );
    res.json({ meetings: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /meetings/:id */
meetingsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const meetingId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const meeting = await loadMeetingOr404(req, projectId, meetingId);
    res.json({ meeting });
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
});

/** PATCH /meetings/:id/reschedule — new time, status -> 'scheduled' again (a fresh scheduled sitting) */
meetingsRouter.patch("/:id/reschedule", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const meetingId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadMeetingOr404(req, projectId, meetingId);
    const body = rescheduleSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE meetings SET scheduled_at = $3, status = 'scheduled'
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${MEETING_COLUMNS}`,
      [meetingId, req.tenantId, body.scheduledAt],
    );
    res.json({ meeting: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const outcomeSchema = z.object({
  status: z.enum(["completed", "no_show", "rescheduled", "cancelled"]),
  outcomeNotes: z.string().trim().max(5000).optional(),
  nextStep: z.string().trim().max(2000).optional(),
});

/**
 * PATCH /meetings/:id/outcome — record how a meeting actually went
 * (roadmap item "Meeting outcome tracking"). May trigger an automatic
 * follow-up task (see salesPipeline.ts's createMeetingOutcomeFollowUpIfNeeded) —
 * never silently dropped from the response, so the caller can see exactly
 * what, if anything, was auto-created.
 */
meetingsRouter.patch("/:id/outcome", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const meetingId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadMeetingOr404(req, projectId, meetingId);
    const body = outcomeSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE meetings
       SET status = $3, outcome_notes = COALESCE($4, outcome_notes), next_step = COALESCE($5, next_step)
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${MEETING_COLUMNS}`,
      [meetingId, req.tenantId, body.status, body.outcomeNotes ?? null, body.nextStep ?? null],
    );
    const meeting = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'meeting.outcome_recorded', 'meeting', $3, $4::jsonb)`,
      [req.tenantId, req.userId, meetingId, JSON.stringify({ status: body.status })],
    );

    const followUp = await createMeetingOutcomeFollowUpIfNeeded(req.tenantDb!, req.tenantId!, projectId, {
      id: meeting.id,
      lead_id: meeting.lead_id,
      deal_id: meeting.deal_id,
      status: meeting.status,
      next_step: meeting.next_step,
    });

    res.json({ meeting, followUpCreated: followUp });
  } catch (err) {
    next(err);
  }
});

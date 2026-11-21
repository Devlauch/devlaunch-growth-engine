import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { advanceDueEnrollments } from "../lib/advanceSequences.js";

/**
 * sequencesRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/sequences
 *
 * Roadmap item 10 ("Multi-step sequences"): an editable sequence is a
 * `sequences` row plus its ordered `sequence_steps` (e.g. Day 0 email,
 * Day 3 call task, Day 7 follow-up email, Day 14 final note). Enrolling a
 * lead and stopping a sequence are handled by sequenceEnrollmentsRouter
 * below; actually *advancing* enrollments over time is
 * apps/api/src/lib/advanceSequences.ts, exposed via POST .../advance.
 *
 * PATCH here replaces the full `steps` array when one is supplied — for an
 * MVP "editable sequence" this is simpler and safer than diffing
 * individual step edits (no partial-step-update endpoint exists; send the
 * complete desired step list). This is a deliberate scope choice, not an
 * oversight.
 *
 * NOTE: this router is intentionally not wired into app.ts here (file
 * boundaries for this task excluded app.ts) — whoever integrates roadmap
 * items 10/11 end-to-end should mount it the same way campaignsRouter is
 * mounted, at the path above, guarded by requireAuth + requireTenantMembership
 * (already applied inside this file).
 *
 * sequenceEnrollmentsRouter is mounted as a NESTED sub-router of
 * sequencesRouter at "/:sequenceId/enrollments" (not as a separate sibling
 * app.use() at an overlapping prefix) — mounting two routers at overlapping
 * path prefixes (e.g. ".../sequences" and ".../sequences/:sequenceId/
 * enrollments" as siblings) makes Express run requireAuth/
 * requireTenantMembership TWICE for every enrollments request (once per
 * router's own .use()), double-opening a tenant-scoped transaction for one
 * request. Nesting avoids that: only sequencesRouter's auth/tenant
 * middleware runs, and sequenceEnrollmentsRouter inherits req.tenantId /
 * req.tenantDb from it. The externally-visible mount path is unchanged:
 * /api/v1/tenants/:tenantId/projects/:projectId/sequences/:sequenceId/enrollments
 */
export const sequencesRouter = Router({ mergeParams: true });
sequencesRouter.use(requireAuth, requireTenantMembership);

export const sequenceEnrollmentsRouter = Router({ mergeParams: true });
sequencesRouter.use("/:sequenceId/enrollments", sequenceEnrollmentsRouter);

const STEP_TYPES = ["email", "call_task", "linkedin_task", "follow_up_email", "final_note"] as const;
const DRAFT_VARIANT_CHANNELS = ["email", "whatsapp", "call_script", "linkedin_note"] as const;
const STOP_REASONS = ["replied", "unsubscribed", "bounced", "meeting_booked", "manual"] as const;

const stepSchema = z.object({
  stepOrder: z.number().int().min(0),
  dayOffset: z.number().int().min(0),
  stepType: z.enum(STEP_TYPES),
  messageDraftVariantChannel: z.enum(DRAFT_VARIANT_CHANNELS).nullish(),
  taskInstructions: z.string().trim().max(5000).nullish(),
});

const createSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  isActive: z.boolean().optional(),
  steps: z.array(stepSchema).max(100).optional(),
});

const updateSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  steps: z.array(stepSchema).max(100).optional(),
});

const enrollSchema = z.object({
  leadId: z.string().uuid(),
});

const stopSchema = z.object({
  reason: z.enum(STOP_REASONS),
});

const SEQUENCE_COLUMNS = `id, tenant_id, project_id, name, is_active, created_at, updated_at`;
const STEP_COLUMNS = `id, tenant_id, sequence_id, step_order, day_offset, step_type, message_draft_variant_channel, task_instructions, created_at`;
const ENROLLMENT_COLUMNS = `id, tenant_id, sequence_id, lead_id, status, current_step_order, enrolled_at, stopped_at, created_at, updated_at`;

const STOP_REASON_TO_STATUS: Record<(typeof STOP_REASONS)[number], string> = {
  replied: "stopped_replied",
  unsubscribed: "stopped_unsubscribed",
  bounced: "stopped_bounced",
  meeting_booked: "stopped_meeting_booked",
  manual: "stopped_manual",
};

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadSequenceOr404(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  sequenceId: string,
) {
  const result = await tenantDb.query(
    `SELECT ${SEQUENCE_COLUMNS} FROM sequences WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [sequenceId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Sequence not found");
  return result.rows[0];
}

async function replaceSteps(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  sequenceId: string,
  steps: z.infer<typeof stepSchema>[],
) {
  await tenantDb.query("DELETE FROM sequence_steps WHERE sequence_id = $1 AND tenant_id = $2", [
    sequenceId,
    tenantId,
  ]);
  const inserted: unknown[] = [];
  for (const step of steps) {
    const result = await tenantDb.query(
      `INSERT INTO sequence_steps (tenant_id, sequence_id, step_order, day_offset, step_type, message_draft_variant_channel, task_instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${STEP_COLUMNS}`,
      [
        tenantId,
        sequenceId,
        step.stepOrder,
        step.dayOffset,
        step.stepType,
        step.messageDraftVariantChannel ?? null,
        step.taskInstructions ?? null,
      ],
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/sequences */
sequencesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${SEQUENCE_COLUMNS} FROM sequences
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ sequences: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/sequences — creates the sequence and its steps transactionally */
sequencesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const body = createSequenceSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO sequences (tenant_id, project_id, name, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SEQUENCE_COLUMNS}`,
      [req.tenantId, projectId, body.name, body.isActive ?? true],
    );
    const sequence = result.rows[0];

    const steps = body.steps && body.steps.length > 0 ? await replaceSteps(req.tenantDb!, req.tenantId!, sequence.id, body.steps) : [];

    res.status(201).json({ sequence, steps });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/sequences/:id — sequence + its steps */
sequencesRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse(req.params.id);
    const sequence = await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    const steps = await req.tenantDb!.query(
      `SELECT ${STEP_COLUMNS} FROM sequence_steps WHERE sequence_id = $1 AND tenant_id = $2 ORDER BY step_order ASC`,
      [sequenceId, req.tenantId],
    );

    res.json({ sequence, steps: steps.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/tenants/:tenantId/projects/:projectId/sequences/:id
 *
 * Updates name/is_active. If `steps` is present, the full existing step
 * list is replaced (see router-level comment above) — not merged.
 */
sequencesRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse(req.params.id);
    const body = updateSequenceSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }

    await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    const result = await req.tenantDb!.query(
      `UPDATE sequences
       SET name = COALESCE($3, name),
           is_active = COALESCE($4, is_active)
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${SEQUENCE_COLUMNS}`,
      [sequenceId, req.tenantId, body.name ?? null, body.isActive ?? null],
    );

    const steps =
      body.steps !== undefined ? await replaceSteps(req.tenantDb!, req.tenantId!, sequenceId, body.steps) : undefined;

    res.json(steps !== undefined ? { sequence: result.rows[0], steps } : { sequence: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/tenants/:tenantId/projects/:projectId/sequences/:id */
sequencesRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse(req.params.id);
    await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    await req.tenantDb!.query("DELETE FROM sequences WHERE id = $1 AND tenant_id = $2", [sequenceId, req.tenantId]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/sequences/advance
 *
 * Manually-triggerable "tick" of the sequence engine (lib/advanceSequences.ts)
 * for this tenant/project. There is no cron/scheduler wired up to call this
 * automatically yet — a future scheduled job should call it periodically.
 * Registered on sequencesRouter (not sequenceEnrollmentsRouter) since it
 * operates across every sequence in the project, not one sequence/enrollment.
 */
sequencesRouter.post("/advance", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await advanceDueEnrollments(req.tenantDb!, req.tenantId!, projectId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/sequences/:sequenceId/enrollments */
sequenceEnrollmentsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse((req.params as Record<string, string>).sequenceId);
    await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    const result = await req.tenantDb!.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM sequence_enrollments
       WHERE tenant_id = $1 AND sequence_id = $2
       ORDER BY created_at DESC
       LIMIT 500`,
      [req.tenantId, sequenceId],
    );
    res.json({ enrollments: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/sequences/:sequenceId/enrollments — enroll a lead, active, at step 0 */
sequenceEnrollmentsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse((req.params as Record<string, string>).sequenceId);
    const body = enrollSchema.parse(req.body);
    await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    const lead = await req.tenantDb!.query(
      "SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3",
      [body.leadId, req.tenantId, projectId],
    );
    if (lead.rowCount === 0) throw Errors.notFound("Lead not found in this project");

    // App-layer guard in addition to the DB's UNIQUE (sequence_id, lead_id)
    // constraint (048_create_sequence_enrollments.sql): gives a friendly 409
    // instead of surfacing a raw constraint-violation error.
    const existing = await req.tenantDb!.query(
      "SELECT 1 FROM sequence_enrollments WHERE tenant_id = $1 AND sequence_id = $2 AND lead_id = $3",
      [req.tenantId, sequenceId, body.leadId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw Errors.conflict("This lead is already enrolled in this sequence");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO sequence_enrollments (tenant_id, sequence_id, lead_id, status, current_step_order)
       VALUES ($1, $2, $3, 'active', 0)
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [req.tenantId, sequenceId, body.leadId],
    );

    res.status(201).json({ enrollment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/sequences/:sequenceId/enrollments/:id/stop
 *
 * This is the real, working stop mechanism (roadmap item 10: "Stop the
 * sequence automatically on a reply, an unsubscribe, a bounce, or a booked
 * meeting"). *Automatic* triggering — i.e. a real inbound reply, bounce
 * webhook, or meeting-booking event actually calling this endpoint — is for
 * whichever future piece ingests those events to wire up; this endpoint
 * itself is fully functional today, just not yet auto-invoked by a live
 * inbox/calendar integration.
 */
sequenceEnrollmentsRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const sequenceId = z.string().uuid().parse((req.params as Record<string, string>).sequenceId);
    const enrollmentId = z.string().uuid().parse(req.params.id);
    const body = stopSchema.parse(req.body);

    await loadSequenceOr404(req.tenantDb!, req.tenantId!, projectId, sequenceId);

    const existing = await req.tenantDb!.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM sequence_enrollments WHERE id = $1 AND tenant_id = $2 AND sequence_id = $3`,
      [enrollmentId, req.tenantId, sequenceId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Enrollment not found");
    if (existing.rows[0].status !== "active") {
      throw Errors.conflict("Only an active enrollment can be stopped");
    }

    const newStatus = STOP_REASON_TO_STATUS[body.reason];
    const result = await req.tenantDb!.query(
      `UPDATE sequence_enrollments
       SET status = $4, stopped_at = now()
       WHERE id = $1 AND tenant_id = $2 AND sequence_id = $3 AND status = 'active'
       RETURNING ${ENROLLMENT_COLUMNS}`,
      [enrollmentId, req.tenantId, sequenceId, newStatus],
    );
    if (result.rowCount === 0) throw Errors.conflict("Only an active enrollment can be stopped");

    res.json({ enrollment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

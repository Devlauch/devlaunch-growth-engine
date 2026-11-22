import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/crm-tasks
 *
 * Phase 2 (Section B, roadmap item 11 "Calls and manual LinkedIn messages as
 * tasks in the CRM"): general CRUD for `crm_tasks`
 * (049_create_crm_tasks.sql) beyond apps/api/src/routes/replies.ts's narrow
 * internal use (which only ever creates a 'review_reply' task for a
 * positive reply). This route lets a human create/list/complete any CRM
 * task directly — 'call' / 'linkedin_message' / 'follow_up' / 'other', per
 * the table's own task_type CHECK; 'review_reply' is left creatable too
 * (the CHECK allows it) since there's no reason to special-case it out, but
 * the typical path for that one specific type remains replies.ts.
 *
 * crm_tasks.lead_id is the only entity FK on this table (nullable) — there
 * is no deal_id column on crm_tasks today (confirmed from
 * 049_create_crm_tasks.sql: lead_id, sequence_enrollment_id only). A task
 * can therefore be attached to a lead or left unattached (e.g. a pure
 * admin/follow-up reminder); it cannot be attached to a deal directly in
 * this schema.
 */
export const crmTasksRouter = Router({ mergeParams: true });
crmTasksRouter.use(requireAuth, requireTenantMembership);

const TASK_TYPES = ["call", "linkedin_message", "follow_up", "review_reply", "other"] as const;
const TASK_STATUSES = ["open", "completed", "skipped"] as const;

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

const CRM_TASK_COLUMNS = `id, tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at,
       assigned_user_id, sequence_enrollment_id, created_at, updated_at`;

async function loadTaskOr404(req: Request, projectId: string, taskId: string) {
  const result = await req.tenantDb!.query(
    `SELECT ${CRM_TASK_COLUMNS} FROM crm_tasks WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [taskId, req.tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Task not found");
  return result.rows[0] as { id: string; status: string };
}

const createTaskSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  title: z.string().trim().min(1).max(500),
  instructions: z.string().trim().max(5000).optional(),
  dueAt: z.string().datetime().optional(),
  assignedUserId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
});

/** GET .../crm-tasks — filterable by assignedUserId, status, leadId. */
crmTasksRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const conditions = ["tenant_id = $1", "project_id = $2"];
    const values: unknown[] = [req.tenantId, projectId];

    if (req.query.status !== undefined) {
      const parsed = z.enum(TASK_STATUSES).safeParse(req.query.status);
      if (!parsed.success) throw Errors.badRequest(`status must be one of: ${TASK_STATUSES.join(", ")}`);
      values.push(parsed.data);
      conditions.push(`status = $${values.length}`);
    }
    if (req.query.assignedUserId !== undefined) {
      const parsed = z.string().uuid().safeParse(req.query.assignedUserId);
      if (!parsed.success) throw Errors.badRequest("assignedUserId must be a UUID");
      values.push(parsed.data);
      conditions.push(`assigned_user_id = $${values.length}`);
    }
    if (req.query.leadId !== undefined) {
      const parsed = z.string().uuid().safeParse(req.query.leadId);
      if (!parsed.success) throw Errors.badRequest("leadId must be a UUID");
      values.push(parsed.data);
      conditions.push(`lead_id = $${values.length}`);
    }

    const result = await req.tenantDb!.query(
      `SELECT ${CRM_TASK_COLUMNS} FROM crm_tasks WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
      values,
    );
    res.json({ tasks: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST .../crm-tasks — create a follow-up task. */
crmTasksRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createTaskSchema.parse(req.body);

    if (body.leadId) {
      const lead = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
        body.leadId,
        req.tenantId,
        projectId,
      ]);
      if (lead.rowCount === 0) throw Errors.notFound("Lead not found in this project");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
       RETURNING ${CRM_TASK_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.leadId ?? null,
        body.taskType,
        body.title,
        body.instructions ?? null,
        body.dueAt ?? null,
        body.assignedUserId ?? null,
      ],
    );

    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET .../crm-tasks/:taskId */
crmTasksRouter.get("/:taskId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const taskId = paramId(req, "taskId");
    await assertProjectInTenant(req, projectId);
    const task = await loadTaskOr404(req, projectId, taskId);
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

/** PATCH .../crm-tasks/:taskId/complete — mark a task completed (or skipped). */
const completeSchema = z.object({
  status: z.enum(["completed", "skipped"]).default("completed"),
});

crmTasksRouter.patch("/:taskId/complete", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const taskId = paramId(req, "taskId");
    await assertProjectInTenant(req, projectId);
    const body = completeSchema.parse(req.body ?? {});
    const existing = await loadTaskOr404(req, projectId, taskId);

    if (existing.status !== "open") {
      throw Errors.conflict(`Task is already '${existing.status}'`);
    }

    const result = await req.tenantDb!.query(
      `UPDATE crm_tasks SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING ${CRM_TASK_COLUMNS}`,
      [taskId, req.tenantId, body.status],
    );

    res.json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

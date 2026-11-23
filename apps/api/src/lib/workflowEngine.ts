import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { advanceDueEnrollments } from "./advanceSequences.js";
import { notify, notifyTenantOwnersAndAdmins, type NotificationType } from "./notify.js";

/**
 * workflowEngine: a real, native, tenant-aware lifecycle-workflow
 * automation engine (Workstream B). Built from scratch after reading the
 * actual source of three sibling repos cloned read-only at
 * ~/project/Growth/{mautic,n8n,listmonk,chatwoot} for trigger/condition/
 * retry/execution-history architecture ideas (segment/campaign triggers
 * from Mautic's campaign-event-based model, n8n's node/DAG + per-node
 * execution-history shape, Chatwoot's event-driven automation rules) —
 * nothing from any of those repos is copied, embedded, or redistributed
 * here. See this file's accompanying LICENSE findings in
 * docs/ (reported to the task owner): n8n's LICENSE.md is the Sustainable
 * Use License ("fair-code"), which explicitly limits use to "your own
 * internal business purposes or ... non-commercial ... use" and forbids
 * offering the software to third parties for a fee — NOT compatible with
 * embedding n8n's execution engine into a paid multi-tenant SaaS product.
 * Mautic is GPLv3 (copyleft) — embedding its code would require this
 * entire application to be released under GPLv3, also unacceptable for a
 * proprietary SaaS. Both are referenced here only as prior-art for
 * architecture (trigger types, condition evaluation, execution-history
 * tables), never as a source of copied code — this whole file is this
 * codebase's own, independent implementation.
 *
 * Mirrors this codebase's existing real-integration-reuse convention
 * exactly: action executors call the EXISTING, already-built send/notify
 * functions (advanceDueEnrollments for sequence/Listmonk email sends,
 * notify.ts for in-app notifications) rather than reimplementing any
 * sending logic — see each executor below for exactly which existing
 * function it calls.
 *
 * Persistence model (packages/db/migrations/610-615):
 *   - workflow_definitions: a reusable {trigger, nodes DAG} definition.
 *   - workflow_executions: one row per real run of a definition, with a
 *     sha256 `dedupe_key` (computeDedupeKey below) giving genuine
 *     idempotency — a second runWorkflow() call for the same definition +
 *     trigger payload while a non-failed execution already exists for that
 *     pair is a no-op that returns the EXISTING execution id, never a
 *     second run (see 612_create_workflow_executions.sql's partial unique
 *     index for the DB-level guarantee this relies on).
 *   - workflow_execution_steps: one row per node visited, with real
 *     input/output and succeeded/failed/skipped status — never
 *     synthesized after the fact.
 *
 * Failure isolation: each node's action executor (or condition evaluation)
 * runs inside its own try/catch. A thrown error from one node marks that
 * step 'failed' and the whole execution 'failed' (stops walking the DAG),
 * but NEVER throws out of runWorkflow() itself — the caller (the cron tick
 * in workflowTriggerCron.ts, or any future direct caller) always gets back
 * a real executionId to look up, exactly like advanceDueEnrollments/
 * checkStalledDeals's "one tenant/project's failure never stops the batch"
 * convention, applied here at the per-node level instead.
 */

// ---------------------------------------------------------------------------
// Node / DAG types
// ---------------------------------------------------------------------------

export type WorkflowNodeType = "condition" | "action";

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "exists"
  | "not_exists";

export interface ConditionConfig {
  /** Dot-path into the evaluation context, e.g. "lead.status" or "trigger.daysInactive". */
  field: string;
  operator: ConditionOperator;
  /** Not required for exists/not_exists. */
  value?: unknown;
}

export interface WorkflowNode {
  key: string;
  type: WorkflowNodeType;
  config: Record<string, unknown>;
  /** Action nodes: the next node key to run, or omitted/null to end the run. */
  next?: string | null;
  /** Condition nodes only: next node key when the condition is true/false. */
  onTrue?: string | null;
  onFalse?: string | null;
}

/** Plain, serializable evaluation context a condition node's `field` path is read from. */
export type WorkflowContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/** Reads a dot-path ("lead.status") out of a plain object context. Missing = undefined, never throws. */
export function readContextPath(context: WorkflowContext, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, context);
}

/**
 * Evaluates one condition node against a plain evaluation context. Pure
 * function, no I/O — this is what makes condition logic independently unit
 * testable (see test/workflowEngine.test.ts) without any database at all.
 * An unknown/malformed operator is treated as false (never throws), so a
 * single bad node definition can never crash a run — it is caught here,
 * not just by the per-node try/catch in runWorkflow, for exactly that
 * reason.
 */
export function evaluateCondition(node: WorkflowNode, context: WorkflowContext): boolean {
  const config = node.config as unknown as ConditionConfig;
  const actual = readContextPath(context, config.field);

  switch (config.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "eq":
      return actual === config.value;
    case "neq":
      return actual !== config.value;
    case "gt":
      return typeof actual === "number" && typeof config.value === "number" && actual > config.value;
    case "gte":
      return typeof actual === "number" && typeof config.value === "number" && actual >= config.value;
    case "lt":
      return typeof actual === "number" && typeof config.value === "number" && actual < config.value;
    case "lte":
      return typeof actual === "number" && typeof config.value === "number" && actual <= config.value;
    case "in":
      return Array.isArray(config.value) && config.value.includes(actual);
    case "contains":
      return typeof actual === "string" && typeof config.value === "string" && actual.includes(config.value);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Deterministic sha256 hash of (workflowId + canonicalized trigger
 * payload) — canonicalized by sorting object keys recursively before
 * JSON.stringify so semantically-identical payloads with keys in a
 * different order hash identically. Stored as workflow_executions.dedupe_key
 * (612_create_workflow_executions.sql); genuinely verifies two trigger
 * events are "the same" rather than merely assuming a caller never fires
 * twice.
 */
export function computeDedupeKey(workflowId: string, triggerPayload: unknown): string {
  const canonical = canonicalize(triggerPayload);
  return createHash("sha256").update(`${workflowId}:${canonical}`).digest("hex");
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Action executors — each one calls an EXISTING, already-built DevLaunch
// capability. None of these reimplement sending/notification logic.
// ---------------------------------------------------------------------------

export interface ActionExecutionContext {
  tenantDb: PoolClient;
  tenantId: string;
  projectId: string;
  /** The lead this workflow run concerns, when the trigger/context identifies one. Most actions require it. */
  leadId?: string;
  triggerPayload: Record<string, unknown>;
}

export type ActionExecutor = (
  config: Record<string, unknown>,
  ctx: ActionExecutionContext,
) => Promise<Record<string, unknown>>;

const LEAD_STATUS_VALUES = ["new", "qualified", "rejected", "approved_for_outreach", "archived"] as const;
type LeadStatus = (typeof LEAD_STATUS_VALUES)[number];

const CRM_TASK_TYPES = ["call", "linkedin_message", "follow_up", "review_reply", "other"] as const;
type CrmTaskType = (typeof CRM_TASK_TYPES)[number];

/**
 * send_sequence_email: reuses the REAL sequence/Listmonk-capable send path
 * — apps/api/src/lib/advanceSequences.ts's advanceDueEnrollments (the same
 * function apps/worker/src/jobs/sequenceSchedulerCron.ts calls on its
 * 15-minute tick), not a duplicate send implementation. config.sequenceId
 * names an existing `sequences` row; this action enrolls the workflow's
 * leadId into it (idempotent — a lead already actively enrolled in this
 * sequence is left alone, never double-enrolled) and then calls
 * advanceDueEnrollments for the whole tenant/project so any step that is
 * now due (a day_offset: 0 email step enrolled just now is immediately
 * due) is actually sent through the real EmailProvider/approval-gate path
 * that function already implements. This action never sends an email
 * itself — it only ever drives the existing engine that does.
 */
const sendSequenceEmail: ActionExecutor = async (config, ctx) => {
  const sequenceId = config.sequenceId;
  if (typeof sequenceId !== "string") {
    throw new Error("send_sequence_email action requires config.sequenceId (string)");
  }
  if (!ctx.leadId) {
    throw new Error("send_sequence_email action requires a leadId in the workflow context");
  }

  const sequenceCheck = await ctx.tenantDb.query(
    `SELECT id FROM sequences WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND is_active = true`,
    [sequenceId, ctx.tenantId, ctx.projectId],
  );
  if (sequenceCheck.rowCount === 0) {
    throw new Error(`send_sequence_email: no active sequence ${sequenceId} found for this project`);
  }

  const existingEnrollment = await ctx.tenantDb.query(
    `SELECT id FROM sequence_enrollments
     WHERE tenant_id = $1 AND sequence_id = $2 AND lead_id = $3 AND status = 'active'`,
    [ctx.tenantId, sequenceId, ctx.leadId],
  );

  let enrollmentId: string;
  if ((existingEnrollment.rowCount ?? 0) > 0) {
    enrollmentId = existingEnrollment.rows[0].id as string;
  } else {
    const inserted = await ctx.tenantDb.query(
      `INSERT INTO sequence_enrollments (tenant_id, sequence_id, lead_id, status, current_step_order, cadence_multiplier, enrolled_at)
       VALUES ($1, $2, $3, 'active', 0, 1, now())
       RETURNING id`,
      [ctx.tenantId, sequenceId, ctx.leadId],
    );
    enrollmentId = inserted.rows[0].id as string;
  }

  // The real engine: this is the EXACT function sequenceSchedulerCron.ts
  // calls on its own tick — calling it here too just processes any
  // newly-due step (including this fresh enrollment's day_offset: 0 step)
  // right now instead of waiting for the next 15-minute tick.
  const result = await advanceDueEnrollments(ctx.tenantDb, ctx.tenantId, ctx.projectId);

  return { enrollmentId, sequenceId, ...result };
};

/**
 * create_task: inserts a real `crm_tasks` row — the same table/shape
 * sequenceSchedulerCron's advanceDueEnrollments already uses for its own
 * call_task/linkedin_task steps (see advanceSequences.ts). No separate
 * "workflow task" concept is invented; this is the one real CRM task
 * table every other part of this codebase also reads.
 */
const createTask: ActionExecutor = async (config, ctx) => {
  if (!ctx.leadId) {
    throw new Error("create_task action requires a leadId in the workflow context");
  }
  const taskType = (CRM_TASK_TYPES as readonly string[]).includes(config.taskType as string)
    ? (config.taskType as CrmTaskType)
    : "follow_up";
  const title = typeof config.title === "string" && config.title.trim() ? config.title.trim() : "Workflow follow-up";
  const instructions = typeof config.instructions === "string" ? config.instructions : null;

  const inserted = await ctx.tenantDb.query(
    `INSERT INTO crm_tasks (tenant_id, project_id, lead_id, task_type, title, instructions, status, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now())
     RETURNING id`,
    [ctx.tenantId, ctx.projectId, ctx.leadId, taskType, title, instructions],
  );

  return { crmTaskId: inserted.rows[0].id as string, taskType, title };
};

/**
 * update_lead_stage: updates the REAL `leads.status` column (there is no
 * separate "stage" column on leads — status IS the lifecycle stage; see
 * 015_create_leads.sql's CHECK constraint) to one of its existing allowed
 * values. Rejects any other value rather than silently no-op'ing or
 * bypassing the column's own CHECK constraint with a fabricated value.
 */
const updateLeadStage: ActionExecutor = async (config, ctx) => {
  if (!ctx.leadId) {
    throw new Error("update_lead_stage action requires a leadId in the workflow context");
  }
  const newStatus = config.status;
  if (typeof newStatus !== "string" || !(LEAD_STATUS_VALUES as readonly string[]).includes(newStatus)) {
    throw new Error(
      `update_lead_stage action requires config.status to be one of: ${LEAD_STATUS_VALUES.join(", ")}`,
    );
  }

  const updated = await ctx.tenantDb.query(
    `UPDATE leads SET status = $1 WHERE id = $2 AND tenant_id = $3 AND project_id = $4 RETURNING id`,
    [newStatus as LeadStatus, ctx.leadId, ctx.tenantId, ctx.projectId],
  );
  if (updated.rowCount === 0) {
    throw new Error(`update_lead_stage: lead ${ctx.leadId} not found in this project`);
  }

  return { leadId: ctx.leadId, status: newStatus };
};

const NOTIFICATION_TYPES = ["lead.captured", "campaign.submitted_for_approval", "approval.decided", "billing.payment_failed"] as const;

/**
 * notify: reuses the REAL in-app notification writer (apps/api/src/lib/
 * notify.ts) — never fabricates an email/WhatsApp send (notify.ts itself
 * documents there is no such provider backing it). config.userId notifies
 * one specific user; omitted, every active owner/admin of the tenant is
 * notified (notifyTenantOwnersAndAdmins), matching notify.ts's own
 * existing convention for "needs attention from whoever can act on it".
 */
const notifyAction: ActionExecutor = async (config, ctx) => {
  const title = typeof config.title === "string" && config.title.trim() ? config.title.trim() : "Workflow notification";
  const body = typeof config.body === "string" ? config.body : "";
  const linkUrl = typeof config.linkUrl === "string" ? config.linkUrl : null;
  const type: NotificationType = (NOTIFICATION_TYPES as readonly string[]).includes(config.type as string)
    ? (config.type as NotificationType)
    : "lead.captured";

  if (typeof config.userId === "string") {
    await notify({ client: ctx.tenantDb, tenantId: ctx.tenantId, userId: config.userId, type, title, body, linkUrl });
    return { notified: "user", userId: config.userId };
  }

  await notifyTenantOwnersAndAdmins({ client: ctx.tenantDb, tenantId: ctx.tenantId, type, title, body, linkUrl });
  return { notified: "owners_and_admins" };
};

export const ACTION_EXECUTORS: Record<string, ActionExecutor> = {
  send_sequence_email: sendSequenceEmail,
  create_task: createTask,
  update_lead_stage: updateLeadStage,
  notify: notifyAction,
};

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

interface WorkflowDefinitionRow {
  id: string;
  tenant_id: string;
  project_id: string;
  nodes: WorkflowNode[];
  status: string;
}

export interface RunWorkflowContext {
  tenantDb: PoolClient;
  tenantId: string;
  projectId: string;
  /** The lead this trigger concerns, if any — threaded into every action executor's context. */
  leadId?: string;
}

/**
 * Loads `definitionId`'s nodes DAG, finds-or-creates one workflow_executions
 * row (genuinely idempotent — see computeDedupeKey's doc comment), then
 * walks the DAG from its first node, persisting one workflow_execution_steps
 * row per node visited. Returns the execution's id in every case (never
 * throws for a node failure — only for a genuinely invalid call, e.g. an
 * unknown definitionId, which is a caller bug, not a runtime node failure).
 */
export async function runWorkflow(
  definitionId: string,
  triggerPayload: Record<string, unknown>,
  context: RunWorkflowContext,
): Promise<string> {
  const { tenantDb, tenantId, projectId, leadId } = context;

  const defResult = await tenantDb.query<WorkflowDefinitionRow>(
    `SELECT id, tenant_id, project_id, nodes, status
     FROM workflow_definitions
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [definitionId, tenantId, projectId],
  );
  if (defResult.rowCount === 0) {
    throw new Error(`runWorkflow: workflow_definitions row ${definitionId} not found for this project`);
  }
  const definition = defResult.rows[0];
  const nodes: WorkflowNode[] = Array.isArray(definition.nodes) ? definition.nodes : [];

  const dedupeKey = computeDedupeKey(definitionId, triggerPayload);

  // Idempotency: a non-failed execution already exists for this exact
  // (workflow, trigger payload) pair -> return it, do not run again. Relies
  // on 612_create_workflow_executions.sql's partial unique index at the DB
  // level too (a race between two concurrent callers still can't create two
  // non-failed rows), but checking here first avoids even attempting the
  // insert in the common case.
  const existing = await tenantDb.query<{ id: string }>(
    `SELECT id FROM workflow_executions
     WHERE workflow_id = $1 AND tenant_id = $2 AND dedupe_key = $3 AND status <> 'failed'`,
    [definitionId, tenantId, dedupeKey],
  );
  if ((existing.rowCount ?? 0) > 0) {
    return existing.rows[0].id;
  }

  const executionInsert = await tenantDb.query<{ id: string }>(
    `INSERT INTO workflow_executions (tenant_id, project_id, workflow_id, status, trigger_payload, dedupe_key, started_at)
     VALUES ($1, $2, $3, 'running', $4::jsonb, $5, now())
     ON CONFLICT (workflow_id, dedupe_key) WHERE status <> 'failed' DO NOTHING
     RETURNING id`,
    [tenantId, projectId, definitionId, JSON.stringify(triggerPayload), dedupeKey],
  );

  let executionId: string;
  if ((executionInsert.rowCount ?? 0) === 0) {
    // Lost a genuine race to a concurrent caller inserting the same
    // dedupe_key between our SELECT and INSERT above — the other caller's
    // row is the real one; look it up rather than erroring out.
    const racedLookup = await tenantDb.query<{ id: string }>(
      `SELECT id FROM workflow_executions
       WHERE workflow_id = $1 AND tenant_id = $2 AND dedupe_key = $3 AND status <> 'failed'`,
      [definitionId, tenantId, dedupeKey],
    );
    if ((racedLookup.rowCount ?? 0) === 0) {
      throw new Error("runWorkflow: failed to create or find a workflow_executions row (unexpected race)");
    }
    return racedLookup.rows[0].id;
  }
  executionId = executionInsert.rows[0].id;

  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  const evalContext: WorkflowContext = { trigger: triggerPayload, leadId: leadId ?? null };

  let currentKey: string | null | undefined = nodes[0]?.key ?? null;
  let failed = false;
  let failureMessage: string | null = null;

  while (currentKey) {
    const node = nodesByKey.get(currentKey);
    if (!node) {
      // A `next`/`onTrue`/`onFalse` pointing at a node key that doesn't
      // exist in this definition's own `nodes` array is a definition-authoring
      // bug, not a runtime data problem — treat it the same as any other
      // node failure (fail the run, never crash the caller).
      failed = true;
      failureMessage = `Unknown node key "${currentKey}" referenced by this workflow's DAG`;
      break;
    }

    const startedAt = new Date();
    try {
      if (node.type === "condition") {
        const result = evaluateCondition(node, evalContext);
        await tenantDb.query(
          `INSERT INTO workflow_execution_steps (tenant_id, execution_id, node_key, status, input, output, started_at, finished_at)
           VALUES ($1, $2, $3, 'succeeded', $4::jsonb, $5::jsonb, $6, now())`,
          [tenantId, executionId, node.key, JSON.stringify(node.config), JSON.stringify({ result }), startedAt],
        );
        currentKey = result ? node.onTrue ?? null : node.onFalse ?? null;
      } else {
        const executor = ACTION_EXECUTORS[String(node.config.actionType ?? "")];
        if (!executor) {
          throw new Error(`Unknown action type "${String(node.config.actionType)}" on node "${node.key}"`);
        }
        const output = await executor(node.config, { tenantDb, tenantId, projectId, leadId, triggerPayload });
        await tenantDb.query(
          `INSERT INTO workflow_execution_steps (tenant_id, execution_id, node_key, status, input, output, started_at, finished_at)
           VALUES ($1, $2, $3, 'succeeded', $4::jsonb, $5::jsonb, $6, now())`,
          [tenantId, executionId, node.key, JSON.stringify(node.config), JSON.stringify(output), startedAt],
        );
        currentKey = node.next ?? null;
      }
    } catch (err) {
      // Per-node failure isolation: this node's own failure is recorded
      // here, and ends the walk — but never rethrows past runWorkflow.
      const message = err instanceof Error ? err.message : String(err);
      await tenantDb
        .query(
          `INSERT INTO workflow_execution_steps (tenant_id, execution_id, node_key, status, input, output, started_at, finished_at)
           VALUES ($1, $2, $3, 'failed', $4::jsonb, $5::jsonb, $6, now())`,
          [tenantId, executionId, node.key, JSON.stringify(node.config), JSON.stringify({ error: message }), startedAt],
        )
        .catch(() => undefined); // never let a logging failure mask the real one
      failed = true;
      failureMessage = `Node "${node.key}" failed: ${message}`;
      break;
    }
  }

  await tenantDb.query(
    `UPDATE workflow_executions SET status = $1, error = $2, finished_at = now() WHERE id = $3 AND tenant_id = $4`,
    [failed ? "failed" : "completed", failureMessage, executionId, tenantId],
  );

  return executionId;
}

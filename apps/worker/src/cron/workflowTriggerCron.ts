import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";

/**
 * workflowTriggerCron: the real recurring caller for Workstream B's native
 * lifecycle-workflow automation engine (apps/api/src/lib/workflowEngine.ts's
 * runWorkflow), for the two trigger_type values that need polling:
 * 'scheduled' (fire on a fixed interval) and 'condition' (fire whenever a
 * real row in this project matches a simple field/operator/value +
 * "inactive for N days" condition). 'event'-triggered workflow_definitions
 * rows are intentionally never touched by this cron — those are fired
 * directly by a future caller via runWorkflow(), exactly like 'event'
 * trigger_type's own doc comment in 610_create_workflow_definitions.sql
 * says.
 *
 * This follows the EXACT SAME real worker-side periodic-loop pattern and
 * cross-app dynamic-import trick as apps/worker/src/jobs/
 * sequenceSchedulerCron.ts and stalledDealCron.ts — see either of those
 * files' header comments for the full reasoning (no BullMQ repeatable-job
 * infra exists for this kind of cross-tenant periodic scan; no shared
 * "apps/api calling convention" package exists for one app to import
 * another app's own /lib code at the TypeScript level, so the REAL,
 * already-built runWorkflow is loaded straight from apps/api's compiled
 * output at runtime; TypeScript cannot ambiently type a relative
 * cross-app ESM specifier, so the specifier is passed via a `const`
 * rather than an inline literal, and the explicit RunWorkflowFn type below
 * is cast onto that `any` import, not re-derived from it — it must be kept
 * in sync by hand if workflowEngine.ts's runWorkflow signature ever
 * changes). Requires apps/api to have been built before apps/worker starts
 * (already true for every deploy/build path in this repo).
 *
 * INTERVAL CHOICE: every 10 minutes by default — finer than the hourly
 * stalled-deal cadence (lifecycle nudges are more time-sensitive than a
 * 7-day stall threshold) but coarser than the 15-minute sequence
 * scheduler, since a 'scheduled' trigger's own intervalMinutes (checked
 * against each definition's most recent execution, not this cron's own
 * tick rate) is what actually governs how often any one workflow fires —
 * this tick rate only bounds how promptly a newly-due schedule/condition
 * is noticed, not how often it fires.
 */

export interface WorkflowNodeLike {
  key: string;
}

type RunWorkflowFn = (
  definitionId: string,
  triggerPayload: Record<string, unknown>,
  context: { tenantDb: PoolClient; tenantId: string; projectId: string; leadId?: string },
) => Promise<string>;

const WORKFLOW_ENGINE_MODULE_PATH = "../../../api/dist/lib/workflowEngine.js";

async function loadRunWorkflow(): Promise<RunWorkflowFn> {
  const mod = (await import(WORKFLOW_ENGINE_MODULE_PATH)) as { runWorkflow: RunWorkflowFn };
  return mod.runWorkflow;
}

export interface ActiveWorkflowProjectRow {
  tenant_id: string;
  project_id: string;
}

/**
 * Finds every distinct (tenant_id, project_id) pair with at least one
 * active 'scheduled' or 'condition' workflow_definitions row — the one
 * deliberately cross-tenant query in this file, for the same documented
 * reason findProjectsWithActiveSequences (sequenceSchedulerCron.ts) and
 * findProjectsWithNonTerminalDeals (stalledDealCron.ts) already rely on:
 * apps/worker connects as a superuser in this environment's docker-compose
 * setup, bypassing RLS for this one "which tenants/projects have work" scan
 * only — every subsequent read/write for a specific pair still goes
 * through withTenantContext(tenantId, ...) below.
 */
export async function findProjectsWithActiveTriggerableWorkflows(
  pool: Pick<Pool, "query">,
): Promise<ActiveWorkflowProjectRow[]> {
  const result = await pool.query<ActiveWorkflowProjectRow>(
    `SELECT DISTINCT tenant_id, project_id
     FROM workflow_definitions
     WHERE status = 'active' AND trigger_type IN ('scheduled', 'condition')`,
  );
  return result.rows;
}

interface WorkflowDefinitionRow {
  id: string;
  trigger_type: "scheduled" | "condition";
  trigger_config: Record<string, unknown>;
}

interface LeadMatchRow {
  id: string;
  email: string | null;
  name: string | null;
  status: string;
}

/**
 * A 'scheduled' definition is due when it has never run, or its most
 * recent workflow_executions.started_at is at least trigger_config.intervalMinutes
 * ago. No separate "last_triggered_at" column is needed on
 * workflow_definitions for this — the real execution history
 * (workflow_executions, which exists regardless) is the single source of
 * truth for "when did this last actually run", so there is nothing here
 * that could drift out of sync with what genuinely happened.
 */
async function isScheduledDefinitionDue(tenantDb: PoolClient, tenantId: string, def: WorkflowDefinitionRow): Promise<boolean> {
  const intervalMinutes = Number(def.trigger_config.intervalMinutes ?? 60);
  const lastRun = await tenantDb.query<{ started_at: string }>(
    `SELECT started_at FROM workflow_executions
     WHERE workflow_id = $1 AND tenant_id = $2
     ORDER BY started_at DESC LIMIT 1`,
    [def.id, tenantId],
  );
  if ((lastRun.rowCount ?? 0) === 0) return true;
  const lastStartedAt = new Date(lastRun.rows[0].started_at).getTime();
  return Date.now() - lastStartedAt >= intervalMinutes * 60 * 1000;
}

/**
 * A 'condition' definition's trigger_config supports exactly the shape
 * the four seeded library workflows (see packages/db/seeds/
 * workflow_automation_library.sql) need: leads matching an optional exact
 * status, that have additionally been inactive (a chosen timestamp column
 * older than a chosen number of days) for long enough. This is a
 * deliberately narrow condition-trigger surface — not a generic query
 * builder — matching this codebase's general preference for a small,
 * real, honestly-scoped feature over a speculative general one.
 */
async function findConditionTriggerMatches(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  def: WorkflowDefinitionRow,
): Promise<LeadMatchRow[]> {
  const entity = String(def.trigger_config.entity ?? "leads");
  if (entity !== "leads") {
    // Only 'leads' is a supported condition-trigger entity today — an
    // honestly unsupported entity simply matches nothing, rather than
    // guessing at a query against a table this engine doesn't understand.
    return [];
  }

  const statusEquals = typeof def.trigger_config.statusEquals === "string" ? def.trigger_config.statusEquals : null;
  const inactiveField = def.trigger_config.inactiveField === "created_at" ? "created_at" : "updated_at";
  const inactiveDays = Number(def.trigger_config.inactiveDays ?? 0);

  const conditions: string[] = ["tenant_id = $1", "project_id = $2"];
  const params: unknown[] = [tenantId, projectId];

  if (statusEquals) {
    params.push(statusEquals);
    conditions.push(`status = $${params.length}`);
  }
  if (inactiveDays > 0) {
    params.push(inactiveDays);
    conditions.push(`${inactiveField} < now() - ($${params.length} * interval '1 day')`);
  }

  const result = await tenantDb.query<LeadMatchRow>(
    `SELECT id, email, name, status FROM leads WHERE ${conditions.join(" AND ")} LIMIT 500`,
    params,
  );
  return result.rows;
}

export interface WorkflowTriggerCronTickResult {
  projectsChecked: number;
  definitionsEvaluated: number;
  executionsStarted: number;
}

/**
 * Runs one tick across every (tenant, project) pair with active
 * 'scheduled'/'condition' workflow_definitions rows, calling the REAL
 * runWorkflow for each due schedule / each matching condition row, inside
 * a tenant-scoped transaction per project (withTenantContext).
 */
export async function runWorkflowTriggerCronTick(pool: Pick<Pool, "query">): Promise<WorkflowTriggerCronTickResult> {
  const runWorkflow = await loadRunWorkflow();
  const projects = await findProjectsWithActiveTriggerableWorkflows(pool);

  let definitionsEvaluated = 0;
  let executionsStarted = 0;

  for (const { tenant_id: tenantId, project_id: projectId } of projects) {
    try {
      await withTenantContext(tenantId, async (tenantDb) => {
        const defs = await tenantDb.query<WorkflowDefinitionRow>(
          `SELECT id, trigger_type, trigger_config FROM workflow_definitions
           WHERE tenant_id = $1 AND project_id = $2 AND status = 'active' AND trigger_type IN ('scheduled', 'condition')`,
          [tenantId, projectId],
        );

        for (const def of defs.rows) {
          definitionsEvaluated += 1;
          try {
            if (def.trigger_type === "scheduled") {
              if (!(await isScheduledDefinitionDue(tenantDb, tenantId, def))) continue;
              await runWorkflow(
                def.id,
                { triggerType: "scheduled", firedAt: new Date().toISOString() },
                { tenantDb, tenantId, projectId },
              );
              executionsStarted += 1;
            } else {
              const matches = await findConditionTriggerMatches(tenantDb, tenantId, projectId, def);
              for (const lead of matches) {
                await runWorkflow(
                  def.id,
                  { triggerType: "condition", leadId: lead.id, leadStatus: lead.status },
                  { tenantDb, tenantId, projectId, leadId: lead.id },
                );
                executionsStarted += 1;
              }
            }
          } catch (err) {
            // One definition's failure must never stop the rest of this
            // project's definitions (or any other project) from being
            // evaluated — same "never fail the whole batch" principle
            // every other cron in this codebase follows.
            logger.error({ err, tenantId, projectId, workflowId: def.id }, "workflow trigger cron: runWorkflow failed for this definition");
          }
        }
      });
    } catch (err) {
      logger.error({ err, tenantId, projectId }, "workflow trigger cron: tick failed for this project");
    }
  }

  return { projectsChecked: projects.length, definitionsEvaluated, executionsStarted };
}

const DEFAULT_INTERVAL_MS = Number(process.env.WORKFLOW_TRIGGER_CRON_INTERVAL_MS ?? 10 * 60 * 1000); // every 10 minutes

/**
 * Starts the real recurring loop: ticks once immediately, then every
 * WORKFLOW_TRIGGER_CRON_INTERVAL_MS (default every 10 minutes). Returns
 * the interval handle so apps/worker/src/index.ts can clearInterval it on
 * shutdown, exactly like startSequenceSchedulerCron/startStalledDealCron's
 * return values are used there already.
 */
export function startWorkflowTriggerCron(pool: Pick<Pool, "query">): ReturnType<typeof setInterval> {
  const run = (): void => {
    runWorkflowTriggerCronTick(pool)
      .then(({ projectsChecked, definitionsEvaluated, executionsStarted }) => {
        if (executionsStarted > 0) {
          logger.info({ projectsChecked, definitionsEvaluated, executionsStarted }, "workflow trigger cron tick started executions");
        }
      })
      .catch((err) => logger.error({ err }, "workflow trigger cron tick failed"));
  };

  run();
  return setInterval(run, DEFAULT_INTERVAL_MS);
}

import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";

/**
 * experimentActionExecutor: the real recurring caller that performs the
 * live-entity mutation for a growth_experiment_actions row once a human
 * has approved it.
 *
 * WHY THIS LIVES IN apps/worker RATHER THAN INLINE IN approvals.ts:
 * apps/api/src/routes/approvals.ts's POST .../approvals/:approvalId/decision
 * is the one place every other approval-gated action in this codebase
 * (campaign_id / growth_advisor_action_id) is executed, inline, in the
 * same request that flips the approval to 'approved'. That file is
 * off-limits to edit this round, and it has no branch for a
 * growth_experiment_action_id subject. Rather than leaving an 'approved'
 * approval with no real effect, this loop polls for exactly that
 * situation and performs the deferred execution -- same guarantee
 * (nothing is ever applied before a genuine human 'approved' decision),
 * resolved a few seconds later instead of inline.
 *
 * Follows the EXACT same pattern as apps/worker/src/jobs/stalledDealCron.ts
 * / sequenceSchedulerCron.ts: a plain periodic setInterval loop (checked
 * once immediately, then on EXPERIMENT_ACTION_EXECUTOR_INTERVAL_MS),
 * scanning for pending work, then calling the real, already-built
 * executeApprovedExperimentAction (apps/api/src/lib/experimentEngine.ts)
 * for each one found, inside a tenant-scoped transaction.
 *
 * CROSS-APP IMPORT NOTE: identical situation and identical resolution to
 * stalledDealCron.ts's loadCheckStalledDeals() -- executeApprovedExperimentAction
 * is defined in apps/api/src/lib/experimentEngine.ts, a different
 * app/package than this one, and this job's purpose is to call the
 * EXISTING function, not reimplement its logic. This dynamically imports
 * the real, already-built function from apps/api's compiled output
 * (apps/api/dist/lib/experimentEngine.js) at runtime, which requires
 * apps/api to have been built before apps/worker starts -- already true
 * for every deploy/build path in this repo (the root "build" script builds
 * @devlaunch/api before @devlaunch/worker).
 */

export interface ExecuteActionResult {
  applied: boolean;
  reason?: string;
}

type ExecuteApprovedExperimentActionFn = (
  tenantDb: PoolClient,
  tenantId: string,
  actionId: string,
) => Promise<ExecuteActionResult>;

const EXPERIMENT_ENGINE_MODULE_PATH = "../../../api/dist/lib/experimentEngine.js";

async function loadExecuteApprovedExperimentAction(): Promise<ExecuteApprovedExperimentActionFn> {
  const mod = (await import(EXPERIMENT_ENGINE_MODULE_PATH)) as {
    executeApprovedExperimentAction: ExecuteApprovedExperimentActionFn;
  };
  return mod.executeApprovedExperimentAction;
}

export interface PendingExperimentActionRow {
  tenant_id: string;
  action_id: string;
}

/**
 * Finds every growth_experiment_actions row still 'pending_approval' whose
 * paired approvals row has actually been decided (approved OR rejected --
 * executeApprovedExperimentAction() itself resolves a rejected one to
 * status 'rejected' with no live-entity mutation, same honest "decision
 * recorded either way" guarantee as every other approval-gated action in
 * this codebase). Same deliberately cross-tenant scan as
 * findProjectsWithNonTerminalDeals in stalledDealCron.ts, for the
 * identical documented reason: apps/worker connects as a superuser in this
 * environment's docker-compose setup for this one "which rows have work"
 * scan only -- every subsequent read/write for a specific row still goes
 * through withTenantContext(tenantId, ...) below.
 */
export async function findPendingExperimentActions(
  pool: Pick<Pool, "query">,
): Promise<PendingExperimentActionRow[]> {
  const result = await pool.query<PendingExperimentActionRow>(
    `SELECT ga.tenant_id AS tenant_id, ga.id AS action_id
     FROM growth_experiment_actions ga
     JOIN approvals a ON a.growth_experiment_action_id = ga.id AND a.tenant_id = ga.tenant_id
     WHERE ga.status = 'pending_approval' AND a.status IN ('approved', 'rejected')`,
  );
  return result.rows;
}

/**
 * Runs one tick: finds every pending growth_experiment_actions row with a
 * real decision already made on its paired approval, and calls the real
 * executeApprovedExperimentAction for each, inside a tenant-scoped
 * transaction. executeApprovedExperimentAction is itself idempotent (its
 * own `ga.status = 'pending_approval'` WHERE clause means a row already
 * resolved by an earlier tick is simply skipped -- re-running this loop,
 * or running two instances concurrently, never double-applies a winner).
 */
export async function runExperimentActionExecutorTick(
  pool: Pick<Pool, "query">,
): Promise<{ actionsChecked: number; applied: number }> {
  const executeApprovedExperimentAction = await loadExecuteApprovedExperimentAction();
  const pending = await findPendingExperimentActions(pool);

  let applied = 0;

  for (const { tenant_id: tenantId, action_id: actionId } of pending) {
    try {
      const result = await withTenantContext(tenantId, (client) =>
        executeApprovedExperimentAction(client, tenantId, actionId),
      );
      if (result.applied) applied += 1;
    } catch (err) {
      // One tenant/action's failure must never stop the rest of the batch
      // -- same "never fail the whole batch" principle stalledDealCron.ts
      // follows for the same kind of cross-tenant loop.
      logger.error({ err, tenantId, actionId }, "experiment action executor: execution failed for this action");
    }
  }

  return { actionsChecked: pending.length, applied };
}

// A human already made the real decision (approved/rejected); this loop
// only needs to notice it and apply the real effect, so a short interval
// (default: every minute) keeps the "approval decided -> real effect"
// latency low without adding real load -- far more frequent than
// stalledDealCron's hourly cadence, matching sequenceSchedulerCron's
// "time-sensitive" reasoning instead.
const DEFAULT_INTERVAL_MS = Number(process.env.EXPERIMENT_ACTION_EXECUTOR_INTERVAL_MS ?? 60 * 1000);

/**
 * Starts the real recurring loop: ticks once immediately, then every
 * EXPERIMENT_ACTION_EXECUTOR_INTERVAL_MS (default every minute). Returns
 * the interval handle so apps/worker/src/index.ts can clearInterval it on
 * shutdown, same convention as startStalledDealCron's return value.
 */
export function startExperimentActionExecutor(pool: Pick<Pool, "query">): ReturnType<typeof setInterval> {
  const run = (): void => {
    runExperimentActionExecutorTick(pool)
      .then(({ actionsChecked, applied }) => {
        if (actionsChecked > 0) {
          logger.info({ actionsChecked, applied }, "experiment action executor tick processed pending actions");
        }
      })
      .catch((err) => logger.error({ err }, "experiment action executor tick failed"));
  };

  run();
  return setInterval(run, DEFAULT_INTERVAL_MS);
}

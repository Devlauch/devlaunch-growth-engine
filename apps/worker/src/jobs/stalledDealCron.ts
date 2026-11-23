import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";

/**
 * stalledDealCron: the real recurring caller for
 * apps/api/src/lib/salesPipeline.ts's checkStalledDeals, replacing the
 * "manual-trigger only" limitation that function's own doc comment
 * documents (checkStalledDeals is otherwise only ever invoked from the
 * human-triggered POST /deals/check-stalled route in
 * apps/api/src/routes/deals.ts — confirmed by grepping apps/worker/src for
 * any existing caller: zero matches).
 *
 * This follows the EXACT same pattern as
 * apps/worker/src/jobs/sequenceSchedulerCron.ts, which solved the
 * identical "the real logic lives in apps/api, and this is apps/worker"
 * problem for advanceDueEnrollments: a plain periodic setInterval loop
 * (checked once immediately, then on STALLED_DEAL_CRON_INTERVAL_MS) that
 * scans for tenants/projects with work, then calls the REAL,
 * already-built checkStalledDeals for each one inside a tenant-scoped
 * transaction.
 *
 * INTERVAL CHOICE: hourly (same default cadence as
 * apps/worker/src/reports/scheduleLoop.ts's report-schedule loop), not
 * sequenceSchedulerCron's 15-minute interval. The sequence scheduler needs
 * to send time-sensitive outreach steps promptly; a stalled deal is
 * measured in STAGE_STALL_THRESHOLD_DAYS (7 days — see salesPipeline.ts),
 * so checking hourly is already far more than granular enough and avoids
 * adding an arbitrary new cadence convention to this codebase for no
 * benefit.
 *
 * CROSS-APP IMPORT NOTE (identical situation and identical resolution to
 * sequenceSchedulerCron.ts — see that file's header comment for the full
 * reasoning): checkStalledDeals is defined in
 * apps/api/src/lib/salesPipeline.ts, a different app/package than this
 * one, and this task's job is explicitly to call the EXISTING function,
 * not reimplement its idempotent NOT-EXISTS/unique-trigger-reason logic.
 * There's still no shared-package home for this kind of per-app business
 * logic (packages/agent-sdk is for genuinely shared code with a real
 * exports/types field), so — exactly like advanceDueEnrollments — this
 * module dynamically imports the REAL, already-built function straight
 * from apps/api's compiled output (apps/api/dist/lib/salesPipeline.js) at
 * runtime, through loadCheckStalledDeals() below. This requires apps/api
 * to have been built before apps/worker starts, which is already true for
 * every deploy/build path in this repo (the root "build" script builds
 * @devlaunch/api before @devlaunch/worker).
 *
 * TYPE-CHECKING NOTE: same as sequenceSchedulerCron.ts — TypeScript does
 * not support ambient `declare module` typing for a relative specifier, so
 * the specifier is passed via a `const`
 * (STALLED_DEAL_SALES_PIPELINE_MODULE_PATH) rather than an inline string
 * literal, keeping TypeScript from attempting (and failing) module
 * resolution against apps/api/dist at compile time. The explicit
 * `CheckStalledDealsFn`/`StalledFollowUpResult` types below are cast onto
 * that `any` import, not re-derived from it, and declare ONLY the shape of
 * apps/api/src/lib/salesPipeline.ts's real checkStalledDeals export —
 * nothing here reimplements any of that function's logic — and must be
 * kept in sync by hand if that file's return shape ever changes.
 */

export interface StalledFollowUpResult {
  dealId: string;
  leadId: string;
  crmTaskId: string;
  followUpTaskId: string;
}

type CheckStalledDealsFn = (
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
) => Promise<StalledFollowUpResult[]>;

const STALLED_DEAL_SALES_PIPELINE_MODULE_PATH = "../../../api/dist/lib/salesPipeline.js";

async function loadCheckStalledDeals(): Promise<CheckStalledDealsFn> {
  const mod = (await import(STALLED_DEAL_SALES_PIPELINE_MODULE_PATH)) as { checkStalledDeals: CheckStalledDealsFn };
  return mod.checkStalledDeals;
}

export interface NonTerminalDealProjectRow {
  tenant_id: string;
  project_id: string;
}

/**
 * Finds every distinct (tenant_id, project_id) pair with at least one
 * non-terminal deal (stage not in 'won'/'lost') — i.e. every project where
 * checkStalledDeals might actually have something to do. This is the one
 * deliberately cross-tenant query in this file, for the exact same
 * documented reason findProjectsWithActiveSequences in
 * sequenceSchedulerCron.ts (and checkAndEnqueueDueSchedules in
 * scheduleLoop.ts before it) already relies on: apps/worker connects as a
 * superuser in this environment's docker-compose setup, bypassing RLS's
 * FORCE ROW LEVEL SECURITY for this one "which tenants/projects have work"
 * scan only. Every subsequent read/write for a specific pair still goes
 * through withTenantContext(tenantId, ...) below, so a bug here can never
 * cross a tenant boundary when actually checking/creating follow-ups.
 */
export async function findProjectsWithNonTerminalDeals(
  pool: Pick<Pool, "query">,
): Promise<NonTerminalDealProjectRow[]> {
  const result = await pool.query<NonTerminalDealProjectRow>(
    `SELECT DISTINCT d.tenant_id, d.project_id
     FROM deals d
     WHERE d.stage NOT IN ('won', 'lost')`,
  );
  return result.rows;
}

/**
 * Runs one tick: finds every (tenant, project) pair with at least one
 * non-terminal deal, and calls the REAL checkStalledDeals for each, inside
 * a tenant-scoped transaction (withTenantContext — same RLS-respecting
 * pattern every other worker DB write in this codebase uses).
 *
 * checkStalledDeals is already idempotent (its own NOT EXISTS / unique
 * trigger_reason check skips any deal that already has an open
 * stage_stalled follow-up), so re-running this tick repeatedly, or
 * concurrently with a manual POST /deals/check-stalled call for the same
 * project, never creates a duplicate follow-up task — this loop adds no
 * additional dedup logic of its own because none is needed.
 */
export async function runStalledDealCronTick(
  pool: Pick<Pool, "query">,
): Promise<{ projectsChecked: number; totalFollowUpsCreated: number }> {
  const checkStalledDeals = await loadCheckStalledDeals();

  const projects = await findProjectsWithNonTerminalDeals(pool);

  let totalFollowUpsCreated = 0;

  for (const { tenant_id: tenantId, project_id: projectId } of projects) {
    try {
      const created = await withTenantContext(tenantId, (client) => checkStalledDeals(client, tenantId, projectId));
      totalFollowUpsCreated += created.length;
    } catch (err) {
      // One tenant/project's failure must never stop the rest of the
      // batch from being processed — same "never fail the whole batch"
      // principle sequenceSchedulerCron.ts's tick follows for the same
      // kind of cross-tenant loop.
      logger.error({ err, tenantId, projectId }, "stalled deal cron: checkStalledDeals failed for this project");
    }
  }

  return { projectsChecked: projects.length, totalFollowUpsCreated };
}

// Hourly default — see this file's header comment for why that cadence
// (matching scheduleLoop.ts's report-schedule loop) fits a 7-day stall
// threshold better than sequenceSchedulerCron's 15-minute interval would.
const DEFAULT_INTERVAL_MS = Number(process.env.STALLED_DEAL_CRON_INTERVAL_MS ?? 60 * 60 * 1000); // hourly

/**
 * Starts the real recurring loop: ticks once immediately, then every
 * STALLED_DEAL_CRON_INTERVAL_MS (default hourly). Returns the interval
 * handle so the caller (apps/worker/src/index.ts) can clearInterval it on
 * shutdown, exactly like startSequenceSchedulerCron's return value is used
 * there already.
 */
export function startStalledDealCron(pool: Pick<Pool, "query">): ReturnType<typeof setInterval> {
  const run = (): void => {
    runStalledDealCronTick(pool)
      .then(({ projectsChecked, totalFollowUpsCreated }) => {
        if (totalFollowUpsCreated > 0) {
          logger.info({ projectsChecked, totalFollowUpsCreated }, "stalled deal cron tick created follow-up tasks");
        }
      })
      .catch((err) => logger.error({ err }, "stalled deal cron tick failed"));
  };

  run();
  return setInterval(run, DEFAULT_INTERVAL_MS);
}

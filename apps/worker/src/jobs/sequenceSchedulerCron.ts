import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";

/**
 * sequenceSchedulerCron: the real recurring caller for roadmap item 10's
 * sequence engine (apps/api/src/lib/advanceSequences.ts's
 * advanceDueEnrollments), replacing the "manual-trigger only" limitation
 * documented in docs/FEATURE_STATUS.md ("A scheduler/cron for POST
 * /sequences/advance ... the Phase 4 workflow's execution stage is a
 * manual-trigger path, not a replacement for this.").
 *
 * This follows the EXACT same real worker-side cron-like loop pattern
 * apps/worker/src/reports/scheduleLoop.ts already uses for report
 * schedules: no BullMQ repeatable-job infra is wired up elsewhere in this
 * codebase for this kind of cross-tenant periodic scan, so this is a plain
 * periodic setInterval loop (checked once immediately, then on
 * SEQUENCE_SCHEDULER_INTERVAL_MS, default every 15 minutes).
 *
 * CROSS-APP IMPORT NOTE: advanceDueEnrollments is defined in
 * apps/api/src/lib/advanceSequences.ts, a DIFFERENT app/package than this
 * one. The task this file was built for is explicit: "calls the existing
 * advanceDueEnrollments (don't reimplement its logic)". There is no
 * existing convention in this monorepo for one app importing another
 * app's compiled output (packages/agent-sdk is the real shared-package
 * pattern used for genuinely shared code, with a proper "exports"/"types"
 * field) — moving advanceDueEnrollments into a shared package was out of
 * this task's ownership scope (apps/api/src/lib/advanceSequences.ts is
 * explicitly the file this task owns and edits in place). So this module
 * dynamically imports the REAL, already-built function straight from
 * apps/api's compiled output (apps/api/dist/lib/advanceSequences.js) at
 * runtime, through loadAdvanceDueEnrollments() below.
 *
 * This REQUIRES apps/api to have been built (npm run build
 * --workspace=@devlaunch/api) before apps/worker starts — true for every
 * deploy/build path in this repo already, since the root "build" script
 * builds @devlaunch/api before @devlaunch/worker.
 *
 * TYPE-CHECKING NOTE: TypeScript explicitly does not support `declare
 * module "./a/relative/path"` ambient declarations (only non-relative
 * specifiers can be ambiently typed), so a normal ambient .d.ts shim isn't
 * an option for a relative cross-app ESM import like this one. Passing the
 * specifier via a `const` (ADVANCE_SEQUENCES_MODULE_PATH) rather than an
 * inline string literal keeps TypeScript from attempting (and failing) its
 * own module resolution against apps/api/dist at compile time — `import()`
 * of a non-literal expression always types as `Promise<any>` — and the
 * explicit `AdvanceDueEnrollmentsFn`/`AdvanceResult` types below (cast onto
 * that `any`, not re-derived from it) are what give this file real type
 * safety afterwards. Those local types declare ONLY the shape of
 * apps/api/src/lib/advanceSequences.ts's real exports — nothing here
 * re-implements any of that function's logic — and must be kept in sync by
 * hand if that file's AdvanceResult shape ever changes.
 */

export interface AdvanceSkipReason {
  enrollmentId: string;
  reason: string;
}

export interface AdvanceResult {
  advanced: number;
  tasksCreated: number;
  skipped: AdvanceSkipReason[];
  stoppedForReply: number;
  emailsSent: number;
}

type AdvanceDueEnrollmentsFn = (tenantDb: PoolClient, tenantId: string, projectId: string) => Promise<AdvanceResult>;

const ADVANCE_SEQUENCES_MODULE_PATH = "../../../api/dist/lib/advanceSequences.js";

async function loadAdvanceDueEnrollments(): Promise<AdvanceDueEnrollmentsFn> {
  const mod = (await import(ADVANCE_SEQUENCES_MODULE_PATH)) as { advanceDueEnrollments: AdvanceDueEnrollmentsFn };
  return mod.advanceDueEnrollments;
}

export interface DueSequenceProjectRow {
  tenant_id: string;
  project_id: string;
}

/**
 * Finds every distinct (tenant_id, project_id) pair with at least one
 * is_active sequence that has at least one 'active' enrollment — i.e.
 * every project where advanceDueEnrollments might actually have something
 * to do. This is the one deliberately cross-tenant query in this file
 * (exactly like checkAndEnqueueDueSchedules in scheduleLoop.ts, and for
 * the same documented reason: apps/worker connects as a superuser in this
 * environment's docker-compose setup, so RLS's FORCE ROW LEVEL SECURITY is
 * bypassed for this one "which tenants/projects have work" scan only —
 * every subsequent read/write for a specific pair still goes through
 * withTenantContext(tenantId, ...) below, so a bug here can never cross a
 * tenant boundary when actually advancing enrollments).
 */
export async function findProjectsWithActiveSequences(pool: Pick<Pool, "query">): Promise<DueSequenceProjectRow[]> {
  const result = await pool.query<DueSequenceProjectRow>(
    `SELECT DISTINCT s.tenant_id, s.project_id
     FROM sequences s
     WHERE s.is_active = true
       AND EXISTS (
         SELECT 1 FROM sequence_enrollments se
         WHERE se.sequence_id = s.id AND se.tenant_id = s.tenant_id AND se.status = 'active'
       )`,
  );
  return result.rows;
}

/**
 * Runs one tick: finds every (tenant, project) pair with active sequence
 * work, and calls the REAL advanceDueEnrollments for each, inside a
 * tenant-scoped transaction (withTenantContext — same RLS-respecting
 * pattern every other worker DB write in this codebase uses).
 */
export async function runSequenceSchedulerTick(
  pool: Pick<Pool, "query">,
): Promise<{ projectsChecked: number; totalAdvanced: number; totalEmailsSent: number; totalStoppedForReply: number }> {
  const advanceDueEnrollments = await loadAdvanceDueEnrollments();

  const projects = await findProjectsWithActiveSequences(pool);

  let totalAdvanced = 0;
  let totalEmailsSent = 0;
  let totalStoppedForReply = 0;

  for (const { tenant_id: tenantId, project_id: projectId } of projects) {
    try {
      const result = await withTenantContext(tenantId, (client) => advanceDueEnrollments(client, tenantId, projectId));
      totalAdvanced += result.advanced;
      totalEmailsSent += result.emailsSent;
      totalStoppedForReply += result.stoppedForReply;
    } catch (err) {
      // One tenant/project's failure must never stop the rest of the
      // batch from being processed — same "never fail the whole batch"
      // principle advanceDueEnrollments itself follows internally.
      logger.error({ err, tenantId, projectId }, "sequence scheduler: advanceDueEnrollments failed for this project");
    }
  }

  return { projectsChecked: projects.length, totalAdvanced, totalEmailsSent, totalStoppedForReply };
}

const DEFAULT_INTERVAL_MS = Number(process.env.SEQUENCE_SCHEDULER_INTERVAL_MS ?? 15 * 60 * 1000); // every 15 minutes

/**
 * Starts the real recurring loop: ticks once immediately, then every
 * SEQUENCE_SCHEDULER_INTERVAL_MS (default 15 minutes). Returns the
 * interval handle so the caller (apps/worker/src/index.ts) can clearInterval
 * it on shutdown, exactly like startScheduleLoop's return value is used
 * there already for the report-schedule loop.
 */
export function startSequenceSchedulerCron(pool: Pick<Pool, "query">): ReturnType<typeof setInterval> {
  const run = (): void => {
    runSequenceSchedulerTick(pool)
      .then(({ projectsChecked, totalAdvanced, totalEmailsSent, totalStoppedForReply }) => {
        if (totalAdvanced > 0 || totalStoppedForReply > 0) {
          logger.info(
            { projectsChecked, totalAdvanced, totalEmailsSent, totalStoppedForReply },
            "sequence scheduler tick advanced due enrollments",
          );
        }
      })
      .catch((err) => logger.error({ err }, "sequence scheduler tick failed"));
  };

  run();
  return setInterval(run, DEFAULT_INTERVAL_MS);
}

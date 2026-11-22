import { Queue } from "bullmq";
import type { Pool } from "pg";
import { REPORT_GENERATION_QUEUE_NAME, type ReportGenerationJobData } from "@devlaunch/agent-sdk";
import { createRedisConnection } from "../queue.js";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";

export type ReportFrequency = "weekly" | "monthly";

const FREQUENCY_INTERVAL_MS: Record<ReportFrequency, number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  // "monthly" is approximated as a fixed 30-day interval rather than a
  // calendar month (which has no single fixed length) — a documented
  // choice, not an oversight.
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Pure due-date check: a schedule is due when it has never run
 * (lastGeneratedAt === null) or when its frequency's full interval has
 * elapsed since it last ran. No DB/queue access, so it's safe (and cheap)
 * to unit test directly — see apps/worker/test/reports/scheduleLoop.test.ts.
 */
export function isScheduleDue(frequency: ReportFrequency, lastGeneratedAt: Date | null, now: Date): boolean {
  if (lastGeneratedAt === null) return true;
  const elapsed = now.getTime() - lastGeneratedAt.getTime();
  return elapsed >= FREQUENCY_INTERVAL_MS[frequency];
}

/** The real data window a newly-generated scheduled report should cover. */
export function periodForSchedule(
  frequency: ReportFrequency,
  lastGeneratedAt: Date | null,
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  const intervalMs = FREQUENCY_INTERVAL_MS[frequency];
  const periodStart = lastGeneratedAt ?? new Date(now.getTime() - intervalMs);
  return { periodStart, periodEnd: now };
}

export interface ReportScheduleRow {
  id: string;
  tenant_id: string;
  project_id: string;
  frequency: ReportFrequency;
  last_generated_at: string | null;
  enabled: boolean;
}

/**
 * Scans report_schedules for due, enabled schedules and enqueues a report
 * generation job for each one — the exact same generated_reports row shape
 * and BullMQ queue as the on-demand POST .../reports/generate path (see
 * apps/api/src/routes/reports.ts).
 *
 * This is the one deliberately cross-tenant query in this file: finding
 * "every due schedule across every tenant" is inherently a cross-tenant
 * scan, so it runs directly against the pool rather than through
 * withTenantContext (which scopes to a single tenant). This relies on how
 * the DB role is actually configured in this environment: per
 * docker-compose.yml / .env.example, apps/worker connects as
 * POSTGRES_USER, which Postgres's official image provisions as a
 * superuser — and superusers always bypass row security (FORCE ROW LEVEL
 * SECURITY, per migration 013/242, only constrains non-superuser table
 * owners), per Postgres's documented RLS behavior. Every subsequent read/
 * write for a specific due schedule below still goes through
 * withTenantContext(tenantId, ...), so a bug here can never cross a tenant
 * boundary when actually generating or persisting report data — only this
 * one "which schedules exist and are due" scan is intentionally global.
 *
 * NO EMAIL IS EVER SENT HERE. report_schedules.recipients is stored only;
 * this environment has no real SMTP/email-provider configured, so a
 * schedule firing just produces a real, downloadable generated_reports row
 * — recipients are never contacted.
 */
export async function checkAndEnqueueDueSchedules(
  pool: Pick<Pool, "query">,
  enqueue: (data: ReportGenerationJobData) => Promise<void>,
  now: Date = new Date(),
): Promise<{ checked: number; enqueued: number }> {
  const result = await pool.query<ReportScheduleRow>(
    `SELECT id, tenant_id, project_id, frequency, last_generated_at, enabled
     FROM report_schedules
     WHERE enabled = true`,
  );

  let enqueued = 0;
  for (const schedule of result.rows) {
    const lastGeneratedAt = schedule.last_generated_at ? new Date(schedule.last_generated_at) : null;
    if (!isScheduleDue(schedule.frequency, lastGeneratedAt, now)) continue;

    const { periodStart, periodEnd } = periodForSchedule(schedule.frequency, lastGeneratedAt, now);

    const reportId = await withTenantContext(schedule.tenant_id, async (client) => {
      const insert = await client.query(
        `INSERT INTO generated_reports (tenant_id, project_id, schedule_id, status, period_start, period_end, created_by)
         VALUES ($1, $2, $3, 'queued', $4, $5, 'schedule')
         RETURNING id`,
        [schedule.tenant_id, schedule.project_id, schedule.id, periodStart.toISOString(), periodEnd.toISOString()],
      );
      return insert.rows[0].id as string;
    });

    await enqueue({
      reportId,
      tenantId: schedule.tenant_id,
      projectId: schedule.project_id,
      scheduleId: schedule.id,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });
    enqueued += 1;
  }

  return { checked: result.rows.length, enqueued };
}

const DEFAULT_LOOP_INTERVAL_MS = Number(process.env.REPORT_SCHEDULE_LOOP_INTERVAL_MS ?? 60 * 60 * 1000); // hourly

/**
 * Real worker-side cron-like loop: no BullMQ repeatable-job infra is wired
 * up elsewhere in this codebase for cross-tenant admin scans, so this is a
 * plain periodic setInterval loop (checked once immediately, then on
 * REPORT_SCHEDULE_LOOP_INTERVAL_MS, default hourly) living in the worker
 * process alongside the agent-run and report-generation BullMQ workers.
 */
export function startScheduleLoop(pool: Pick<Pool, "query">): ReturnType<typeof setInterval> {
  const connection = createRedisConnection();
  const queue = new Queue<ReportGenerationJobData>(REPORT_GENERATION_QUEUE_NAME, { connection });
  const enqueue = async (data: ReportGenerationJobData): Promise<void> => {
    await queue.add("generate", data, { jobId: data.reportId, removeOnComplete: 1000, removeOnFail: 1000 });
  };

  const run = (): void => {
    checkAndEnqueueDueSchedules(pool, enqueue)
      .then(({ checked, enqueued }) => {
        if (enqueued > 0) logger.info({ checked, enqueued }, "report schedule loop enqueued due reports");
      })
      .catch((err) => logger.error({ err }, "report schedule loop failed"));
  };

  run();
  return setInterval(run, DEFAULT_LOOP_INTERVAL_MS);
}

import { Worker, type Job } from "bullmq";
import { AGENT_RUN_QUEUE_NAME, createRedisConnection, type AgentRunJobData } from "./queue.js";
import { withTenantContext, pool, assertDatabaseRoleRespectsRls } from "./db.js";
import { getExecutor } from "./agents/registry.js";
import { logger } from "./logger.js";
import { startReportWorker } from "./reports/reportWorker.js";
import { startScheduleLoop } from "./reports/scheduleLoop.js";
import { startSequenceSchedulerCron } from "./jobs/sequenceSchedulerCron.js";
import { startStalledDealCron } from "./jobs/stalledDealCron.js";

const connection = createRedisConnection();

void assertDatabaseRoleRespectsRls().catch((err) => {
  logger.error({ err }, "database role RLS check failed");
  process.exit(1);
});

async function processAgentRun(job: Job<AgentRunJobData>): Promise<void> {
  const { executionId, tenantId, agentId, input } = job.data;
  const log = logger.child({ executionId, tenantId, agentId, jobId: job.id });

  const executor = getExecutor(agentId);
  if (!executor) {
    log.error("unknown agentId, no executor registered");
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE agent_executions
         SET status = 'failed', error = $2, finished_at = now()
         WHERE id = $1 AND tenant_id = $3`,
        [executionId, `Unknown agentId: ${agentId}`, tenantId],
      );
    });
    throw new Error(`Unknown agentId: ${agentId}`);
  }

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `UPDATE agent_executions
       SET status = 'running', started_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId],
    );
  });
  log.info("execution started");

  try {
    const output = await executor(input);
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE agent_executions
         SET status = 'succeeded', output = $2::jsonb, finished_at = now()
         WHERE id = $1 AND tenant_id = $3`,
        [executionId, JSON.stringify(output ?? {}), tenantId],
      );
    });
    log.info("execution succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE agent_executions
         SET status = 'failed', error = $2, finished_at = now()
         WHERE id = $1 AND tenant_id = $3`,
        [executionId, message, tenantId],
      );
    });
    log.error({ err }, "execution failed");
    throw err;
  }
}

const worker = new Worker<AgentRunJobData>(AGENT_RUN_QUEUE_NAME, processAgentRun, {
  connection,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "job completed");
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "job failed");
});

logger.info({ queue: AGENT_RUN_QUEUE_NAME }, "worker started, waiting for jobs");

// Client PDF reports: a second BullMQ worker (its own queue, same process)
// for on-demand + scheduled report generation, plus the real periodic loop
// that finds due report_schedules rows and enqueues them. See
// apps/worker/src/reports/ for the full implementation and the explicit
// "no email is sent" limitation this environment has.
const reportWorker = startReportWorker();
const scheduleLoopHandle = startScheduleLoop(pool);
// Multi-channel campaign execution: a real recurring loop replacing the
// previous manual-trigger-only `POST /sequences/advance` limitation. See
// apps/worker/src/jobs/sequenceSchedulerCron.ts.
const sequenceSchedulerHandle = startSequenceSchedulerCron(pool);
// Sales pipeline follow-up automation: a real recurring loop replacing the
// previous manual-trigger-only `POST /deals/check-stalled` limitation. See
// apps/worker/src/jobs/stalledDealCron.ts.
const stalledDealCronHandle = startStalledDealCron(pool);

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down worker");
  clearInterval(scheduleLoopHandle);
  clearInterval(sequenceSchedulerHandle);
  clearInterval(stalledDealCronHandle);
  await worker.close();
  await reportWorker.close();
  await connection.quit().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

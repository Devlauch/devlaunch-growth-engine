/**
 * BullMQ enqueue side for the Workstream E website-intelligence snapshot
 * job, following the EXACT same pattern as ../lib/reportQueue.ts /
 * ../lib/queue.ts: a dedicated `Queue` + `enqueue*` helper in apps/api,
 * consumed by a `Worker` in apps/worker
 * (apps/worker/src/jobs/websiteIntelligenceSnapshotJob.ts).
 *
 * This is a NEW queue name, not added to @devlaunch/agent-sdk's
 * AGENT_RUN_QUEUE_NAME/REPORT_GENERATION_QUEUE_NAME (packages/agent-sdk/
 * src/types.ts is mid-edit by another workstream this round — `git status`
 * shows it modified — so this avoids touching that shared, currently-hot
 * file). The job-data shape is instead duplicated locally on both the
 * apps/api (enqueue) and apps/worker (consume) sides, same small,
 * deliberate cross-app duplication convention already used for
 * keywordExtraction.ts/htmlText.ts (see those files' doc comments) rather
 * than a new apps/api -> apps/worker (or vice versa) runtime dependency.
 */
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME = "website-intelligence-snapshot";

export interface WebsiteIntelligenceSnapshotJobData {
  tenantId: string;
  projectId: string;
  targetUrl: string;
  snapshotType: "pricing" | "product_catalog" | "case_studies" | "positioning";
  requestedBy: string;
}

const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

export const websiteIntelligenceSnapshotQueue = new Queue<WebsiteIntelligenceSnapshotJobData>(
  WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME,
  { connection },
);

export async function enqueueWebsiteIntelligenceSnapshot(data: WebsiteIntelligenceSnapshotJobData): Promise<void> {
  await websiteIntelligenceSnapshotQueue.add("snapshot", data, {
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}

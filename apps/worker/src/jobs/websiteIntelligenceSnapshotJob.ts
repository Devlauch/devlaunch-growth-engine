import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../queue.js";
import { withTenantContext } from "../db.js";
import { logger } from "../logger.js";
import {
  extractPricingPage,
  extractProductCatalog,
  extractCaseStudies,
  hashExtractedData,
} from "../lib/structuredExtraction.js";

/**
 * Consumer side of the Workstream E website-intelligence snapshot job.
 * Enqueued by apps/api/src/lib/websiteIntelligenceQueue.ts
 * (POST .../website-intelligence/snapshots — see
 * apps/api/src/routes/websiteIntelligence.ts); this is the real,
 * asynchronous extraction work that route deliberately does NOT do
 * synchronously (crawling can be slow).
 *
 * Follows the exact same Worker-registration shape as
 * apps/worker/src/reports/reportWorker.ts's `startReportWorker` (own
 * `createRedisConnection()`, own queue name, `completed`/`failed`
 * listeners, a `start*` function returning the `Worker` so
 * apps/worker/src/index.ts can track/close it) — NOT wired into index.ts
 * here (index.ts is hot/modified by another in-flight change this round —
 * see `git status`). To wire it up, add to apps/worker/src/index.ts:
 *
 *   import { startWebsiteIntelligenceSnapshotWorker } from "./jobs/websiteIntelligenceSnapshotJob.js";
 *   ...
 *   const websiteIntelligenceSnapshotWorker = startWebsiteIntelligenceSnapshotWorker();
 *   ...
 *   // in shutdown():
 *   await websiteIntelligenceSnapshotWorker.close();
 *
 * Queue name/job-data shape are duplicated from
 * apps/api/src/lib/websiteIntelligenceQueue.ts rather than added to
 * @devlaunch/agent-sdk (that package's types.ts is also hot this round —
 * see this file's sibling's doc comment for the full reasoning). KEEP IN
 * SYNC: WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME and
 * WebsiteIntelligenceSnapshotJobData must match that file exactly.
 */
export const WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME = "website-intelligence-snapshot";

export interface WebsiteIntelligenceSnapshotJobData {
  tenantId: string;
  projectId: string;
  targetUrl: string;
  snapshotType: "pricing" | "product_catalog" | "case_studies" | "positioning";
  requestedBy: string;
}

async function runExtraction(
  snapshotType: WebsiteIntelligenceSnapshotJobData["snapshotType"],
  targetUrl: string,
): Promise<{ ok: boolean; data: unknown; evidence: unknown[]; fetchError?: string }> {
  switch (snapshotType) {
    case "pricing":
      return extractPricingPage(targetUrl);
    case "product_catalog":
      return extractProductCatalog(targetUrl);
    case "case_studies":
      return extractCaseStudies(targetUrl);
    case "positioning":
      // Positioning snapshots reuse the pricing-signal-shaped text scan
      // (same honesty contract: real sentences, never fabricated) by
      // running the pricing extractor and the case-study extractor
      // together and keeping whichever found content — "positioning" is
      // intentionally the broadest snapshot_type, not a fourth distinct
      // parser.
      {
        const pricing = await extractPricingPage(targetUrl);
        if (pricing.ok) return pricing;
        const caseStudies = await extractCaseStudies(targetUrl);
        if (caseStudies.ok) return caseStudies;
        return {
          ok: false,
          data: {},
          evidence: [],
          fetchError: pricing.fetchError ?? caseStudies.fetchError ?? "No positioning signal found.",
        };
      }
    default:
      return { ok: false, data: {}, evidence: [], fetchError: `Unknown snapshotType: ${String(snapshotType)}` };
  }
}

export async function processWebsiteIntelligenceSnapshot(job: Job<WebsiteIntelligenceSnapshotJobData>): Promise<void> {
  const { tenantId, projectId, targetUrl, snapshotType } = job.data;
  const log = logger.child({ tenantId, projectId, targetUrl, snapshotType, jobId: job.id });
  log.info("website-intelligence snapshot started");

  const extraction = await runExtraction(snapshotType, targetUrl);
  // Honesty contract: even a failed extraction gets a real row — storing
  // {error: "..."} in extracted_data, never a fabricated plan/product/case
  // study standing in for the real failure. content_hash still hashes
  // whatever was actually produced (including the honest error shape), so
  // a flapping/unreachable page doesn't silently look "unchanged" forever.
  const extractedData = extraction.ok ? extraction.data : { error: extraction.fetchError ?? "extraction failed" };
  const contentHash = hashExtractedData(extractedData);

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO website_intelligence_snapshots
         (tenant_id, project_id, target_url, snapshot_type, extracted_data, source_evidence, content_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        tenantId,
        projectId,
        targetUrl,
        snapshotType,
        JSON.stringify(extractedData),
        JSON.stringify(extraction.evidence),
        contentHash,
      ],
    );
  });

  if (extraction.ok) {
    log.info("website-intelligence snapshot succeeded");
  } else {
    log.warn({ fetchError: extraction.fetchError }, "website-intelligence snapshot recorded an honest extraction failure");
  }
}

export function startWebsiteIntelligenceSnapshotWorker(): Worker<WebsiteIntelligenceSnapshotJobData> {
  const connection = createRedisConnection();
  const worker = new Worker<WebsiteIntelligenceSnapshotJobData>(
    WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME,
    processWebsiteIntelligenceSnapshot,
    { connection, concurrency: Number(process.env.WEBSITE_INTELLIGENCE_WORKER_CONCURRENCY ?? 2) },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "website-intelligence snapshot job completed");
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "website-intelligence snapshot job failed");
  });

  logger.info({ queue: WEBSITE_INTELLIGENCE_SNAPSHOT_QUEUE_NAME }, "website-intelligence snapshot worker started, waiting for jobs");
  return worker;
}

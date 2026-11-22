import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REPORT_GENERATION_QUEUE_NAME, type ReportGenerationJobData } from "@devlaunch/agent-sdk";
import { env } from "../config/env.js";

const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

export const reportGenerationQueue = new Queue<ReportGenerationJobData>(REPORT_GENERATION_QUEUE_NAME, { connection });

export async function enqueueReportGeneration(data: ReportGenerationJobData): Promise<void> {
  await reportGenerationQueue.add("generate", data, {
    jobId: data.reportId,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}

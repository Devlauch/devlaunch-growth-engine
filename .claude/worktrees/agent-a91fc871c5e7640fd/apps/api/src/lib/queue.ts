import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { AGENT_RUN_QUEUE_NAME, type AgentRunJobData } from "@devlaunch/agent-sdk";
import { env } from "../config/env.js";

const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

export const agentRunQueue = new Queue<AgentRunJobData>(AGENT_RUN_QUEUE_NAME, { connection });

export async function enqueueAgentRun(data: AgentRunJobData): Promise<void> {
  await agentRunQueue.add("run", data, {
    jobId: data.executionId,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}

import { Redis } from "ioredis";

export { AGENT_RUN_QUEUE_NAME, type AgentRunJobData } from "@devlaunch/agent-sdk";

export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  // BullMQ requires maxRetriesPerRequest: null on the connection it's given.
  return new Redis(url, { maxRetriesPerRequest: null });
}

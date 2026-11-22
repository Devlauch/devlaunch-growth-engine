import type pg from "pg";
import { Errors } from "./httpError.js";
import { PLAN_LIMITS, type PlanLimits, type PlanName } from "../config/planLimits.js";

export type QuotaResource = "projects" | "agentRunsPerDay" | "teamMembers" | "discoverySources";

export const QUOTA_RESOURCES: readonly QuotaResource[] = [
  "projects",
  "agentRunsPerDay",
  "teamMembers",
  "discoverySources",
] as const;

const RESOURCE_LABEL: Record<QuotaResource, string> = {
  projects: "projects",
  agentRunsPerDay: "agent runs per day",
  teamMembers: "team members",
  discoverySources: "discovery sources",
};

const LIMIT_KEY: Record<QuotaResource, keyof PlanLimits> = {
  projects: "maxProjects",
  agentRunsPerDay: "maxAgentRunsPerDay",
  teamMembers: "maxTeamMembers",
  discoverySources: "maxDiscoverySources",
};

/** Reads the tenant's current plan straight off the `tenants` row — the single source of truth (see migration 220). */
export async function getTenantPlan(client: pg.PoolClient, tenantId: string): Promise<PlanName> {
  const result = await client.query("SELECT plan FROM tenants WHERE id = $1", [tenantId]);
  if (result.rowCount === 0) throw Errors.notFound("Tenant not found");
  return result.rows[0].plan as PlanName;
}

/**
 * Real COUNT(*) queries only — never an estimate, never a cached counter —
 * one per resource kind. Each query is scoped by tenant_id and runs
 * against the caller's own tenant-scoped transaction (req.tenantDb), so it
 * is subject to the same RLS policies as every other query in the app.
 */
async function countCurrentUsage(client: pg.PoolClient, tenantId: string, resource: QuotaResource): Promise<number> {
  switch (resource) {
    case "projects": {
      const r = await client.query("SELECT COUNT(*)::int AS count FROM projects WHERE tenant_id = $1", [tenantId]);
      return r.rows[0].count;
    }
    case "agentRunsPerDay": {
      const r = await client.query(
        `SELECT COUNT(*)::int AS count FROM agent_executions
         WHERE tenant_id = $1 AND created_at >= date_trunc('day', now())`,
        [tenantId],
      );
      return r.rows[0].count;
    }
    case "teamMembers": {
      const r = await client.query(
        "SELECT COUNT(*)::int AS count FROM memberships WHERE tenant_id = $1 AND status = 'active'",
        [tenantId],
      );
      return r.rows[0].count;
    }
    case "discoverySources": {
      const r = await client.query(
        "SELECT COUNT(*)::int AS count FROM discovery_sources WHERE tenant_id = $1",
        [tenantId],
      );
      return r.rows[0].count;
    }
    default: {
      const _exhaustive: never = resource;
      throw new Error(`Unknown quota resource: ${String(_exhaustive)}`);
    }
  }
}

export interface QuotaUsage {
  plan: PlanName;
  resource: QuotaResource;
  current: number;
  /** `null` means unlimited for this plan. */
  limit: number | null;
}

/** One resource's current real usage vs. its plan limit. Used by both enforceQuota and the GET /plan usage endpoint. */
export async function getQuotaUsage(
  client: pg.PoolClient,
  tenantId: string,
  resource: QuotaResource,
): Promise<QuotaUsage> {
  const plan = await getTenantPlan(client, tenantId);
  const limit = PLAN_LIMITS[plan][LIMIT_KEY[resource]];
  const current = await countCurrentUsage(client, tenantId, resource);
  return { plan, resource, current, limit };
}

/**
 * Throws Errors.paymentRequired (402) when the tenant is already at or
 * over its plan's limit for `resource`, naming the limit and the current
 * plan in the message. Call this BEFORE the INSERT that would create one
 * more of `resource` — never after.
 */
export async function enforceQuota(client: pg.PoolClient, tenantId: string, resource: QuotaResource): Promise<void> {
  const { plan, current, limit } = await getQuotaUsage(client, tenantId, resource);
  if (limit !== null && current >= limit) {
    throw Errors.paymentRequired(
      `Your "${plan}" plan allows up to ${limit} ${RESOURCE_LABEL[resource]} (currently using ${current}). ` +
        `Upgrade your plan to increase this limit.`,
    );
  }
}

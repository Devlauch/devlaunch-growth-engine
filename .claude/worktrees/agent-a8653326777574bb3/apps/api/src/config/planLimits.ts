/**
 * Subscription plan + quota configuration.
 *
 * This is the PLAN DATA MODEL only — NOT real payment processing. There is
 * no Stripe/payment-provider integration anywhere in this codebase, and
 * none should be invented. Plan changes happen via a manual/admin-only API
 * (see src/routes/planUsage.ts), not a billing flow.
 *
 * Kept as a static, in-code config rather than a `plan_limits` DB table:
 * tuning a limit is a deploy, not a migration, and there's no product
 * requirement yet for a human to edit these through the dashboard. If that
 * changes, this is the one place to replace with a DB-backed table.
 */

export const PLAN_NAMES = ["free", "starter", "growth", "enterprise"] as const;

export type PlanName = (typeof PLAN_NAMES)[number];

export interface PlanLimits {
  /** Max number of projects a tenant may create. */
  maxProjects: number | null;
  /** Max number of agent runs (agent_executions rows) a tenant may create per rolling calendar day. */
  maxAgentRunsPerDay: number | null;
  /** Max number of active team members (memberships) a tenant may have. */
  maxTeamMembers: number | null;
  /** Max number of discovery_sources a tenant may create. */
  maxDiscoverySources: number | null;
}

/** `null` means unlimited (no quota check is enforced for that resource). */
export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: {
    maxProjects: 1,
    maxAgentRunsPerDay: 10,
    maxTeamMembers: 2,
    maxDiscoverySources: 1,
  },
  starter: {
    maxProjects: 3,
    maxAgentRunsPerDay: 50,
    maxTeamMembers: 5,
    maxDiscoverySources: 3,
  },
  growth: {
    maxProjects: 10,
    maxAgentRunsPerDay: 250,
    maxTeamMembers: 20,
    maxDiscoverySources: 10,
  },
  enterprise: {
    maxProjects: null,
    maxAgentRunsPerDay: null,
    maxTeamMembers: null,
    maxDiscoverySources: null,
  },
};

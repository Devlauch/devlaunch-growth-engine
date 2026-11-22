import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { PlanName, PlanUsageResponse, QuotaResource, Tenant } from "../api/types";

const RESOURCE_LABELS: Record<QuotaResource, string> = {
  projects: "Projects",
  agentRunsPerDay: "Agent runs (today)",
  teamMembers: "Team members",
  discoverySources: "Discovery sources",
};

const PLAN_LABELS: Record<PlanName, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

function planTone(plan: PlanName): "neutral" | "info" | "success" {
  switch (plan) {
    case "enterprise":
      return "success";
    case "growth":
    case "starter":
      return "info";
    default:
      return "neutral";
  }
}

/** A real usage-vs-limit bar — never fabricates a percentage for an unlimited (null) limit. */
function QuotaRow({ resource, current, limit }: { resource: QuotaResource; current: number; limit: number | null }) {
  const ratio = limit === null || limit === 0 ? 0 : Math.min(1, current / limit);
  const tone = limit !== null && current >= limit ? "quota-bar-danger" : ratio >= 0.8 ? "quota-bar-warn" : "";

  return (
    <div className="quota-row">
      <div className="quota-row-head">
        <span className="quota-row-label">{RESOURCE_LABELS[resource]}</span>
        <span className="quota-row-count">
          {limit === null ? `${current} used (unlimited)` : `${current} of ${limit} used`}
        </span>
      </div>
      <div className="quota-bar-track">
        <div
          className={`quota-bar-fill ${tone}`}
          style={{ width: limit === null ? "0%" : `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function PlanUsagePage() {
  const { tenantId } = useParams<{ tenantId: string }>();

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [planUsage, setPlanUsage] = useState<PlanUsageResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [tenantRes, planRes] = await Promise.all([
        api.get<{ tenant: Tenant; role: string }>(`/tenants/${tenantId}`),
        api.get<PlanUsageResponse>(`/tenants/${tenantId}/plan`),
      ]);
      setTenant(tenantRes.tenant);
      setPlanUsage(planRes);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load plan and usage for this organization.");
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const resources: QuotaResource[] = ["projects", "agentRunsPerDay", "teamMembers", "discoverySources"];

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: tenant?.name ?? "...", to: `/tenants/${tenantId}` },
        { label: "Plan & Usage" },
      ]}
      tenantName={tenant?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Plan &amp; Usage</h1>
        <p className="callout">
          Your current subscription plan and real usage against each of its limits. Every number below comes
          straight from a live count against this organization's own data — nothing here is estimated or
          fabricated.
        </p>

        {planUsage === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <>
            <div className="plan-badge-row">
              <Badge tone={planTone(planUsage.plan)}>{PLAN_LABELS[planUsage.plan]} plan</Badge>
            </div>

            <div className="quota-list">
              {resources.map((resource) => (
                <QuotaRow
                  key={resource}
                  resource={resource}
                  current={planUsage.usage[resource].current}
                  limit={planUsage.usage[resource].limit}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Need more room?</h2>
        <p className="callout">
          There is no self-serve billing in this product yet — upgrading or downgrading a plan today is a manual,
          admin-side action (not an automated payment/checkout flow). Reach out and we'll get it sorted.
        </p>
        <a
          className="btn btn-primary"
          href="mailto:sales@devlaunch.example?subject=Upgrade%20my%20plan"
        >
          Upgrade (contact sales — no self-serve billing yet)
        </a>
      </section>
    </Layout>
  );
}

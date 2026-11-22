import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { LeadsTimeSeries } from "../components/charts/LeadsTimeSeries";
import { IconKey, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Tenant, UsageEventType, UsageOverview } from "../api/types";

// Real usage only. Every number on this page comes straight from
// GET .../usage/overview (apps/api/src/routes/usage.ts), itself a direct
// SQL aggregate over usage_events — nothing here is estimated, sampled,
// or invented. AI token usage in particular is shown only when a real
// token count exists; today no agent in this codebase reports one, so
// that section renders the real EmptyState instead of a guessed number.
export function UsagePage() {
  const { tenantId } = useParams<{ tenantId: string }>();

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [tenantRes, usageRes] = await Promise.all([
        api.get<{ tenant: Tenant }>(`/tenants/${tenantId}`),
        api.get<UsageOverview>(`/tenants/${tenantId}/usage/overview`),
      ]);
      setTenant(tenantRes.tenant);
      setOverview(usageRes);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load usage for this organization.");
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  function perDayFor(eventType: UsageEventType) {
    if (!overview) return [];
    return overview.perDay.filter((d) => d.eventType === eventType).map((d) => ({ day: d.day, count: d.quantity }));
  }

  const hasAnyData = overview
    ? Object.values(overview.summary).some((entry) => entry.count > 0)
    : false;
  const hasTokenData = (overview?.summary.ai_tokens.count ?? 0) > 0;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: tenant?.name ?? "...", to: `/tenants/${tenantId}` },
        { label: "Usage" },
      ]}
      tenantName={tenant?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Usage</h1>
        <p className="muted">
          Real counts computed directly from this organization's agent runs, API request volume, and captured leads —
          nothing on this page is estimated or fabricated. AI token usage is shown only once a real token count
          exists for an agent run.
        </p>
      </section>

      {overview === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : !hasAnyData ? (
        <section className="panel">
          <EmptyState title="No usage recorded yet" hint="Usage will appear here once there's real activity in this organization." />
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconZap />} label="Agent runs" value={overview.summary.agent_run.count} />
            <StatCard icon={<IconKey />} label="API requests" value={overview.summary.api_request.quantity} />
            <StatCard icon={<IconUsers />} label="Leads captured" value={overview.summary.lead_captured.count} />
            <StatCard
              icon={<IconTarget />}
              label="AI tokens"
              value={hasTokenData ? overview.summary.ai_tokens.quantity : "—"}
              hint={hasTokenData ? undefined : "No real token counts recorded yet"}
            />
          </StatGrid>

          <section className="panel">
            <h2>Agent runs over time</h2>
            <LeadsTimeSeries data={perDayFor("agent_run")} />
          </section>

          <section className="panel">
            <h2>API requests over time</h2>
            <LeadsTimeSeries data={perDayFor("api_request")} />
          </section>

          <section className="panel">
            <h2>Leads captured over time</h2>
            <LeadsTimeSeries data={perDayFor("lead_captured")} />
          </section>

          <section className="panel">
            <h2>AI tokens over time</h2>
            {hasTokenData ? (
              <LeadsTimeSeries data={perDayFor("ai_tokens")} />
            ) : (
              <EmptyState
                title="No AI token usage recorded"
                hint="This will populate once an agent reports a real token count — no agent in this codebase does yet."
              />
            )}
          </section>
        </>
      )}
    </Layout>
  );
}

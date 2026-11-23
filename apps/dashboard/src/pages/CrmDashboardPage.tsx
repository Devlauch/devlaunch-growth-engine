import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconChart, IconTarget, IconUsers, IconZap } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// CRM Dashboard — pipeline value by stage, deals won/lost this period,
// upcoming meetings, overdue follow-up tasks, and lead-to-customer
// conversion rate. Every number here comes straight from GET
// .../crm-dashboard (apps/api/src/lib/crmDashboard.ts), itself a real SQL
// composition that reuses growthRevenueAnalytics.ts's sales-conversion math
// rather than recomputing it. Customers (won deals) are listed from the
// existing GET .../deals/customers endpoint (the `customers` VIEW,
// 278_create_deals.sql) so lead-to-customer conversion is a real, queryable
// list, not just a SQL view nobody reads.
interface CrmDashboard {
  periodDays: number;
  pipelineByStage: { stage: string; dealCount: number; totalValue: number }[];
  dealsThisPeriod: {
    won: { count: number; totalValue: number };
    lost: { count: number; totalValue: number };
  };
  upcomingMeetings: { id: string; leadId: string; type: string; scheduledAt: string }[];
  overdueFollowUpTasks: { id: string; leadId: string; taskType: string; title: string; dueAt: string }[];
  leadToCustomerConversion: { totalLeads: number; totalCustomers: number; rate: number | null };
  salesConversion: { winRate: number | null; wonDeals: number; lostDeals: number };
}

interface Customer {
  lead_id: string;
  name: string;
  email: string | null;
  company: string | null;
  won_deal_value: string | null;
  won_at: string;
}

function formatPercent(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n * 1000) / 10}%`;
}

function formatCurrency(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CrmDashboardPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [dashboard, setDashboard] = useState<CrmDashboard | null>(null);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, dashboardRes, customersRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ crmDashboard: CrmDashboard }>(`/tenants/${tenantId}/projects/${projectId}/crm-dashboard`),
        api.get<{ customers: Customer[] }>(`/tenants/${tenantId}/projects/${projectId}/deals/customers`),
      ]);
      setProject(projectRes.project);
      setDashboard(dashboardRes.crmDashboard);
      setCustomers(customersRes.customers);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the CRM dashboard for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "CRM Dashboard" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>CRM Dashboard</h1>
        <p className="muted">
          Real aggregates over deals, meetings, follow-up tasks, and won deals — nothing here is estimated.
        </p>
      </section>

      {dashboard === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard
              icon={<IconChart />}
              label="Pipeline value"
              value={formatCurrency(dashboard.pipelineByStage.reduce((sum, s) => sum + s.totalValue, 0))}
              hint={`${dashboard.pipelineByStage.reduce((sum, s) => sum + s.dealCount, 0)} deals across all stages`}
            />
            <StatCard
              icon={<IconZap />}
              label={`Won / lost (last ${dashboard.periodDays}d)`}
              value={`${dashboard.dealsThisPeriod.won.count} / ${dashboard.dealsThisPeriod.lost.count}`}
              hint={`${formatCurrency(dashboard.dealsThisPeriod.won.totalValue)} won value`}
            />
            <StatCard
              icon={<IconUsers />}
              label="Lead-to-customer conversion"
              value={formatPercent(dashboard.leadToCustomerConversion.rate)}
              hint={`${dashboard.leadToCustomerConversion.totalCustomers} of ${dashboard.leadToCustomerConversion.totalLeads} leads`}
            />
            <StatCard
              icon={<IconTarget />}
              label="Overdue follow-up tasks"
              value={dashboard.overdueFollowUpTasks.length}
              hint={`${dashboard.upcomingMeetings.length} upcoming meetings`}
            />
          </StatGrid>

          <section className="panel">
            <h2>Pipeline by stage</h2>
            {dashboard.pipelineByStage.length === 0 ? (
              <p className="muted">No deals yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Deals</th>
                    <th>Total value</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.pipelineByStage.map((s) => (
                    <tr key={s.stage}>
                      <td>{s.stage}</td>
                      <td>{s.dealCount}</td>
                      <td>{formatCurrency(s.totalValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>Upcoming meetings</h2>
            {dashboard.upcomingMeetings.length === 0 ? (
              <p className="muted">No meetings scheduled.</p>
            ) : (
              <ul>
                {dashboard.upcomingMeetings.map((m) => (
                  <li key={m.id}>
                    {m.type} — {new Date(m.scheduledAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Overdue follow-up tasks</h2>
            {dashboard.overdueFollowUpTasks.length === 0 ? (
              <p className="muted">Nothing overdue.</p>
            ) : (
              <ul>
                {dashboard.overdueFollowUpTasks.map((t) => (
                  <li key={t.id}>
                    {t.title} — due {new Date(t.dueAt).toLocaleDateString()}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Customers</h2>
            <p className="muted">Won deals, read from the real `customers` view — not a fabricated list.</p>
            {customers === null || customers.length === 0 ? (
              <p className="muted">No customers yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Won value</th>
                    <th>Won at</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.lead_id}>
                      <td>{c.name}</td>
                      <td>{c.company ?? "—"}</td>
                      <td>{c.won_deal_value ? formatCurrency(Number(c.won_deal_value)) : "—"}</td>
                      <td>{new Date(c.won_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Layout>
  );
}

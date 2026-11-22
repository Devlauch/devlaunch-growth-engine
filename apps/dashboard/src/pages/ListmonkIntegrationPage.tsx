import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Milestone 2, Agent B (Listmonk). Shapes below mirror
// apps/api/src/routes/listmonkIntegration.ts's real response bodies
// exactly — nothing fabricated. Kept local to this file (same convention
// as ChatbotConfigPage.tsx) to avoid colliding with other integration
// agents' concurrent edits to api/types.ts.

interface ListmonkIntegrationRow {
  id: string;
  status: "not_connected" | "pending_setup" | "connected" | "error";
  created_at: string;
  updated_at: string;
}

interface ListmonkCampaignRow {
  campaign_id: string;
  listmonk_campaign_id: number;
  listmonk_status: string;
  name: string;
  platform_status: string;
}

interface ListmonkStatusResponse {
  integration: ListmonkIntegrationRow | null;
  list: { listmonk_list_id: number; name: string } | null;
  subscriberCounts: Record<string, number>;
  campaigns: ListmonkCampaignRow[];
}

function statusTone(status: string): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "connected":
      return "success";
    case "pending_setup":
      return "info";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function ListmonkIntegrationPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();
  const base = `/tenants/${tenantId}/projects/${projectId}/integrations/listmonk`;

  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<ListmonkStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [projectRes, statusRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<ListmonkStatusResponse>(base),
      ]);
      setProject(projectRes.project);
      setStatus(statusRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load listmonk integration status");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const res = await api.post<{ result: { total: number; synced: number; skippedSuppressed: number; failed: number } }>(
        `${base}/sync-subscribers`,
      );
      const r = res.result;
      setSyncResult(`Synced ${r.synced}/${r.total} leads (${r.skippedSuppressed} suppressed, ${r.failed} failed).`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Subscriber sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleHealthCheck() {
    setError(null);
    try {
      // The generic health-check route (apps/api/src/routes/integrations.ts,
      // not edited by this change — see docs/INTEGRATION_STATUS.md section
      // 6) delegates to listmonkClient.ts's checkHealth() export.
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/listmonk/health-check`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Health check failed");
    }
  }

  const hasIntegrationRow = Boolean(status?.integration);

  return (
    <Layout
      crumbs={project ? [{ label: project.name }, { label: "Integrations" }, { label: "Listmonk" }] : [{ label: "Listmonk" }]}
      projectName={project?.name}
    >
      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <section className="card">
            <div className="card-header">
              <h2>Connection</h2>
              {status?.integration ? <Badge tone={statusTone(status.integration.status)}>{status.integration.status}</Badge> : <Badge tone="neutral">not_connected</Badge>}
            </div>
            <p className="muted">
              Listmonk runs as a fully independent service (own container, own database — never forked, called
              only via its documented REST API). Start one with{" "}
              <code>docker compose -f docker-compose.yml -f docker-compose.listmonk.yml --profile listmonk up -d</code>, then
              connect it (baseUrl/apiUser in config, the API key as secret, and optionally SendGrid/Postmark webhook
              verification material folded into that same secret as JSON — see
              apps/api/src/lib/listmonkClient.ts's <code>parseListmonkCredential</code>) from the shared{" "}
              <Link to={`/tenants/${tenantId}/projects/${projectId}/integrations`}>Integrations page</Link>.
            </p>
            {hasIntegrationRow ? (
              <button type="button" onClick={handleHealthCheck} className="secondary">
                Run health check
              </button>
            ) : null}
          </section>

          {hasIntegrationRow ? (
            <>
              <section className="card">
                <div className="card-header">
                  <h2>Subscribers</h2>
                </div>
                {status?.list ? <p className="muted">Mapped list: {status.list.name} (listmonk id {status.list.listmonk_list_id})</p> : null}
                <ul className="stat-list">
                  <li>Synced: {status?.subscriberCounts.synced ?? 0}</li>
                  <li>Suppressed (never synced): {status?.subscriberCounts.skipped_suppressed ?? 0}</li>
                  <li>Failed: {status?.subscriberCounts.failed ?? 0}</li>
                </ul>
                <button type="button" onClick={handleSync} disabled={syncing}>
                  {syncing ? "Syncing…" : "Sync subscribers now"}
                </button>
                {syncResult ? <p className="muted">{syncResult}</p> : null}
              </section>

              <section className="card">
                <div className="card-header">
                  <h2>Campaigns</h2>
                </div>
                {status?.campaigns.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Platform status</th>
                        <th>Listmonk status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.campaigns.map((c) => (
                        <tr key={c.campaign_id}>
                          <td>{c.name}</td>
                          <td>
                            <Badge tone={c.platform_status === "approved" ? "success" : c.platform_status === "rejected" ? "danger" : "warn"}>
                              {c.platform_status}
                            </Badge>
                          </td>
                          <td>{c.listmonk_status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="No listmonk campaigns yet" hint="A new campaign requires approval via the existing Approvals queue before it can send." />
                )}
              </section>
            </>
          ) : null}
        </>
      )}
    </Layout>
  );
}

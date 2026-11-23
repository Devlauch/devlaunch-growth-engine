import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type {
  IntegrationEntry,
  IntegrationStatus,
  IntegrationConnectResponse,
  IntegrationHealthCheckResponse,
  Project,
} from "../api/types";

function statusToneFor(status: IntegrationStatus | "integration_not_yet_implemented"): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "connected":
      return "success";
    case "pending_setup":
      return "warn";
    case "error":
      return "danger";
    case "integration_not_yet_implemented":
      return "info";
    default:
      return "neutral";
  }
}

function statusLabelFor(status: IntegrationStatus | "integration_not_yet_implemented"): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "pending_setup":
      return "Pending setup";
    case "error":
      return "Error";
    case "integration_not_yet_implemented":
      return "Not yet implemented";
    default:
      return "Not connected";
  }
}

// This page lists the provider registry (apps/api/src/routes/integrations.ts).
// Milestone 2: listmonk, chatwoot, and postiz support a real per-tenant
// connection — a config (non-secret settings, e.g. baseUrl/inboxId) plus an
// optional secret (API key/token) that's encrypted at rest before storage,
// and a real "Check health" action. Every other provider (twenty, mautic,
// posthog, formbricks) remains registry-only: connecting them just records
// config/credential the same way, but there is no real external service on
// the other end, and health-check always reports "not yet implemented" for
// them (there is no client module for them by design, not by omission).
export function IntegrationsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState("{}");
  const [secretDraft, setSecretDraft] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [healthCheckingProvider, setHealthCheckingProvider] = useState<string | null>(null);
  const [healthResults, setHealthResults] = useState<Record<string, IntegrationHealthCheckResponse>>({});
  const [healthError, setHealthError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, integrationsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ integrations: IntegrationEntry[]; note: string }>(
          `/tenants/${tenantId}/projects/${projectId}/integrations`,
        ),
      ]);
      setProject(projectRes.project);
      setIntegrations(integrationsRes.integrations);
      setNote(integrationsRes.note);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load integrations for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleConnect(e: FormEvent, provider: string) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setConnectError(null);

    let config: Record<string, unknown>;
    try {
      config = configDraft.trim() === "" ? {} : (JSON.parse(configDraft) as Record<string, unknown>);
    } catch {
      setConnectError("Config must be valid JSON (e.g. {\"baseUrl\": \"https://...\"}), or leave it as {}.");
      return;
    }

    setConnecting(true);
    try {
      await api.post<IntegrationConnectResponse>(`/tenants/${tenantId}/projects/${projectId}/integrations/${provider}/connect`, {
        config,
        ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
      });
      setConfigDraft("{}");
      setSecretDraft("");
      setConnectingProvider(null);
      await load();
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : "Could not save this integration.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleHealthCheck(provider: string) {
    if (!tenantId || !projectId) return;
    setHealthError(null);
    setHealthCheckingProvider(provider);
    try {
      const res = await api.post<IntegrationHealthCheckResponse>(
        `/tenants/${tenantId}/projects/${projectId}/integrations/${provider}/health-check`,
      );
      setHealthResults((prev) => ({ ...prev, [provider]: res }));
      await load();
    } catch (err) {
      setHealthError(err instanceof ApiError ? err.message : "Could not run the health-check.");
    } finally {
      setHealthCheckingProvider(null);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Integrations" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Integrations</h1>
        <p className="callout">
          Listmonk, Chatwoot, and Postiz support a real per-tenant connection: non-secret settings (e.g. baseUrl,
          inboxId) plus an optional secret (API key/token) that's encrypted at rest before it's stored. Every other
          provider below remains registry-only — there is no real external service behind it yet, even though
          connecting it works the same way.
        </p>
        {note ? <p className="muted">{note}</p> : null}

        {integrations === null ? (
          <p className="muted">Loading...</p>
        ) : integrations.length === 0 ? (
          <EmptyState title="No providers configured" />
        ) : (
          <ul className="card-list card-list-static">
            {integrations.map((integration) => {
              const health = healthResults[integration.provider];
              return (
                <li key={integration.provider} className="card-list-item card-list-item-static">
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div>
                        <strong>{integration.label}</strong>
                        <span className="muted"> · {integration.category.replace("_", " ")}</span>
                        {integration.real ? null : <span className="muted"> · registry only</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Badge tone={statusToneFor(health?.status ?? integration.status)}>
                          {statusLabelFor(health?.status ?? integration.status)}
                        </Badge>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={() => {
                            setConnectingProvider(integration.provider);
                            setConnectError(null);
                            setConfigDraft(JSON.stringify(integration.config ?? {}, null, 2));
                            setSecretDraft("");
                          }}
                        >
                          {integration.status === "not_connected" ? "Connect" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={healthCheckingProvider === integration.provider || integration.status === "not_connected"}
                          onClick={() => handleHealthCheck(integration.provider)}
                        >
                          {healthCheckingProvider === integration.provider ? "Checking..." : "Check health"}
                        </button>
                      </div>
                    </div>
                    {integration.hasSecret ? (
                      <span className="muted hint">A secret is on file (not shown).</span>
                    ) : null}
                    {health ? (
                      <span className="muted hint">
                        Last health-check: {statusLabelFor(health.status)}
                        {health.detail ? ` — ${health.detail}` : ""}
                        {health.note ? ` — ${health.note}` : ""}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <ErrorBanner message={healthError} />

        {connectingProvider ? (
          <form className="form" onSubmit={(e) => handleConnect(e, connectingProvider)}>
            <ErrorBanner message={connectError} />
            <p className="muted">
              Config is non-secret settings as JSON (e.g. <code>{"{\"baseUrl\": \"https://chat.example.com\"}"}</code>
              ). Secret is the real API key/token for {connectingProvider} — it's encrypted before being stored and
              never shown back to you. Leave secret blank to update config only and keep the existing credential.
            </p>
            <label className="field">
              <span>Config (JSON)</span>
              <textarea
                rows={4}
                value={configDraft}
                onChange={(e) => setConfigDraft(e.target.value)}
                placeholder='{"baseUrl": "https://..."}'
              />
            </label>
            <label className="field">
              <span>Secret (API key / token)</span>
              <input
                type="password"
                value={secretDraft}
                onChange={(e) => setSecretDraft(e.target.value)}
                placeholder="Leave blank to keep the existing credential"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={connecting}>
                {connecting ? "Saving..." : "Save"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConnectingProvider(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </Layout>
  );
}

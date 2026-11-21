import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { IntegrationEntry, IntegrationStatus, Project } from "../api/types";

function statusToneFor(status: IntegrationStatus): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (status) {
    case "connected":
      return "success";
    case "pending_setup":
      return "warn";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function statusLabelFor(status: IntegrationStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "pending_setup":
      return "Pending setup (placeholder)";
    case "error":
      return "Error";
    default:
      return "Not connected";
  }
}

// This page lists the provider registry (apps/api/src/routes/integrations.ts)
// and lets a user record a placeholder "pending setup" label for a provider.
// There is NO real OAuth/API connection to any of these providers in this
// phase — the UI makes this explicit everywhere rather than hiding it, per
// the product spec's ground rules.
export function IntegrationsPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

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
    setConnecting(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/integrations/${provider}/connect`, {
        placeholderLabel: labelDraft,
      });
      setLabelDraft("");
      setConnectingProvider(null);
      await load();
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : "Could not record this placeholder setup.");
    } finally {
      setConnecting(false);
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
          No provider below has a real, working connection yet — sending integration not yet connected. This page is
          a registry of the providers this platform plans to support; "Record placeholder setup" only stores a label
          you type in and marks the row "pending setup." It does not contact the provider, does not store a real API
          key or secret, and does not enable any real send/sync.
        </p>
        {note ? <p className="muted">{note}</p> : null}

        {integrations === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <ul className="card-list card-list-static">
            {integrations.map((integration) => (
              <li key={integration.provider} className="card-list-item card-list-item-static">
                <div>
                  <strong>{integration.label}</strong>
                  <span className="muted"> · {integration.category.replace("_", " ")}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={statusToneFor(integration.status)}>{statusLabelFor(integration.status)}</Badge>
                  {integration.status === "not_connected" || integration.status === "error" ? (
                    connectingProvider === integration.provider ? null : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => {
                          setConnectingProvider(integration.provider);
                          setConnectError(null);
                          setLabelDraft("");
                        }}
                      >
                        Record placeholder setup
                      </button>
                    )
                  ) : (
                    <span className="muted hint">Sending integration not yet connected</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {connectingProvider ? (
          <form className="form" onSubmit={(e) => handleConnect(e, connectingProvider)}>
            <ErrorBanner message={connectError} />
            <p className="muted">
              This is a placeholder only — type any label to identify the instance (e.g. an internal name). It is not
              a real API key or secret, and nothing is actually sent to {connectingProvider}.
            </p>
            <label className="field">
              <span>Placeholder label</span>
              <input
                required
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder="e.g. acme-prod-instance"
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={connecting}>
                {connecting ? "Saving..." : "Record placeholder setup"}
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

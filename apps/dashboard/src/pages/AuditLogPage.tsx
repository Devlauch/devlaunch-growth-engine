import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { api, ApiError } from "../api/client";
import type { AuditEvent, Tenant } from "../api/types";

const PAGE_SIZE = 50;

/**
 * Real audit trail viewer: GET /tenants/:tenantId/audit-events, which only
 * ever returns rows genuinely written by a mutating route (see
 * apps/api/src/routes/auditEvents.ts). Paginated, filterable by action and
 * entity_type — both free-text (exact match), since the set of real
 * actions/entity types grows as routes add audit_events writes and this
 * page should never need a hardcoded enum to stay in sync with them.
 */
export function AuditLogPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("");

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      if (entityTypeFilter.trim()) params.set("entityType", entityTypeFilter.trim());

      const res = await api.get<{ auditEvents: AuditEvent[] }>(
        `/tenants/${tenantId}/audit-events?${params.toString()}`,
      );
      setEvents(res.auditEvents);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the audit log.");
    }
  }, [tenantId, offset, actionFilter, entityTypeFilter]);

  useEffect(() => {
    if (!tenantId) return;
    api
      .get<{ tenant: Tenant }>(`/tenants/${tenantId}`)
      .then((res) => setTenant(res.tenant))
      .catch(() => undefined);
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    load();
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: tenant?.name ?? "...", to: `/tenants/${tenantId}` },
        { label: "Audit Log" },
      ]}
      tenantName={tenant?.name}
    >
      <section className="panel">
        <h1>Audit Log</h1>
        <p className="muted">Every notable action recorded for this organization, newest first.</p>

        <ErrorBanner message={loadError} />

        <form onSubmit={applyFilters} className="form form-inline">
          <label className="field">
            <span>Action</span>
            <input
              type="text"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder="e.g. campaign.created"
            />
          </label>
          <label className="field">
            <span>Entity type</span>
            <input
              type="text"
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value)}
              placeholder="e.g. campaign"
            />
          </label>
          <button type="submit" className="btn btn-secondary">
            Filter
          </button>
        </form>

        {events === null ? (
          <p className="muted">Loading...</p>
        ) : events.length === 0 ? (
          <EmptyState title="No audit events found" hint="Try clearing your filters, or check back after some activity." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>{new Date(ev.created_at).toLocaleString()}</td>
                  <td>{ev.actor_type}{ev.actor_user_id ? ` · ${ev.actor_user_id}` : ""}</td>
                  <td>{ev.action}</td>
                  <td>{ev.entity_type}{ev.entity_id ? ` · ${ev.entity_id}` : ""}</td>
                  <td className="muted">{Object.keys(ev.metadata ?? {}).length > 0 ? JSON.stringify(ev.metadata) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="form-inline" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={(events?.length ?? 0) < PAGE_SIZE}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      </section>
    </Layout>
  );
}

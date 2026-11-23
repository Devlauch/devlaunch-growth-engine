import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { api, ApiError } from "../api/client";
import type { Project, Tenant } from "../api/types";
import { StatCard, StatGrid } from "../components/StatCard";
import { StatusBarChart } from "../components/charts/StatusBarChart";
import { IconCheck, IconLayers } from "../components/Icons";
import { colorForProjectStatus } from "../lib/chartColors";
import { setLastActiveTenantId } from "../lib/lastActiveTenant";

interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  to?: string;
  actionLabel?: string;
}

function SetupChecklist({ tenantId, projects }: { tenantId: string; projects: Project[] }) {
  const widgetEnabled = projects.some((p) => p.public_widget_enabled);
  const firstProject = projects[0];

  // "Connect a lead source" / "Invite your team" have no cheap, honest way
  // to compute "done" from data this page already has without a fabricated
  // guess — shown as real next steps (not a made-up completion state).
  const steps: SetupStep[] = [
    { key: "workspace", label: "Create workspace", done: true },
    {
      key: "widget",
      label: "Install the lead widget",
      done: widgetEnabled,
      to: firstProject ? `/tenants/${tenantId}/projects/${firstProject.id}/widget-settings` : undefined,
      actionLabel: "Install widget",
    },
    {
      key: "lead-source",
      label: "Connect a lead source",
      done: false,
      to: firstProject ? `/tenants/${tenantId}/projects/${firstProject.id}/discovery` : undefined,
      actionLabel: "Connect source",
    },
    {
      key: "team",
      label: "Invite your team",
      done: false,
      to: `/tenants/${tenantId}/branding`,
      actionLabel: "Invite teammates",
    },
  ];

  return (
    <section className="panel">
      <h2>Get set up</h2>
      <ul className="setup-checklist">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? "setup-checklist-done" : ""}>
            <span className="setup-checklist-icon">{s.done ? <IconCheck width={14} height={14} /> : null}</span>
            <span className="setup-checklist-label">{s.label}</span>
            {!s.done && s.to ? (
              <Link className="btn-link" to={s.to}>
                {s.actionLabel}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function TenantPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [tenantRes, projectsRes] = await Promise.all([
        api.get<{ tenant: Tenant }>(`/tenants/${tenantId}`),
        api.get<{ projects: Project[] }>(`/tenants/${tenantId}/projects`),
      ]);
      setTenant(tenantRes.tenant);
      setProjects(projectsRes.projects);
      setLastActiveTenantId(tenantId);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this organization.");
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setCreateError(null);
    setCreating(true);
    try {
      const res = await api.post<{ project: Project }>(`/tenants/${tenantId}/projects`, { name, slug });
      setName("");
      setSlug("");
      setSlugTouched(false);
      await load();
      navigate(`/tenants/${tenantId}/projects/${res.project.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create project.");
    } finally {
      setCreating(false);
    }
  }

  const projectStatusCounts = (projects ?? []).reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Layout crumbs={[{ label: tenant?.name ?? "..." }]} tenantName={tenant?.name}>
      <ErrorBanner message={loadError} />

      {tenant ? (
        <section className="panel welcome-panel">
          <h1>Welcome, {tenant.name}</h1>
          <p className="muted">
            {projects && projects.length > 0 && projects.some((p) => p.public_widget_enabled)
              ? "Here's how your workspace is doing."
              : "Let's get your workspace collecting real leads."}
          </p>
        </section>
      ) : null}

      {tenantId && projects ? <SetupChecklist tenantId={tenantId} projects={projects} /> : null}

      <StatGrid>
        <StatCard icon={<IconLayers />} label="Total projects" value={projects === null ? "…" : projects.length} />
      </StatGrid>

      {projects && projects.length > 0 ? (
        <div className="chart-grid">
          <StatusBarChart
            title="Projects by status"
            segments={Object.entries(projectStatusCounts).map(([status, value]) => ({
              key: status,
              label: status,
              value,
              color: colorForProjectStatus(status),
            }))}
          />
        </div>
      ) : null}

      <section className="panel">
        <h1>{tenant?.name ?? "Organization"}</h1>
        <p className="muted">
          A project is a single website/product you want to generate and grow leads for. Create one to get its
          lead-capture embed snippet.
        </p>

        {projects === null ? (
          <p className="muted">Loading...</p>
        ) : projects.length === 0 ? (
          <EmptyState title="No projects yet" hint="Create your first project below." />
        ) : (
          <ul className="card-list">
            {projects.map((p) => (
              <li
                key={p.id}
                className="card-list-item"
                onClick={() => navigate(`/tenants/${tenantId}/projects/${p.id}`)}
              >
                <div>
                  <strong>{p.name}</strong>
                  <span className="muted"> /{p.slug}</span>
                </div>
                <span className="muted">{p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Create a new project</h2>
        <ErrorBanner message={createError} />
        <form onSubmit={handleCreate} className="form form-inline">
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="My Website"
            />
          </label>
          <label className="field">
            <span>Slug</span>
            <input
              type="text"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="my-website"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? "Creating..." : "Create project"}
          </button>
        </form>
      </section>
    </Layout>
  );
}

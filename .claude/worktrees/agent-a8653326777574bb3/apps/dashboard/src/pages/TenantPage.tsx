import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { api, ApiError } from "../api/client";
import type { Project, Tenant } from "../api/types";
import { StatCard, StatGrid } from "../components/StatCard";
import { StatusBarChart } from "../components/charts/StatusBarChart";
import { IconLayers } from "../components/Icons";
import { colorForProjectStatus } from "../lib/chartColors";

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
    <Layout crumbs={[{ label: "Organizations", to: "/" }, { label: tenant?.name ?? "..." }]} tenantName={tenant?.name}>
      <ErrorBanner message={loadError} />

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

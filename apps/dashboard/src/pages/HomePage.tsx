import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { api, ApiError } from "../api/client";
import type { Tenant } from "../api/types";
import { StatCard, StatGrid } from "../components/StatCard";
import { SkeletonStatGrid, SkeletonText } from "../components/Skeleton";
import { IconBuilding } from "../components/Icons";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function HomePage() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ tenants: Tenant[] }>("/tenants");
      setTenants(res.tenants);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load your organizations.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await api.post<{ tenant: Tenant }>("/tenants", { name, slug });
      setName("");
      setSlug("");
      setSlugTouched(false);
      await load();
      navigate(`/tenants/${res.tenant.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create organization.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Layout>
      {tenants === null ? (
        <SkeletonStatGrid count={1} />
      ) : (
        <StatGrid>
          <StatCard icon={<IconBuilding />} label="Organizations" value={tenants.length} />
        </StatGrid>
      )}

      <section className="panel">
        <h1>Your organizations</h1>
        <p className="muted">
          An organization (tenant) holds one or more projects. Create one to get started, then add a project to get
          your lead-capture embed snippet.
        </p>

        <ErrorBanner message={loadError} />

        {tenants === null ? (
          <div aria-hidden="true">
            <SkeletonText width="70%" />
            <SkeletonText width="45%" />
            <SkeletonText width="60%" />
          </div>
        ) : tenants.length === 0 ? (
          <EmptyState title="No organizations yet" hint="Create your first one below." />
        ) : (
          <ul className="card-list">
            {tenants.map((t) => (
              <li key={t.id} className="card-list-item" onClick={() => navigate(`/tenants/${t.id}`)}>
                <div>
                  <strong>{t.name}</strong>
                  <span className="muted"> /{t.slug}</span>
                </div>
                <span className="muted">{t.role ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Create a new organization</h2>
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
              placeholder="Acme Inc."
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
              placeholder="acme-inc"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? "Creating..." : "Create organization"}
          </button>
        </form>
      </section>
    </Layout>
  );
}

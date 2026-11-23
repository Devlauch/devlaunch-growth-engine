import { useMemo, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import type { Tenant } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { setLastActiveTenantId } from "../lib/lastActiveTenant";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

interface CreateTenantResponse {
  tenant: Tenant;
  project: { id: string };
}

/**
 * First-login-only "set up your workspace" screen. Reached only when the
 * authenticated user has zero memberships (see App.tsx's RootRoute) — a
 * user who already has an organization is redirected away before this
 * renders, since each account may only ever create/own one (see
 * docs/DECISIONS.md and routes/tenants.ts's POST / handler).
 */
export function OnboardingPage() {
  const { user, memberships, refreshMembershipsList } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugPreview = useMemo(() => (slugTouched ? slugify(slug) : slugify(name)), [name, slug, slugTouched]);

  if (!user) return <Navigate to="/login" replace />;
  // Route guard: already has an organization -> straight to its dashboard,
  // never back to this screen.
  if (memberships.length > 0) {
    const target = memberships.find((m) => m.role === "owner") ?? memberships[0];
    return <Navigate to={`/tenants/${target.tenantId}`} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Company name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<CreateTenantResponse>("/tenants", {
        name: name.trim(),
        slug: slugPreview || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });
      await refreshMembershipsList();
      setLastActiveTenantId(res.tenant.id);
      navigate(`/tenants/${res.tenant.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your workspace. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="brand auth-brand">
          <span className="brand-mark">DL</span>
          <span className="brand-text">
            DevLaunch <span className="brand-accent">Growth Engine</span>
          </span>
        </div>
        <h1 style={{ marginTop: 18 }}>Set up your workspace</h1>
        <p className="auth-subtitle">One organization per account — you're setting yours up now.</p>

        <ErrorBanner message={error} />

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span>Company name</span>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>Website URL (optional)</span>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://acme.com"
            />
          </label>
          <label className="field">
            <span>Workspace URL slug</span>
            <input
              type="text"
              value={slugPreview}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="acme-inc"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
            <span className="muted" style={{ fontSize: "var(--fs-xs)" }}>
              Auto-generated from the company name — edit if you'd like. If it's taken, we'll add a number.
            </span>
          </label>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating workspace…" : "Create workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}

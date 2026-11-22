import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { OnboardingCompleteness, Tenant } from "../api/types";

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Client onboarding (industry/goals) + white-label branding settings for a
 * tenant. Owner/admin only (enforced server-side by
 * apps/api/src/routes/tenants.ts's PATCH /:tenantId).
 *
 * IMPORTANT — the "requested subdomain" field here is exactly that: a
 * stored reference string a tenant can ask for. Nothing in this app
 * provisions DNS, TLS, or any actual custom-domain routing for it — that
 * requires real infrastructure this environment doesn't have. The copy
 * below says so plainly instead of implying a working custom-domain flow.
 */
export function BrandingPage() {
  const { tenantId } = useParams<{ tenantId: string }>();

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [completeness, setCompleteness] = useState<OnboardingCompleteness | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [industry, setIndustry] = useState("");
  const [goals, setGoals] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("");
  const [subdomain, setSubdomain] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [tenantRes, completenessRes] = await Promise.all([
        api.get<{ tenant: Tenant }>(`/tenants/${tenantId}`),
        api.get<OnboardingCompleteness>(`/tenants/${tenantId}/onboarding-completeness`),
      ]);
      setTenant(tenantRes.tenant);
      setIndustry(tenantRes.tenant.industry ?? "");
      setGoals(tenantRes.tenant.goals ?? "");
      setLogoUrl(tenantRes.tenant.logo_url ?? "");
      setPrimaryColor(tenantRes.tenant.primary_color ?? "");
      setSubdomain(tenantRes.tenant.subdomain ?? "");
      setCompleteness(completenessRes);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load branding settings for this organization.");
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  // Client-side preview of the same hex-color rule the API enforces
  // (apps/api/src/routes/tenants.ts's hexColorSchema +
  // packages/db/migrations/210_add_branding_to_tenants.sql's CHECK
  // constraint) — lets the form show a validation message before the
  // round-trip, without duplicating the real source of truth.
  const primaryColorError =
    primaryColor.trim() && !HEX_COLOR_PATTERN.test(primaryColor.trim())
      ? "Enter a 6-digit hex color like #6d5cf0."
      : null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaveError(null);
    setSaved(false);
    if (primaryColorError) {
      setSaveError(primaryColorError);
      return;
    }
    setSaving(true);
    try {
      const res = await api.patch<{ tenant: Tenant }>(`/tenants/${tenantId}`, {
        industry: industry.trim() ? industry.trim() : null,
        goals: goals.trim() ? goals.trim() : null,
        logoUrl: logoUrl.trim() ? logoUrl.trim() : null,
        primaryColor: primaryColor.trim() ? primaryColor.trim() : null,
        subdomain: subdomain.trim() ? subdomain.trim() : null,
      });
      setTenant(res.tenant);
      setSaved(true);
      // Re-fetch completeness: branding fields just changed, and this is
      // real row-existence data, never a fabricated percentage.
      const completenessRes = await api.get<OnboardingCompleteness>(`/tenants/${tenantId}/onboarding-completeness`);
      setCompleteness(completenessRes);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save branding settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: tenant?.name ?? "Organization", to: `/tenants/${tenantId}` },
        { label: "Branding & Profile" },
      ]}
      tenantName={tenant?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Onboarding checklist</h1>
        <p className="callout">
          Computed from what actually exists for this organization right now — never an estimated or fabricated
          percentage.
        </p>
        {completeness === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <ul className="card-list">
            {completeness.checklist.map((item) => (
              <li key={item.key} className="card-list-item">
                <span>{item.label}</span>
                <Badge tone={item.done ? "success" : "neutral"}>{item.done ? "Done" : "Not yet"}</Badge>
              </li>
            ))}
          </ul>
        )}
        {completeness ? (
          <p className="muted hint">
            {completeness.completedCount} of {completeness.totalCount} steps complete.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Client onboarding</h2>
        <p className="callout">Captured once during onboarding, editable any time by an owner or admin.</p>

        {tenant === null ? (
          <p className="muted">Loading...</p>
        ) : (
          <form className="form" onSubmit={handleSave}>
            <ErrorBanner message={saveError} />
            {saved ? <p className="muted">Saved.</p> : null}

            <label className="field">
              <span>Industry</span>
              <input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. B2B SaaS"
                maxLength={200}
              />
            </label>

            <label className="field">
              <span>Goals</span>
              <input
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
                placeholder="e.g. Grow qualified pipeline 20% this quarter"
                maxLength={5000}
              />
            </label>

            <h3>White-label branding</h3>

            <label className="field">
              <span>Logo URL</span>
              <input
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://cdn.example.com/your-logo.png"
                maxLength={2000}
              />
            </label>
            <p className="muted">Shown in place of the default wordmark in the sidebar once set.</p>

            <label className="field">
              <span>Primary color</span>
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                placeholder="#6d5cf0"
                maxLength={7}
              />
            </label>
            {primaryColorError ? <p className="hint" style={{ color: "var(--danger)" }}>{primaryColorError}</p> : null}
            <p className="muted">A 6-digit hex color, applied live across the dashboard once saved.</p>

            <label className="field">
              <span>Requested subdomain</span>
              <input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                placeholder="acme"
                maxLength={63}
              />
            </label>
            <p className="muted">
              This is a <strong>requested</strong> reference only — not yet provisioned. No DNS record or TLS
              certificate exists for it. Contact support to go live on a custom subdomain.
            </p>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : "Save branding"}
              </button>
            </div>
          </form>
        )}
      </section>
    </Layout>
  );
}

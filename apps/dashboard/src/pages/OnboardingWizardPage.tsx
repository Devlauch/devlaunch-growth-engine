import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Mirrors apps/api/src/lib/industryTemplates.ts's IndustryKey union exactly.
type IndustryKey = "education" | "saas" | "agency" | "local_services";

// Local shapes mirroring exactly what GET .../onboarding/templates and
// POST .../onboarding/apply return — never widened beyond what the route
// handlers actually send (apps/dashboard convention; see DiscoveryPage.tsx).
interface TemplatePreview {
  key: IndustryKey;
  label: string;
  valuePropositionPreview: string;
  icpProfileNames: string[];
  scoringCriteriaCount: number;
  sequenceStepCount: number;
}

interface IcpProfileRow {
  id: string;
  name: string;
}

interface RubricRow {
  id: string;
  name: string;
  is_active: boolean;
}

interface SequenceRow {
  id: string;
  name: string;
  steps: unknown[];
}

interface ApplyResult {
  profileUpdated: boolean;
  icpProfilesCreated: IcpProfileRow[];
  rubricCreated: RubricRow | null;
  sequenceCreated: SequenceRow | null;
  notes: string[];
}

type WizardStep = 1 | 2 | 3;

export function OnboardingWizardPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<WizardStep>(1);

  // Step 1 fields
  const [website, setWebsite] = useState("");
  const [offer, setOffer] = useState("");

  // Step 2 fields
  const [templates, setTemplates] = useState<TemplatePreview[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<IndustryKey | null>(null);

  // Step 3 / submit
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);

  const loadProject = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const res = await api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`);
      setProject(res.project);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  const loadTemplates = useCallback(async () => {
    if (!tenantId || !projectId) return;
    setTemplatesError(null);
    try {
      const res = await api.get<{ templates: TemplatePreview[] }>(
        `/tenants/${tenantId}/projects/${projectId}/onboarding/templates`,
      );
      setTemplates(res.templates);
    } catch (err) {
      setTemplatesError(err instanceof ApiError ? err.message : "Could not load industry templates.");
    }
  }, [tenantId, projectId]);

  function handleStep1Submit(e: FormEvent) {
    e.preventDefault();
    setStep(2);
    if (templates === null) void loadTemplates();
  }

  function handleStep2Next() {
    if (!selectedKey) return;
    setStep(3);
  }

  async function handleApply() {
    if (!tenantId || !projectId || !selectedKey) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await api.post<ApplyResult>(`/tenants/${tenantId}/projects/${projectId}/onboarding/apply`, {
        website,
        offer,
        industryTemplate: selectedKey,
      });
      setResult(res);
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "Could not apply this template.");
    } finally {
      setApplying(false);
    }
  }

  function handleStartOver() {
    setStep(1);
    setWebsite("");
    setOffer("");
    setSelectedKey(null);
    setResult(null);
    setApplyError(null);
  }

  const selectedTemplate = templates?.find((t) => t.key === selectedKey) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Onboarding" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Onboarding wizard</h1>
        <p className="callout">
          Enter the website and offer, pick an industry, and this pre-fills the project profile, an ICP, a starter
          scoring rubric, and an outreach sequence — all editable afterward.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Badge tone={step === 1 ? "info" : "success"}>1. Website &amp; offer</Badge>
          <Badge tone={step === 2 ? "info" : step > 2 ? "success" : "neutral"}>2. Industry</Badge>
          <Badge tone={step === 3 ? "info" : "neutral"}>3. Review &amp; apply</Badge>
        </div>

        {step === 1 ? (
          <form className="form" onSubmit={handleStep1Submit}>
            <label className="field">
              <span>Website</span>
              <input
                required
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </label>
            <label className="field">
              <span>Offer / value proposition</span>
              <textarea
                required
                value={offer}
                onChange={(e) => setOffer(e.target.value)}
                placeholder="What do you sell, and to whom, in a sentence or two?"
                rows={4}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Next: pick an industry
              </button>
            </div>
          </form>
        ) : null}

        {step === 2 ? (
          <div>
            <ErrorBanner message={templatesError} />
            {templates === null ? (
              <p className="muted">Loading templates...</p>
            ) : templates.length === 0 ? (
              <EmptyState title="No industry templates available" />
            ) : (
              <ul className="card-list card-list-static">
                {templates.map((t) => (
                  <li key={t.key} className="card-list-item card-list-item-static">
                    <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer", width: "100%" }}>
                      <input
                        type="radio"
                        name="industryTemplate"
                        checked={selectedKey === t.key}
                        onChange={() => setSelectedKey(t.key)}
                      />
                      <div>
                        <strong>{t.label}</strong>
                        <p className="muted">{t.valuePropositionPreview}</p>
                        <p className="muted">
                          ICPs: {t.icpProfileNames.join(", ")} · {t.scoringCriteriaCount} scoring criteria ·{" "}
                          {t.sequenceStepCount}-step sequence
                        </p>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" disabled={!selectedKey} onClick={handleStep2Next}>
                Next: review
              </button>
            </div>
          </div>
        ) : null}

        {step === 3 && !result ? (
          <div>
            <h2>Review</h2>
            <p>
              <strong>Website:</strong> {website}
            </p>
            <p>
              <strong>Offer:</strong> {offer}
            </p>
            <p>
              <strong>Industry template:</strong> {selectedTemplate?.label ?? selectedKey}
            </p>
            {selectedTemplate ? (
              <p className="muted">
                This will create {selectedTemplate.icpProfileNames.length} ICP profile(s), a starter scoring rubric
                with {selectedTemplate.scoringCriteriaCount} criteria, and a {selectedTemplate.sequenceStepCount}-step
                sequence — all of which you can edit afterward.
              </p>
            ) : null}

            <ErrorBanner message={applyError} />

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(2)} disabled={applying}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={handleApply} disabled={applying}>
                {applying ? "Applying..." : "Apply template"}
              </button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div>
            <h2>Done</h2>

            {result.notes.length > 0 ? (
              <ul className="card-list card-list-static">
                {result.notes.map((note, i) => (
                  <li key={i} className="card-list-item card-list-item-static">
                    <Badge tone="warn">note</Badge> <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <h3>ICP profiles created</h3>
            {result.icpProfilesCreated.length === 0 ? (
              <EmptyState
                title="No new ICP profiles created"
                hint="Every ICP in this template already existed for this project (see notes above)."
              />
            ) : (
              <ul className="card-list card-list-static">
                {result.icpProfilesCreated.map((icp) => (
                  <li key={icp.id} className="card-list-item card-list-item-static">
                    {icp.name}
                  </li>
                ))}
              </ul>
            )}

            <h3>Scoring rubric</h3>
            {result.rubricCreated ? (
              <p>
                <strong>{result.rubricCreated.name}</strong>{" "}
                <Badge tone={result.rubricCreated.is_active ? "success" : "neutral"}>
                  {result.rubricCreated.is_active ? "active" : "inactive"}
                </Badge>
              </p>
            ) : (
              <EmptyState title="No rubric created" />
            )}

            <h3>Outreach sequence</h3>
            {result.sequenceCreated ? (
              <p>
                <strong>{result.sequenceCreated.name}</strong>{" "}
                <span className="muted">· {result.sequenceCreated.steps.length} step(s)</span>
              </p>
            ) : (
              <EmptyState
                title="No sequence created"
                hint="See notes above — the sequences feature may not be available yet."
              />
            )}

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={handleStartOver}>
                Start over
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </Layout>
  );
}

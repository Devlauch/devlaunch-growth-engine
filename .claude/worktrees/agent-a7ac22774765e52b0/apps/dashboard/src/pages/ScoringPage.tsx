import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";
import type { Project } from "../api/types";

// Local types for roadmap item 7 ("Configurable scoring"). Kept here rather
// than in api/types.ts to avoid colliding with other pages/agents editing
// that shared file in parallel — shapes mirror apps/api/src/routes/scoring.ts
// and packages/db migrations 031-034 exactly, nothing fabricated.

interface RubricCriterion {
  key: string;
  label: string;
  weight: number;
  description?: string;
}

interface ScoringRubric {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  criteria: RubricCriterion[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface CriterionScore {
  score: number;
  maxScore: number;
  hasEvidence: boolean;
  evidenceSummary?: string;
  evidenceSource?: string;
}

interface LeadScore {
  id: string;
  lead_id: string;
  rubric_id: string | null;
  total_score: string | number;
  criteria_evidence: Record<string, CriterionScore>;
  why_summary: string;
  next_research_note: string | null;
  computed_at: string;
}

interface LeadScoreFeedback {
  id: string;
  lead_id: string;
  user_id: string;
  feedback: "good" | "bad";
  note: string | null;
  created_at: string;
}

type CriterionDraft = { key: string; label: string; weight: string; description: string };

const EMPTY_CRITERION_DRAFT: CriterionDraft = { key: "", label: "", weight: "", description: "" };

function emptyRubricForm(): { name: string; criteria: CriterionDraft[] } {
  return { name: "", criteria: [{ ...EMPTY_CRITERION_DRAFT }] };
}

export function ScoringPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [rubrics, setRubrics] = useState<ScoringRubric[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingRubricId, setEditingRubricId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyRubricForm());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);

  const [leadIdInput, setLeadIdInput] = useState("");
  const [lookedUpLeadId, setLookedUpLeadId] = useState<string | null>(null);
  const [leadScore, setLeadScore] = useState<LeadScore | null>(null);
  const [leadScoreNotFound, setLeadScoreNotFound] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [scoreLoading, setScoreLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [recentFeedback, setRecentFeedback] = useState<LeadScoreFeedback | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, rubricsRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ scoringRubrics: ScoringRubric[] }>(`/tenants/${tenantId}/projects/${projectId}/scoring-rubrics`),
      ]);
      setProject(projectRes.project);
      setRubrics(rubricsRes.scoringRubrics);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load scoring rubrics for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreateForm() {
    setEditingRubricId(null);
    setForm(emptyRubricForm());
    setSaveError(null);
    setFormOpen(true);
  }

  function openEditForm(rubric: ScoringRubric) {
    setEditingRubricId(rubric.id);
    setForm({
      name: rubric.name,
      criteria: rubric.criteria.map((c) => ({
        key: c.key,
        label: c.label,
        weight: String(c.weight),
        description: c.description ?? "",
      })),
    });
    setSaveError(null);
    setFormOpen(true);
  }

  function updateCriterionDraft(index: number, patch: Partial<CriterionDraft>) {
    setForm((f) => ({
      ...f,
      criteria: f.criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addCriterionRow() {
    setForm((f) => ({ ...f, criteria: [...f.criteria, { ...EMPTY_CRITERION_DRAFT }] }));
  }

  function removeCriterionRow(index: number) {
    setForm((f) => ({ ...f, criteria: f.criteria.filter((_, i) => i !== index) }));
  }

  async function handleSaveRubric(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    setSaveError(null);

    const criteria = form.criteria.map((c) => ({
      key: c.key.trim(),
      label: c.label.trim(),
      weight: Number(c.weight),
      ...(c.description.trim() ? { description: c.description.trim() } : {}),
    }));
    if (criteria.length === 0 || criteria.some((c) => !c.key || !c.label || !(c.weight > 0))) {
      setSaveError("Every criterion needs a key, a label, and a positive weight.");
      return;
    }

    setSaving(true);
    try {
      if (editingRubricId) {
        await api.patch(`/tenants/${tenantId}/projects/${projectId}/scoring-rubrics/${editingRubricId}`, {
          name: form.name.trim(),
          criteria,
        });
      } else {
        await api.post(`/tenants/${tenantId}/projects/${projectId}/scoring-rubrics`, {
          name: form.name.trim(),
          criteria,
        });
      }
      setFormOpen(false);
      setForm(emptyRubricForm());
      setEditingRubricId(null);
      await load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save this rubric.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetActive(rubric: ScoringRubric) {
    if (!tenantId || !projectId) return;
    setActivateError(null);
    setActivatingId(rubric.id);
    try {
      await api.patch(`/tenants/${tenantId}/projects/${projectId}/scoring-rubrics/${rubric.id}`, {
        isActive: true,
      });
      await load();
    } catch (err) {
      setActivateError(err instanceof ApiError ? err.message : "Could not activate this rubric.");
    } finally {
      setActivatingId(null);
    }
  }

  async function handleLoadScore(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId) return;
    const leadId = leadIdInput.trim();
    if (!leadId) return;

    setScoreError(null);
    setLeadScoreNotFound(false);
    setLeadScore(null);
    setRecentFeedback(null);
    setLookedUpLeadId(leadId);
    setScoreLoading(true);
    try {
      const res = await api.get<{ leadScore: LeadScore }>(
        `/tenants/${tenantId}/projects/${projectId}/lead-scores/${leadId}`,
      );
      setLeadScore(res.leadScore);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLeadScoreNotFound(true);
      } else {
        setScoreError(err instanceof ApiError ? err.message : "Could not load this lead's score.");
      }
    } finally {
      setScoreLoading(false);
    }
  }

  async function handleRecompute() {
    if (!tenantId || !projectId || !lookedUpLeadId) return;
    setScoreError(null);
    setRecomputing(true);
    try {
      const res = await api.post<{ score: LeadScore }>(
        `/tenants/${tenantId}/projects/${projectId}/lead-scores/${lookedUpLeadId}/recompute`,
      );
      setLeadScore(res.score);
      setLeadScoreNotFound(false);
    } catch (err) {
      setScoreError(err instanceof ApiError ? err.message : "Could not recompute this lead's score.");
    } finally {
      setRecomputing(false);
    }
  }

  async function handleFeedback(feedback: "good" | "bad") {
    if (!tenantId || !projectId || !lookedUpLeadId) return;
    setFeedbackError(null);
    setFeedbackSending(true);
    try {
      const res = await api.post<{ feedback: LeadScoreFeedback }>(
        `/tenants/${tenantId}/projects/${projectId}/lead-scores/${lookedUpLeadId}/feedback`,
        { feedback, ...(feedbackNote.trim() ? { note: feedbackNote.trim() } : {}) },
      );
      setRecentFeedback(res.feedback);
      setFeedbackNote("");
    } catch (err) {
      setFeedbackError(err instanceof ApiError ? err.message : "Could not record feedback for this lead.");
    } finally {
      setFeedbackSending(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Scoring" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Scoring rubrics</h1>
        <p className="callout">
          A rubric is a weighted set of criteria. A lead's score comes from{" "}
          <code>POST .../lead-scores/:leadId/recompute</code>, which checks the lead's own custom fields and any
          matching discovered organization/contact data for each criterion — full credit when evidence is found,
          zero when it isn't. No partial or guessed credit.
        </p>

        {rubrics === null ? (
          <p className="muted">Loading...</p>
        ) : rubrics.length === 0 ? (
          <EmptyState title="No scoring rubric yet" hint="Create one below before recomputing any lead's score." />
        ) : (
          <ul className="card-list card-list-static">
            {rubrics.map((rubric) => (
              <li key={rubric.id} className="card-list-item card-list-item-static">
                <div>
                  <strong>{rubric.name}</strong>
                  <span className="muted"> · {rubric.criteria.length} criteria</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Badge tone={rubric.is_active ? "success" : "neutral"}>
                    {rubric.is_active ? "active" : "inactive"}
                  </Badge>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => openEditForm(rubric)}>
                    Edit
                  </button>
                  {!rubric.is_active ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={activatingId === rubric.id}
                      onClick={() => handleSetActive(rubric)}
                    >
                      {activatingId === rubric.id ? "Activating..." : "Set active"}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <ErrorBanner message={activateError} />

        {!formOpen ? (
          <button type="button" className="btn btn-primary" onClick={openCreateForm}>
            New rubric
          </button>
        ) : (
          <form className="form" onSubmit={handleSaveRubric}>
            <ErrorBanner message={saveError} />
            <label className="field">
              <span>Rubric name</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Default ICP fit"
              />
            </label>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Label</th>
                    <th>Weight</th>
                    <th>Description</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {form.criteria.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          required
                          value={c.key}
                          onChange={(e) => updateCriterionDraft(i, { key: e.target.value })}
                          placeholder="budget_confirmed"
                        />
                      </td>
                      <td>
                        <input
                          required
                          value={c.label}
                          onChange={(e) => updateCriterionDraft(i, { label: e.target.value })}
                          placeholder="Budget confirmed"
                        />
                      </td>
                      <td>
                        <input
                          required
                          type="number"
                          min={1}
                          value={c.weight}
                          onChange={(e) => updateCriterionDraft(i, { weight: e.target.value })}
                          placeholder="40"
                          style={{ width: 80 }}
                        />
                      </td>
                      <td>
                        <input
                          value={c.description}
                          onChange={(e) => updateCriterionDraft(i, { description: e.target.value })}
                          placeholder="optional"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={form.criteria.length <= 1}
                          onClick={() => removeCriterionRow(i)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary btn-small" onClick={addCriterionRow}>
                Add criterion
              </button>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : editingRubricId ? "Save changes" : "Create rubric"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setFormOpen(false);
                  setEditingRubricId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Look up a lead's score</h2>
        <form className="form-inline" onSubmit={handleLoadScore}>
          <label className="field">
            <span>Lead ID</span>
            <input
              required
              value={leadIdInput}
              onChange={(e) => setLeadIdInput(e.target.value)}
              placeholder="lead UUID"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={scoreLoading}>
            {scoreLoading ? "Loading..." : "Load score"}
          </button>
        </form>

        <ErrorBanner message={scoreError} />

        {lookedUpLeadId === null ? null : leadScoreNotFound ? (
          <>
            <EmptyState
              title="Not scored yet"
              hint="This lead has no computed score yet. Recompute it below once a rubric is active."
            />
            <button type="button" className="btn btn-primary" disabled={recomputing} onClick={handleRecompute}>
              {recomputing ? "Recomputing..." : "Recompute score"}
            </button>
          </>
        ) : leadScore ? (
          <div className="panel-nested">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <strong style={{ fontSize: "1.4rem" }}>{Number(leadScore.total_score)}/100</strong>
              <span className="muted">computed {new Date(leadScore.computed_at).toLocaleString()}</span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={recomputing}
                onClick={handleRecompute}
              >
                {recomputing ? "Recomputing..." : "Recompute"}
              </button>
            </div>

            <p>{leadScore.why_summary}</p>
            {leadScore.next_research_note ? <p className="muted">{leadScore.next_research_note}</p> : null}

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th>Score</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(leadScore.criteria_evidence).map(([key, c]) => (
                    <tr key={key}>
                      <td>{key}</td>
                      <td>
                        <Badge tone={c.hasEvidence ? "success" : "neutral"}>
                          {c.score}/{c.maxScore}
                        </Badge>
                      </td>
                      <td>{c.evidenceSummary ?? (c.hasEvidence ? "—" : "No evidence found")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ErrorBanner message={feedbackError} />
            <div className="form-inline">
              <label className="field">
                <span>Feedback note (optional)</span>
                <input
                  value={feedbackNote}
                  onChange={(e) => setFeedbackNote(e.target.value)}
                  placeholder="Why was this a good/bad lead?"
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={feedbackSending}
                onClick={() => handleFeedback("good")}
              >
                Good lead
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={feedbackSending}
                onClick={() => handleFeedback("bad")}
              >
                Bad lead
              </button>
            </div>
            {recentFeedback ? (
              <p className="muted">Recorded "{recentFeedback.feedback}" feedback for this lead.</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </Layout>
  );
}

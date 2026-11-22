import { useCallback, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge } from "../components/Badge";
import { api, ApiError } from "../api/client";

// Local interfaces only (api/types.ts is off-limits for this feature) —
// mirror the real shape of the /explain response built by
// apps/api/src/routes/leadIntelligence.ts.

interface RubricScore {
  id: string;
  total_score: string | number;
  why_summary: string;
  next_research_note: string | null;
}

interface IcpMatch {
  id: string;
  icp_profile_id: string;
  icp_profile_name?: string;
  match_score: string | number;
  match_reasons: string[];
}

interface BuyingSignal {
  id: string;
  signal_type: string;
  detail: string;
  source_url: string | null;
  confidence: "high" | "medium" | "low";
  detected_at: string;
}

interface CompanyEnrichment {
  id: string;
  domain: string | null;
  firmographics: Record<string, unknown>;
  data_sources: string[];
  enriched_at: string;
}

interface ExplainResponse {
  rubricScore: RubricScore | null;
  icpMatches: IcpMatch[];
  buyingSignals: BuyingSignal[];
  enrichment: CompanyEnrichment | null;
  summary: string;
}

function signalConfidenceTone(confidence: string): "success" | "info" | "neutral" {
  switch (confidence) {
    case "high":
      return "success";
    case "medium":
      return "info";
    default:
      return "neutral";
  }
}

export function LeadIntelligencePage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [leadIdInput, setLeadIdInput] = useState("");
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);

  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  const [matchingIcp, setMatchingIcp] = useState(false);
  const [icpMatchError, setIcpMatchError] = useState<string | null>(null);

  const [signalText, setSignalText] = useState("");
  const [signalSourceUrl, setSignalSourceUrl] = useState("");
  const [detectingSignals, setDetectingSignals] = useState(false);
  const [signalError, setSignalError] = useState<string | null>(null);

  const loadExplain = useCallback(
    async (leadId: string) => {
      if (!tenantId || !projectId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.get<ExplainResponse>(
          `/tenants/${tenantId}/projects/${projectId}/leads/${leadId}/intelligence/explain`,
        );
        setExplain(result);
      } catch (err) {
        setExplain(null);
        setLoadError(err instanceof ApiError ? err.message : "Could not load intelligence for this lead.");
      } finally {
        setLoading(false);
      }
    },
    [tenantId, projectId],
  );

  function handleLookup(e: FormEvent) {
    e.preventDefault();
    const leadId = leadIdInput.trim();
    if (!leadId) return;
    setActiveLeadId(leadId);
    void loadExplain(leadId);
  }

  async function handleEnrich() {
    if (!tenantId || !projectId || !activeLeadId) return;
    setEnrichError(null);
    setEnriching(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/leads/${activeLeadId}/intelligence/enrich`);
      await loadExplain(activeLeadId);
    } catch (err) {
      setEnrichError(err instanceof ApiError ? err.message : "Could not enrich this lead.");
    } finally {
      setEnriching(false);
    }
  }

  async function handleIcpMatch() {
    if (!tenantId || !projectId || !activeLeadId) return;
    setIcpMatchError(null);
    setMatchingIcp(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/leads/${activeLeadId}/intelligence/icp-match`);
      await loadExplain(activeLeadId);
    } catch (err) {
      setIcpMatchError(err instanceof ApiError ? err.message : "Could not compute ICP matches for this lead.");
    } finally {
      setMatchingIcp(false);
    }
  }

  async function handleDetectSignals(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !projectId || !activeLeadId) return;
    if (!signalText.trim()) return;
    setSignalError(null);
    setDetectingSignals(true);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/leads/${activeLeadId}/intelligence/buying-signals`, {
        text: signalText.trim(),
        sourceUrl: signalSourceUrl.trim() || undefined,
      });
      setSignalText("");
      setSignalSourceUrl("");
      await loadExplain(activeLeadId);
    } catch (err) {
      setSignalError(err instanceof ApiError ? err.message : "Could not detect buying signals from this text.");
    } finally {
      setDetectingSignals(false);
    }
  }

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: "Project", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Lead Intelligence" },
      ]}
    >
      <section className="panel">
        <h1>Lead Intelligence</h1>
        <p className="callout">
          A complementary layer on top of the existing rubric-based scoring system — company enrichment, ICP-fit
          matching against your named ICP personas, and buying-signal detection from already-crawled public data.
          Look up a lead by ID to see why it's qualified.
        </p>

        <form className="form" onSubmit={handleLookup}>
          <label className="field">
            <span>Lead ID</span>
            <input
              required
              value={leadIdInput}
              onChange={(e) => setLeadIdInput(e.target.value)}
              placeholder="UUID of a lead in this project"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? "Loading..." : "Look up"}
            </button>
          </div>
        </form>

        <ErrorBanner message={loadError} />
      </section>

      {activeLeadId ? (
        <>
          <section className="panel">
            <h2>Rubric score (existing scoring system)</h2>
            {explain?.rubricScore ? (
              <div>
                <p>
                  <strong>{explain.rubricScore.total_score}/100</strong>
                </p>
                <p className="muted">{explain.rubricScore.why_summary}</p>
                {explain.rubricScore.next_research_note ? (
                  <p className="muted">{explain.rubricScore.next_research_note}</p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                title="No rubric score yet"
                hint="This lead hasn't been scored by the active scoring rubric yet (see Lead Scores)."
              />
            )}
          </section>

          <section className="panel">
            <h2>Company enrichment</h2>
            <ErrorBanner message={enrichError} />
            {explain?.enrichment ? (
              <div>
                <p>
                  <strong>Domain:</strong> {explain.enrichment.domain ?? "—"}
                </p>
                <pre className="muted">{JSON.stringify(explain.enrichment.firmographics, null, 2)}</pre>
                <p className="muted">Sources: {explain.enrichment.data_sources.join(", ") || "—"}</p>
              </div>
            ) : (
              <EmptyState title="No enrichment yet" hint="Run enrichment to pull in any matched organization data." />
            )}
            <button type="button" className="btn btn-secondary" disabled={enriching} onClick={handleEnrich}>
              {enriching ? "Enriching..." : "Run enrichment"}
            </button>
          </section>

          <section className="panel">
            <h2>ICP-fit matches</h2>
            <ErrorBanner message={icpMatchError} />
            {explain && explain.icpMatches.length > 0 ? (
              <ul className="card-list card-list-static">
                {explain.icpMatches.map((m) => (
                  <li key={m.id} className="card-list-item card-list-item-static">
                    <div>
                      <strong>{m.icp_profile_name ?? m.icp_profile_id}</strong>
                      <span className="muted"> · {m.match_score}% fit</span>
                    </div>
                    {m.match_reasons.length > 0 ? (
                      <ul>
                        {m.match_reasons.map((reason, i) => (
                          <li key={i} className="muted">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No ICP matches yet" hint="Run ICP matching to score this lead against your ICP profiles." />
            )}
            <button type="button" className="btn btn-secondary" disabled={matchingIcp} onClick={handleIcpMatch}>
              {matchingIcp ? "Matching..." : "Run ICP matching"}
            </button>
          </section>

          <section className="panel">
            <h2>Buying signals</h2>
            <ErrorBanner message={signalError} />
            {explain && explain.buyingSignals.length > 0 ? (
              <ul className="card-list card-list-static">
                {explain.buyingSignals.map((s) => (
                  <li key={s.id} className="card-list-item card-list-item-static">
                    <div>
                      <Badge tone={signalConfidenceTone(s.confidence)}>{s.signal_type}</Badge>
                      <span className="muted"> · {s.detail}</span>
                    </div>
                    <span className="muted">{s.confidence} confidence</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No buying signals detected yet"
                hint="Paste text from a crawled page or discovered organization below to scan it."
              />
            )}

            <form className="form" onSubmit={handleDetectSignals}>
              <label className="field">
                <span>Text to scan</span>
                <textarea
                  required
                  rows={4}
                  value={signalText}
                  onChange={(e) => setSignalText(e.target.value)}
                  placeholder="Paste text already obtained from a permitted public source (e.g. a discovered organization's page text)"
                />
              </label>
              <label className="field">
                <span>Source URL (optional)</span>
                <input value={signalSourceUrl} onChange={(e) => setSignalSourceUrl(e.target.value)} placeholder="https://..." />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={detectingSignals}>
                  {detectingSignals ? "Scanning..." : "Detect buying signals"}
                </button>
              </div>
            </form>
          </section>

          <section className="panel">
            <h2>Summary</h2>
            <p>{explain?.summary ?? "—"}</p>
          </section>
        </>
      ) : null}
    </Layout>
  );
}

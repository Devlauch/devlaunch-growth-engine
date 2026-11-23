import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { api, ApiError } from "../api/client";

/**
 * Workstream G1 — company-level research + decision-maker identification.
 *
 * Built as a NEW sibling component rather than extending CompaniesPage.tsx:
 * `git status` showed CompaniesPage.tsx as an untracked (brand-new,
 * presumably still-being-authored-by-another-agent) file at the time this
 * workstream started, so editing it directly risked clobbering concurrent
 * work. See this workstream's handback for the exact 2-line drop-in point
 * to wire this panel into CompaniesPage.tsx once it's safe to touch.
 *
 * Every field rendered here is a direct, unmodified read of
 * GET .../companies/:companyId/intelligence
 * (apps/api/src/routes/salesIntelligenceResearch.ts, backed by
 * apps/api/src/lib/companyIntelligence.ts +
 * apps/api/src/lib/prospectResearchSummary.ts) — nothing here is
 * estimated, inferred, or fabricated client-side.
 */

interface RankedContactDto {
  contact: {
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    sourceConfidence: "verified" | "inferred" | "unconfirmed";
  };
  score: number;
  bestMatchedRole: string | null;
}

interface ResearchSummaryDto {
  summary: string;
  rankedDecisionMakers: RankedContactDto[];
  firmographicsStatus: "found" | "not_found";
  websiteIntelligenceStatus: "not_available" | "no_snapshot" | "found";
  dealCount: number;
  openDealCount: number;
  llmPolish: { status: "ok" | "not_configured" | "budget_exceeded" | "error"; text: string | null };
}

interface IntelligenceDto {
  company: { id: string; name: string; domain: string | null; industry: string | null; sizeRange: string | null };
  decisionMakers: {
    trackedContacts: { id: string; name: string; title: string | null; email: string | null; phone: string | null }[];
    providerLookup: { status: "found" | "not_configured" | "no_result" };
  };
}

interface IntelligenceResponse {
  intelligence: IntelligenceDto;
  researchSummary: ResearchSummaryDto;
}

export function CompanyIntelligencePanel({
  tenantId,
  projectId,
  companyId,
}: {
  tenantId: string;
  projectId: string;
  companyId: string;
}) {
  const [data, setData] = useState<IntelligenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<IntelligenceResponse>(
        `/tenants/${tenantId}/projects/${projectId}/companies/${companyId}/intelligence`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load company intelligence.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, projectId, companyId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="panel">
      <h2>Company intelligence</h2>
      <p className="muted">
        Real, already-gathered research for this company — tracked contacts, the decision-maker provider waterfall,
        firmographics, and deal history. Nothing below is fabricated or estimated.
      </p>
      <ErrorBanner message={error} />

      {loading && !data ? (
        <p className="muted">Loading...</p>
      ) : !data ? (
        <EmptyState title="No intelligence yet" hint="Reload to fetch the latest research for this company." />
      ) : (
        <>
          <p>{data.researchSummary.summary}</p>

          {data.researchSummary.llmPolish.status === "ok" && data.researchSummary.llmPolish.text ? (
            <p className="muted">{data.researchSummary.llmPolish.text}</p>
          ) : null}

          <h3>Ranked decision-makers</h3>
          {data.researchSummary.rankedDecisionMakers.length === 0 ? (
            <EmptyState title="No decision-makers found" hint="No tracked contacts or provider results yet." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Matched role</th>
                  <th>Score</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.researchSummary.rankedDecisionMakers.map((r, i) => (
                  <tr key={`${r.contact.name}-${i}`}>
                    <td>{r.contact.name}</td>
                    <td>{r.contact.title ?? "—"}</td>
                    <td>{r.bestMatchedRole ?? "—"}</td>
                    <td>{r.score}</td>
                    <td>{r.contact.sourceConfidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted">
            Firmographics: {data.researchSummary.firmographicsStatus === "found" ? "on file" : "none yet"} · Website
            intelligence: {data.researchSummary.websiteIntelligenceStatus} · Deals:{" "}
            {data.researchSummary.dealCount} ({data.researchSummary.openDealCount} open)
          </p>
        </>
      )}
    </section>
  );
}

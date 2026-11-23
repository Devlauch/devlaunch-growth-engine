import type { PoolClient } from "pg";
import { getCompanyIntelligence, type CompanyIntelligenceResult } from "./companyIntelligence.js";
import { rankDecisionMakersByRelevance, type RankedContact } from "./decisionMakerIdentification.js";
import { getLeadActivityTimeline, type ActivityItem } from "./activityTimeline.js";
import { getLlmProvider } from "./llmProvider.js";
import { isLlmBudgetExceeded, recordLlmUsage } from "./llmBudget.js";
import { logger } from "./logger.js";

/**
 * prospectResearchSummary.ts: Workstream G1 — builds a deterministic,
 * structured research summary for a company PURELY from data already
 * gathered by existing, real libraries:
 *   - companyIntelligence.ts's getCompanyIntelligence (tracked contacts,
 *     live provider decision-maker lookup, firmographics, website intel,
 *     deal/lead history).
 *   - decisionMakerIdentification.ts's rankDecisionMakersByRelevance (pure
 *     title/keyword scoring over whatever contacts were actually found —
 *     no fabrication).
 *   - activityTimeline.ts's getLeadActivityTimeline (reused directly, not
 *     reimplemented), aggregated across this company's linked leads.
 *
 * No LLM call is required for the primary `summary` field — it is built by
 * plain string templating over the real data above, so it's fast and free
 * and always available. An LLM "polish" pass is strictly additive and
 * gated EXACTLY like aiSalesAssistant.ts's tryLlmText: `status:
 * "not_configured"` when no LLM provider key is set (every environment
 * this codebase has actually run in today), `status: "budget_exceeded"`
 * when this tenant's monthly token budget is used up, `status: "error"` if
 * the call itself fails (caught, logged, never thrown), `status: "ok"`
 * with real generated prose otherwise. The deterministic `summary` is
 * NEVER replaced by the LLM output — `llmPolish` is a separate, optional
 * field callers may choose to show instead of/alongside it.
 */

export type LlmTextStatus = "ok" | "not_configured" | "budget_exceeded" | "error";

export interface LlmTextResult {
  status: LlmTextStatus;
  text: string | null;
}

/** Target decision-maker roles used to rank contacts for a prospecting
 * research summary. A simple, documented default list — callers that want
 * a different target-role set for a specific campaign/ICP should call
 * rankDecisionMakersByRelevance directly with their own list instead of
 * this function's default. */
export const DEFAULT_TARGET_ROLES: readonly string[] = [
  "CEO",
  "Founder",
  "CMO",
  "VP Sales",
  "VP Marketing",
  "Head of Growth",
  "Head of Sales",
  "Head of Marketing",
  "Director of Sales",
  "Director of Marketing",
];

export interface ResearchSummary {
  companyId: string;
  companyName: string;
  domain: string | null;
  /** Deterministic, template-built summary — always present, never null. */
  summary: string;
  rankedDecisionMakers: RankedContact[];
  firmographicsStatus: "found" | "not_found";
  websiteIntelligenceStatus: CompanyIntelligenceResult["websiteIntelligence"]["status"];
  dealCount: number;
  openDealCount: number;
  recentActivity: ActivityItem[];
  /** Optional LLM-polished prose version of `summary`. Additive only —
   * see header comment. */
  llmPolish: LlmTextResult;
}

const OPEN_STAGES = new Set(["new", "contacted", "qualified", "proposal"]);

function buildDeterministicSummary(
  intelligence: CompanyIntelligenceResult,
  ranked: RankedContact[],
  recentActivity: ActivityItem[],
): string {
  const lines: string[] = [];
  const { company, decisionMakers, firmographics, websiteIntelligence, dealHistory } = intelligence;

  lines.push(`${company.name}${company.domain ? ` (${company.domain})` : ""}`);

  if (company.industry || company.sizeRange) {
    lines.push(
      [company.industry ? `Industry: ${company.industry}` : null, company.sizeRange ? `Size: ${company.sizeRange}` : null]
        .filter(Boolean)
        .join(" | "),
    );
  }

  const topRanked = ranked.filter((r) => r.score > 0).slice(0, 5);
  if (topRanked.length > 0) {
    lines.push(
      `Top-matched decision-makers: ${topRanked
        .map((r) => `${r.contact.name}${r.contact.title ? ` (${r.contact.title})` : ""} [score ${r.score}]`)
        .join("; ")}`,
    );
  } else if (decisionMakers.trackedContacts.length > 0 || decisionMakers.providerDecisionMakers.length > 0) {
    lines.push(
      `${decisionMakers.trackedContacts.length + decisionMakers.providerDecisionMakers.length} contact(s) known, none matched the target-role list.`,
    );
  } else if (decisionMakers.providerLookup.status === "not_configured") {
    lines.push("No decision-maker contacts tracked yet, and the provider waterfall is not configured in this environment.");
  } else {
    lines.push("No decision-maker contacts found yet.");
  }

  if (firmographics.status === "found") {
    const sourceNote = firmographics.dataSources.length > 0 ? ` (source: ${firmographics.dataSources.join(", ")})` : "";
    lines.push(`Firmographics on file${sourceNote}.`);
  } else {
    lines.push("No firmographics on file yet.");
  }

  lines.push(
    websiteIntelligence.status === "found"
      ? "Website intelligence snapshot available."
      : websiteIntelligence.status === "no_snapshot"
        ? "Website intelligence table exists but no snapshot has been captured yet for this company."
        : "Website intelligence is not available in this environment yet.",
  );

  const dealCount = dealHistory.deals.length;
  const openDealCount = dealHistory.deals.filter((d) => OPEN_STAGES.has(d.stage)).length;
  lines.push(
    dealCount > 0
      ? `${dealCount} deal(s) on record (${openDealCount} open), across ${dealHistory.leads.length} linked lead(s).`
      : `No deals on record yet (${dealHistory.leads.length} linked lead(s)).`,
  );

  if (recentActivity.length > 0) {
    lines.push(`Most recent activity: ${recentActivity[0].summary}`);
  }

  return lines.join("\n");
}

async function tryLlmPolish(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  companyId: string,
  deterministicSummary: string,
): Promise<LlmTextResult> {
  const provider = getLlmProvider();
  if (!provider.isConfigured) return { status: "not_configured", text: null };

  try {
    if (await isLlmBudgetExceeded(tenantDb, tenantId)) {
      return { status: "budget_exceeded", text: null };
    }
    const prompt =
      `Rewrite the following factual research summary as 2-4 natural-sounding sentences for a sales rep ` +
      `preparing outreach. Only use the facts given below — never invent a name, title, number, or event not ` +
      `listed.\n\n${deterministicSummary}`;
    const result = await provider.complete(prompt, {
      maxTokens: 300,
      systemPrompt:
        "You write short, factual prospecting research summaries strictly grounded in the data given. Never invent facts.",
    });
    await recordLlmUsage(tenantDb, tenantId, projectId, result, {
      feature: "prospect_research_summary_polish",
      companyId,
    });
    const text = result.text.trim();
    return { status: "ok", text: text.length > 0 ? text : null };
  } catch (err) {
    logger.warn(
      { err, tenantId, projectId, companyId },
      "prospectResearchSummary: LLM polish call failed, falling back to deterministic summary only",
    );
    return { status: "error", text: null };
  }
}

/**
 * Builds a deterministic research summary for one company, aggregating
 * companyIntelligence.ts + rankDecisionMakersByRelevance +
 * activityTimeline.ts's getLeadActivityTimeline (across this company's
 * linked leads, most recent first, capped at the 10 most recently created
 * leads to bound query fan-out for a company with a very long history).
 * Optionally attempts an LLM "polish" pass, gated exactly like
 * aiSalesAssistant.ts (see tryLlmPolish above) — never required, never
 * blocking, never replacing the deterministic summary.
 *
 * Signature note: the mission spec for this function listed
 * `(tenantDb, tenantId, companyId)`, but `companies` is a project-scoped
 * table (packages/db/migrations/302_create_companies.sql — every row has a
 * required project_id, and every existing route/library that reads it,
 * including this workstream's own getCompanyIntelligence, takes
 * projectId). Omitting it would make a correct, tenant-isolated lookup
 * impossible, so this function takes `projectId` explicitly, matching
 * getCompanyIntelligence's own (tenantDb, tenantId, projectId, companyId)
 * shape for consistency. `targetRoles` is an optional 5th arg (defaults to
 * DEFAULT_TARGET_ROLES) rather than silently ranking against no roles.
 */
export async function buildProspectResearchSummary(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  companyId: string,
  options?: { targetRoles?: readonly string[] },
): Promise<ResearchSummary> {
  const intelligence = await getCompanyIntelligence(tenantDb, tenantId, projectId, companyId);

  const allContacts = [...intelligence.decisionMakers.providerDecisionMakers];
  // Tracked CRM contacts are folded in as candidates too (title-matching
  // only cares about name/title, which both shapes carry) so a manually
  // added contact is ranked exactly like a provider-sourced one — but kept
  // distinguishable via sourceConfidence: 'unconfirmed' is never implied;
  // a tracked contact's own real data is used as-is, confidence omitted
  // (DecisionMakerCandidate requires it, so 'verified' is used since a
  // tracked contact is a confirmed CRM record a rep entered directly).
  for (const tc of intelligence.decisionMakers.trackedContacts) {
    allContacts.push({
      name: tc.name,
      title: tc.title,
      email: tc.email,
      phone: tc.phone,
      sourceUrl: null,
      sourceConfidence: "verified",
    });
  }

  const targetRoles = options?.targetRoles ?? DEFAULT_TARGET_ROLES;
  const ranked = rankDecisionMakersByRelevance(allContacts, targetRoles);

  const recentLeadIds = intelligence.dealHistory.leads.slice(0, 10).map((l) => l.id);
  const activityPerLead = await Promise.all(
    recentLeadIds.map((leadId) => getLeadActivityTimeline(tenantDb, tenantId, projectId, leadId)),
  );
  const recentActivity = activityPerLead
    .flat()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

  const deterministicSummary = buildDeterministicSummary(intelligence, ranked, recentActivity);
  const llmPolish = await tryLlmPolish(tenantDb, tenantId, projectId, companyId, deterministicSummary);

  return {
    companyId: intelligence.company.id,
    companyName: intelligence.company.name,
    domain: intelligence.company.domain,
    summary: deterministicSummary,
    rankedDecisionMakers: ranked,
    firmographicsStatus: intelligence.firmographics.status,
    websiteIntelligenceStatus: intelligence.websiteIntelligence.status,
    dealCount: intelligence.dealHistory.deals.length,
    openDealCount: intelligence.dealHistory.deals.filter((d) => OPEN_STAGES.has(d.stage)).length,
    recentActivity,
    llmPolish,
  };
}

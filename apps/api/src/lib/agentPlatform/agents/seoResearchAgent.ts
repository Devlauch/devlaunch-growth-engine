import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * seoResearchAgent: grounds its output in the real, existing seo_audits /
 * seo_audit_issues tables (076/077_create_seo_audits*.sql — populated by
 * siteAudit.ts's runSiteAudit + coreWebVitals.ts's checkCoreWebVitals, same
 * tables growthAdvisor.ts's unresolvedHighSeverityCrawlIssuesRule reads).
 * This agent never re-crawls or re-scores a site itself — it only
 * summarizes/prioritizes the most recent real audit already on file.
 */

export interface SeoResearchEvidence {
  latestAudit: Record<string, unknown> | null;
  issues: Record<string, unknown>[];
}

/** Real, read-only: most recent seo_audits row for this domain/project (optionally one specific audit id) plus its seo_audit_issues. */
export async function gatherSeoResearchEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  subjectId: string | null,
): Promise<SeoResearchEvidence> {
  const auditResult = await tenantDb.query(
    `SELECT id, domain, audited_at, sitemap_found, robots_found, pages_checked,
            broken_links_count, missing_meta_count, core_web_vitals, core_web_vitals_status
       FROM seo_audits
      WHERE tenant_id = $1 AND project_id = $2
        AND ($3::uuid IS NULL OR id = $3)
      ORDER BY audited_at DESC
      LIMIT 1`,
    [tenantId, projectId, subjectId ?? null],
  );

  const latestAudit = auditResult.rows[0] ?? null;
  if (!latestAudit) {
    return { latestAudit: null, issues: [] };
  }

  const issuesResult = await tenantDb.query(
    `SELECT id, issue_type, url, detail, severity, created_at
       FROM seo_audit_issues
      WHERE tenant_id = $1 AND audit_id = $2
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 100`,
    [tenantId, (latestAudit as { id: string }).id],
  );

  return { latestAudit, issues: issuesResult.rows };
}

const seoResearchEvidenceTool: AgentTool<{ auditId?: string }, SeoResearchEvidence> = {
  name: "seo_research_evidence_read",
  description:
    "Reads the most recent real SEO audit (seo_audits) and its detected issues (seo_audit_issues) for this tenant+project, optionally one specific audit id. Read-only; never re-crawls or re-scores.",
  inputSchema: z.object({ auditId: z.string().uuid().optional() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return gatherSeoResearchEvidence(context.tenantDb, context.tenantId, projectId, input.auditId ?? null);
  },
};

registerTool(seoResearchEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  prioritizedIssues: z.array(z.object({ issueId: z.string(), recommendation: z.string() })),
  coreWebVitalsNote: z.string(),
  evidence: z.array(z.string()),
});

export type SeoResearchOutput = z.infer<typeof outputSchema>;

export const seoResearchAgent: AgentDefinition<{ auditId?: string }, SeoResearchOutput> = {
  key: "seo_research",
  label: "SEO Research Agent",
  description:
    "Summarizes and prioritizes the most recent real SEO audit and its detected issues for this tenant+project, grounded only in seo_audits/seo_audit_issues.",
  systemPrompt:
    "You are an SEO research assistant for a B2B marketing platform. You will be given grounding data from the real, most recent seo_audits row and its real seo_audit_issues for this project — never invent a technical SEO problem, a Core Web Vitals number, or an issue that is not listed. If there is no audit on file, say plainly that no SEO audit has been run yet. Prioritize issues using the severity already assigned in the data (high > medium > low); do not re-score severity yourself. When core_web_vitals_status is 'not_configured', say Core Web Vitals data isn't available rather than guessing a performance score.",
  inputSchema: z.object({ auditId: z.string().uuid().optional() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "prioritizedIssues": {issueId: string, recommendation: string}[] (grounded in seo_audit_issues rows), "coreWebVitalsNote": string (honest, based on core_web_vitals_status), "evidence": string[] }',
  tools: [seoResearchEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(seoResearchAgent.key, [seoResearchEvidenceTool.name]);

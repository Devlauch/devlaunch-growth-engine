import type pg from "pg";

/**
 * AI Growth Advisor: a small set of deterministic rules, each backed by one
 * real SQL aggregation against genuinely existing tables — never an LLM
 * call, never an invented number. Same honesty convention as every other
 * "AI agent" in this codebase (growthAnalyzer.ts, marketingQa.ts,
 * nextBestAction.ts).
 *
 * Every rule requires a real minimum sample size before it can fire, so a
 * tenant with too little data never gets a noisy/statistically-meaningless
 * recommendation. A rule that can match more than one concrete entity in a
 * project (a specific prospecting campaign, a specific landing page) returns
 * one Recommendation per matching entity, with the entity's id folded into
 * `ruleKey` (e.g. `high_invalid_email_rate:<campaignId>`) so each instance
 * upserts independently in runGrowthAdvisor below. A project-level,
 * singleton rule (e.g. `too_many_unassigned_leads`) returns at most one.
 *
 * Explicitly NOT implemented here, and why (see docs/FEATURE_STATUS.md's own
 * documented gaps for the same honesty convention):
 *   - "Landing page traffic but few leads" / generic website traffic vs.
 *     lead-volume rule — no real pageview/visitor-tracking table exists
 *     outside of landing_page_events (which is scoped to a specific landing
 *     page's own page_view/form_submit events, used by the
 *     weak_landing_page_conversion rule below). FEATURE_STATUS.md already
 *     documents this exact gap: "the existing 'website traffic' number is a
 *     UTM/lead proxy, not real analytics." Fabricating a generic traffic
 *     number here would violate the platform's no-fabrication rule.
 *   - "Campaign generates meetings but few opportunities" — meetings and
 *     deals both key off `lead_id` only; there is no `campaign_id` column on
 *     either table, and the existing `campaign_attribution` view (migration
 *     276) rolls up campaign_members/sequence_enrollments/lead_replies, not
 *     meetings/deals. Computing "meetings per campaign" would require
 *     inventing a join this schema doesn't support — skipped rather than
 *     faked.
 */

export type RecommendationSeverity = "low" | "medium" | "high";

export interface RecommendationInput {
  ruleKey: string;
  severity: RecommendationSeverity;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  suggestedAction?: Record<string, unknown> | null;
}

export type GrowthAdvisorRule = (
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
) => Promise<RecommendationInput[]>;

// ---------------------------------------------------------------------------
// Rule 1: a prospecting campaign's discovered contacts have a high invalid-
// email rate. Backed by prospecting_campaigns (323_create_prospecting_
// campaigns.sql) -> discovered_organizations.prospecting_campaign_id ->
// discovered_contacts.verification_status (set by apps/api/src/lib/
// emailVerification.ts's real DNS/MX + syntax check). Requires at least 20
// contacts with an email before it can fire, so one or two bad addresses on
// a brand-new campaign never trips it.
const MIN_EMAIL_SAMPLE = 20;
const INVALID_EMAIL_RATE_THRESHOLD = 0.2;

export const highInvalidEmailRateRule: GrowthAdvisorRule = async (tenantDb, tenantId, projectId) => {
  const result = await tenantDb.query<{
    campaign_id: string;
    campaign_name: string;
    total_with_email: string;
    invalid_count: string;
  }>(
    `SELECT pc.id AS campaign_id, pc.name AS campaign_name,
            count(dc.id) FILTER (WHERE dc.email IS NOT NULL) AS total_with_email,
            count(dc.id) FILTER (WHERE dc.email IS NOT NULL AND dc.verification_status = 'invalid') AS invalid_count
     FROM prospecting_campaigns pc
     JOIN discovered_organizations do_ ON do_.prospecting_campaign_id = pc.id AND do_.tenant_id = pc.tenant_id
     JOIN discovered_contacts dc ON dc.organization_id = do_.id AND dc.tenant_id = pc.tenant_id
     WHERE pc.tenant_id = $1 AND pc.project_id = $2
     GROUP BY pc.id, pc.name`,
    [tenantId, projectId],
  );

  const recommendations: RecommendationInput[] = [];
  for (const row of result.rows) {
    const totalWithEmail = Number(row.total_with_email);
    const invalidCount = Number(row.invalid_count);
    if (totalWithEmail < MIN_EMAIL_SAMPLE) continue;
    const invalidRate = invalidCount / totalWithEmail;
    if (invalidRate <= INVALID_EMAIL_RATE_THRESHOLD) continue;

    recommendations.push({
      ruleKey: `high_invalid_email_rate:${row.campaign_id}`,
      severity: invalidRate > 0.4 ? "high" : "medium",
      title: `Prospecting campaign "${row.campaign_name}" has a high invalid-email rate`,
      description:
        `${invalidCount} of ${totalWithEmail} discovered contacts with an email address ` +
        `(${(invalidRate * 100).toFixed(1)}%) failed email verification (syntax/MX check) for ` +
        `campaign "${row.campaign_name}". Consider reviewing this campaign's discovery sources.`,
      evidence: {
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        totalWithEmail,
        invalidCount,
        invalidRate,
        threshold: INVALID_EMAIL_RATE_THRESHOLD,
        minSampleSize: MIN_EMAIL_SAMPLE,
      },
    });
  }
  return recommendations;
};

// ---------------------------------------------------------------------------
// Rule 2: too many leads have never been assigned to a rep. Backed by
// leads (015_create_leads.sql) + lead_assignments (279_create_lead_
// assignments.sql) — a lead counts as unassigned if it has zero rows in
// lead_assignments at all. Excludes leads already rejected/archived (dead,
// not actionable). Requires at least 10 unassigned leads.
const MIN_UNASSIGNED_LEADS = 10;
const MAX_SUGGESTED_ASSIGN_LEAD_IDS = 50;

export const tooManyUnassignedLeadsRule: GrowthAdvisorRule = async (tenantDb, tenantId, projectId) => {
  const result = await tenantDb.query<{ lead_id: string }>(
    `SELECT l.id AS lead_id
     FROM leads l
     WHERE l.tenant_id = $1 AND l.project_id = $2
       AND l.status NOT IN ('rejected', 'archived')
       AND NOT EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = l.id)
     ORDER BY l.created_at ASC`,
    [tenantId, projectId],
  );

  const unassignedLeadIds = result.rows.map((r) => r.lead_id);
  if (unassignedLeadIds.length < MIN_UNASSIGNED_LEADS) return [];

  const suggestedLeadIds = unassignedLeadIds.slice(0, MAX_SUGGESTED_ASSIGN_LEAD_IDS);

  return [
    {
      ruleKey: "too_many_unassigned_leads",
      severity: unassignedLeadIds.length >= 25 ? "high" : "medium",
      title: `${unassignedLeadIds.length} leads have never been assigned to a rep`,
      description:
        `This project has ${unassignedLeadIds.length} active leads with no entry in lead_assignments at all. ` +
        `Unowned leads are the single highest-leverage gap this platform's own audit has flagged before ` +
        `(scoring and CRM "never talk to each other"). A round-robin auto-assign action can be prepared for ` +
        `human approval below.`,
      evidence: {
        unassignedCount: unassignedLeadIds.length,
        sampleLeadIds: unassignedLeadIds.slice(0, 20),
        minThreshold: MIN_UNASSIGNED_LEADS,
      },
      suggestedAction: {
        actionType: "auto_assign_leads",
        leadIds: suggestedLeadIds,
        truncated: unassignedLeadIds.length > suggestedLeadIds.length,
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Rule 3: a landing page's tracked visitors rarely convert. Backed by
// landing_pages + landing_page_events (263/266_create_landing_pages.sql /
// _landing_page_events.sql) — real, publicly-tracked page_view/form_submit
// counts (apps/api/src/routes/publicLandingPages.ts), never estimated.
// Requires at least 50 real page_view events on that page.
const MIN_PAGE_VIEWS = 50;
const WEAK_CONVERSION_RATE_THRESHOLD = 0.02;

export const weakLandingPageConversionRule: GrowthAdvisorRule = async (tenantDb, tenantId, projectId) => {
  const result = await tenantDb.query<{
    landing_page_id: string;
    title: string;
    views: string;
    submits: string;
  }>(
    `SELECT lp.id AS landing_page_id, lp.title,
            count(e.id) FILTER (WHERE e.event_type = 'page_view') AS views,
            count(e.id) FILTER (WHERE e.event_type = 'form_submit') AS submits
     FROM landing_pages lp
     JOIN landing_page_events e ON e.landing_page_id = lp.id AND e.tenant_id = lp.tenant_id
     WHERE lp.tenant_id = $1 AND lp.project_id = $2
     GROUP BY lp.id, lp.title`,
    [tenantId, projectId],
  );

  const recommendations: RecommendationInput[] = [];
  for (const row of result.rows) {
    const views = Number(row.views);
    const submits = Number(row.submits);
    if (views < MIN_PAGE_VIEWS) continue;
    const conversionRate = submits / views;
    if (conversionRate >= WEAK_CONVERSION_RATE_THRESHOLD) continue;

    recommendations.push({
      ruleKey: `weak_landing_page_conversion:${row.landing_page_id}`,
      severity: conversionRate < 0.005 ? "high" : "medium",
      title: `Landing page "${row.title}" is converting below ${(WEAK_CONVERSION_RATE_THRESHOLD * 100).toFixed(0)}%`,
      description:
        `${submits} of ${views} real tracked page views (${(conversionRate * 100).toFixed(2)}%) resulted in a ` +
        `form submission for landing page "${row.title}". Consider reviewing its copy/offer or running an A/B test.`,
      evidence: {
        landingPageId: row.landing_page_id,
        title: row.title,
        views,
        submits,
        conversionRate,
        threshold: WEAK_CONVERSION_RATE_THRESHOLD,
        minSampleSize: MIN_PAGE_VIEWS,
      },
    });
  }
  return recommendations;
};

// ---------------------------------------------------------------------------
// Rule 4: leads a human already marked 'qualified' are stuck with no deal
// ever created for them. Backed by leads.status (015_create_leads.sql) +
// deals.lead_id (278_create_deals.sql). Requires at least 5 such leads.
const MIN_STUCK_QUALIFIED_LEADS = 5;

export const qualifiedLeadsNotConvertingToDealsRule: GrowthAdvisorRule = async (tenantDb, tenantId, projectId) => {
  const result = await tenantDb.query<{ lead_id: string }>(
    `SELECT l.id AS lead_id
     FROM leads l
     WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.status = 'qualified'
       AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id)
     ORDER BY l.created_at ASC`,
    [tenantId, projectId],
  );

  const stuckLeadIds = result.rows.map((r) => r.lead_id);
  if (stuckLeadIds.length < MIN_STUCK_QUALIFIED_LEADS) return [];

  return [
    {
      ruleKey: "qualified_leads_not_converting_to_deals",
      severity: stuckLeadIds.length >= 15 ? "high" : "medium",
      title: `${stuckLeadIds.length} qualified leads have no deal in the pipeline`,
      description:
        `${stuckLeadIds.length} leads with status = 'qualified' have no row in deals at all — qualification is ` +
        `not translating into a tracked sales opportunity. Consider promoting these to the CRM pipeline.`,
      evidence: {
        stuckCount: stuckLeadIds.length,
        sampleLeadIds: stuckLeadIds.slice(0, 20),
        minThreshold: MIN_STUCK_QUALIFIED_LEADS,
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Rule 5: the most recent SEO audit for this project still has unresolved
// high-severity issues. Backed by seo_audits + seo_audit_issues
// (076/077_create_seo_audits.sql / _seo_audit_issues.sql) — real broken-
// link/metadata/sitemap findings (apps/api/src/lib/siteAudit.ts), never
// estimated. Requires that at least one audit has actually been run (the
// "minimum sample size" here), and at least 3 high-severity issues on the
// latest one.
const MIN_HIGH_SEVERITY_ISSUES = 3;

export const unresolvedHighSeverityCrawlIssuesRule: GrowthAdvisorRule = async (tenantDb, tenantId, projectId) => {
  const result = await tenantDb.query<{
    audit_id: string;
    domain: string;
    audited_at: string;
    high_count: string;
  }>(
    `SELECT sa.id AS audit_id, sa.domain, sa.audited_at,
            count(i.id) FILTER (WHERE i.severity = 'high') AS high_count
     FROM seo_audits sa
     LEFT JOIN seo_audit_issues i ON i.audit_id = sa.id AND i.tenant_id = sa.tenant_id
     WHERE sa.tenant_id = $1 AND sa.project_id = $2
     GROUP BY sa.id, sa.domain, sa.audited_at
     ORDER BY sa.audited_at DESC
     LIMIT 1`,
    [tenantId, projectId],
  );

  const latest = result.rows[0];
  if (!latest) return [];
  const highCount = Number(latest.high_count);
  if (highCount < MIN_HIGH_SEVERITY_ISSUES) return [];

  return [
    {
      ruleKey: "unresolved_high_severity_seo_issues",
      severity: highCount >= 8 ? "high" : "medium",
      title: `${highCount} unresolved high-severity SEO issues on ${latest.domain}`,
      description:
        `The most recent SEO audit (run ${new Date(latest.audited_at).toISOString()}) for ${latest.domain} found ` +
        `${highCount} high-severity issues (broken links / missing titles-descriptions / missing sitemap or robots.txt). ` +
        `These can directly suppress organic search visibility.`,
      evidence: {
        auditId: latest.audit_id,
        domain: latest.domain,
        auditedAt: latest.audited_at,
        highSeverityIssueCount: highCount,
        minThreshold: MIN_HIGH_SEVERITY_ISSUES,
      },
    },
  ];
};

export const GROWTH_ADVISOR_RULES: GrowthAdvisorRule[] = [
  highInvalidEmailRateRule,
  tooManyUnassignedLeadsRule,
  weakLandingPageConversionRule,
  qualifiedLeadsNotConvertingToDealsRule,
  unresolvedHighSeverityCrawlIssuesRule,
];

export interface GrowthRecommendationRow {
  id: string;
  tenant_id: string;
  project_id: string;
  rule_key: string;
  severity: RecommendationSeverity;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: "new" | "acknowledged" | "dismissed" | "actioned";
  suggested_action: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

const RECOMMENDATION_COLUMNS =
  "id, tenant_id, project_id, rule_key, severity, title, description, evidence, status, suggested_action, created_at, updated_at";

/**
 * Runs every rule for this tenant/project (inside the caller's own
 * tenant-scoped transaction — callers must already have `tenantDb` from
 * `req.tenantDb` or `withTenantContext`), and upserts the result: if an open
 * (status = 'new' or 'acknowledged') recommendation already exists for the
 * same rule_key, its evidence/title/description/severity/suggested_action
 * are refreshed in place (never a duplicate row); otherwise a new row is
 * inserted. A rule_key no longer produced by this run is left untouched
 * (e.g. a dismissed row stays dismissed; a previously-open row for a
 * condition that has since resolved itself is NOT auto-resolved here — a
 * human dismisses it, same convention as the `approvals` queue never
 * auto-expiring a pending row on its own).
 */
export async function runGrowthAdvisor(
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
): Promise<GrowthRecommendationRow[]> {
  const allInputs: RecommendationInput[] = [];
  for (const rule of GROWTH_ADVISOR_RULES) {
    const inputs = await rule(tenantDb, tenantId, projectId);
    allInputs.push(...inputs);
  }

  const upserted: GrowthRecommendationRow[] = [];
  for (const input of allInputs) {
    const existing = await tenantDb.query<{ id: string }>(
      `SELECT id FROM growth_advisor_recommendations
       WHERE tenant_id = $1 AND project_id = $2 AND rule_key = $3 AND status IN ('new', 'acknowledged')`,
      [tenantId, projectId, input.ruleKey],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      const updated = await tenantDb.query<GrowthRecommendationRow>(
        `UPDATE growth_advisor_recommendations
         SET severity = $4, title = $5, description = $6, evidence = $7::jsonb, suggested_action = $8::jsonb
         WHERE id = $1 AND tenant_id = $2 AND project_id = $3
         RETURNING ${RECOMMENDATION_COLUMNS}`,
        [
          existing.rows[0].id,
          tenantId,
          projectId,
          input.severity,
          input.title,
          input.description,
          JSON.stringify(input.evidence),
          input.suggestedAction ? JSON.stringify(input.suggestedAction) : null,
        ],
      );
      upserted.push(updated.rows[0]);
    } else {
      const inserted = await tenantDb.query<GrowthRecommendationRow>(
        `INSERT INTO growth_advisor_recommendations
           (tenant_id, project_id, rule_key, severity, title, description, evidence, suggested_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         RETURNING ${RECOMMENDATION_COLUMNS}`,
        [
          tenantId,
          projectId,
          input.ruleKey,
          input.severity,
          input.title,
          input.description,
          JSON.stringify(input.evidence),
          input.suggestedAction ? JSON.stringify(input.suggestedAction) : null,
        ],
      );
      upserted.push(inserted.rows[0]);
    }
  }

  return upserted;
}

export { RECOMMENDATION_COLUMNS };

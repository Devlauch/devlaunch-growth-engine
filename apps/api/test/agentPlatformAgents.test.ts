import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

// Same mocked-pg-client unit-test style as crmDashboard.test.ts's "direct
// unit test against a fake client" describe block / campaignAttribution.test.ts:
// a plain `{ query: queryMock }` cast to PoolClient, with queryMock queued
// via mockResolvedValueOnce in call order. No real Postgres, no route/
// supertest harness — these are direct unit tests of the gatherXEvidence()
// functions themselves (each agent's AgentTool.execute is a thin wrapper
// around one of these).
const queryMock = vi.fn();

beforeEach(() => {
  queryMock.mockReset();
});

function fakeClient(): PoolClient {
  return { query: queryMock } as unknown as PoolClient;
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

describe("gatherLeadQualificationEvidence", () => {
  it("reads the real lead row and its real lead_scores row", async () => {
    const { gatherLeadQualificationEvidence } = await import(
      "../src/lib/agentPlatform/agents/leadQualificationAgent.js"
    );
    const LEAD_1 = "44444444-4444-4444-4444-444444444444";

    queueResponses([
      { rowCount: 1, rows: [{ id: LEAD_1, name: "Jane Buyer", company_id: null, status: "qualified" }] },
      {
        rowCount: 1,
        rows: [
          {
            lead_id: LEAD_1,
            total_score: 82,
            criteria_evidence: { title_match: { score: 40, maxScore: 40, hasEvidence: true } },
            why_summary: "Matched 2 of 2 criteria",
            next_research_note: "Confirm budget authority",
          },
        ],
      },
    ]);

    const result = await gatherLeadQualificationEvidence(fakeClient(), TENANT_A, PROJECT_1, LEAD_1);

    expect(result.lead).toMatchObject({ id: LEAD_1, name: "Jane Buyer" });
    expect(result.score).toMatchObject({ total_score: 82, why_summary: "Matched 2 of 2 criteria" });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("reports null lead and null score when the lead does not exist in this tenant/project", async () => {
    const { gatherLeadQualificationEvidence } = await import(
      "../src/lib/agentPlatform/agents/leadQualificationAgent.js"
    );
    queueResponses([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);

    const result = await gatherLeadQualificationEvidence(fakeClient(), TENANT_A, PROJECT_1, "missing-lead");

    expect(result.lead).toBeNull();
    expect(result.score).toBeNull();
  });
});

describe("gatherSeoResearchEvidence", () => {
  it("joins the latest seo_audits row with its seo_audit_issues", async () => {
    const { gatherSeoResearchEvidence } = await import("../src/lib/agentPlatform/agents/seoResearchAgent.js");
    const AUDIT_1 = "55555555-5555-5555-5555-555555555555";

    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: AUDIT_1,
            domain: "acme.com",
            audited_at: "2026-02-01T00:00:00Z",
            sitemap_found: true,
            robots_found: true,
            pages_checked: 40,
            broken_links_count: 3,
            missing_meta_count: 1,
            core_web_vitals: null,
            core_web_vitals_status: "not_configured",
          },
        ],
      },
      {
        rowCount: 1,
        rows: [{ id: "issue-1", issue_type: "broken_link", url: "/pricing", detail: "404", severity: "high" }],
      },
    ]);

    const result = await gatherSeoResearchEvidence(fakeClient(), TENANT_A, PROJECT_1, null);

    expect(result.latestAudit).toMatchObject({ id: AUDIT_1, domain: "acme.com" });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ severity: "high" });
  });

  it("returns no issues when there is no audit on file (second query never runs)", async () => {
    const { gatherSeoResearchEvidence } = await import("../src/lib/agentPlatform/agents/seoResearchAgent.js");
    queueResponses([{ rowCount: 0, rows: [] }]);

    const result = await gatherSeoResearchEvidence(fakeClient(), TENANT_A, PROJECT_1, null);

    expect(result.latestAudit).toBeNull();
    expect(result.issues).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("gatherEmailCampaignEvidence", () => {
  it("delegates straight to campaignAttribution.ts's getCampaignAttribution", async () => {
    const { gatherEmailCampaignEvidence } = await import("../src/lib/agentPlatform/agents/emailCampaignAgent.js");
    const CAMPAIGN_1 = "77777777-7777-7777-7777-777777777777";

    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            campaign_id: CAMPAIGN_1,
            campaign_name: "Q1 outbound",
            campaign_status: "approved",
            campaign_channel: "email",
            member_count: "10",
            active_member_count: "9",
            sequence_enrollment_count: "8",
            sequence_active_count: "2",
            sequence_completed_count: "6",
            conversion_count: "1",
            unsubscribed_count: "1",
            bounced_count: "0",
            stopped_for_reply_count: "3",
            reply_count: "4",
            interested_reply_count: "1",
            unsubscribe_reply_count: "1",
            not_now_reply_count: "1",
            wrong_person_reply_count: "1",
          },
        ],
      },
    ]);

    const result = await gatherEmailCampaignEvidence(fakeClient(), TENANT_A, PROJECT_1, CAMPAIGN_1);

    // getCampaignAttribution coerces every COUNT(...) column to a real number.
    expect(result).toMatchObject({ campaign_id: CAMPAIGN_1, member_count: 10, conversion_count: 1 });
  });

  it("returns null for a campaign with no attribution row", async () => {
    const { gatherEmailCampaignEvidence } = await import("../src/lib/agentPlatform/agents/emailCampaignAgent.js");
    queueResponses([{ rowCount: 0, rows: [] }]);

    const result = await gatherEmailCampaignEvidence(fakeClient(), TENANT_A, PROJECT_1, "missing-campaign");

    expect(result).toBeNull();
  });
});

describe("gatherGrowthAdvisorEvidence", () => {
  it("reads only currently-open (new/acknowledged) growth_advisor_recommendations rows", async () => {
    const { gatherGrowthAdvisorEvidence } = await import(
      "../src/lib/agentPlatform/agents/growthAdvisorLlmAgent.js"
    );

    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: "rec-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            rule_key: "too_many_unassigned_leads",
            severity: "high",
            title: "12 unassigned qualified leads",
            description: "...",
            evidence: { count: 12 },
            status: "new",
            suggested_action: null,
            created_at: "2026-02-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
          },
        ],
      },
    ]);

    const result = await gatherGrowthAdvisorEvidence(fakeClient(), TENANT_A, PROJECT_1, null);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({ rule_key: "too_many_unassigned_leads", severity: "high" });
    // the query itself must filter to open statuses only, server-side
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status IN \('new', 'acknowledged'\)/);
  });

  it("reports an empty recommendations array when nothing is currently open", async () => {
    const { gatherGrowthAdvisorEvidence } = await import(
      "../src/lib/agentPlatform/agents/growthAdvisorLlmAgent.js"
    );
    queueResponses([{ rowCount: 0, rows: [] }]);

    const result = await gatherGrowthAdvisorEvidence(fakeClient(), TENANT_A, PROJECT_1, null);

    expect(result.recommendations).toEqual([]);
  });
});

describe("gatherSocialMediaStrategyEvidence", () => {
  it("delegates straight to socialContentCalendar.ts's getCalendarForProject", async () => {
    const { gatherSocialMediaStrategyEvidence } = await import(
      "../src/lib/agentPlatform/agents/socialMediaStrategyAgent.js"
    );

    queueResponses([
      {
        rowCount: 1,
        rows: [{ id: "post-1", tenant_id: TENANT_A, project_id: PROJECT_1, platform: "linkedin", status: "published" }],
      },
    ]);

    const result = await gatherSocialMediaStrategyEvidence(fakeClient(), TENANT_A, PROJECT_1, null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ platform: "linkedin" });
  });
});

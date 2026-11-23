import { describe, it, expect, vi } from "vitest";
import { computeIcpConversionPerformance, buildIcpRefinementSummary } from "../src/lib/icpRefinement.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const ICP_1 = "44444444-4444-4444-4444-444444444444";
const ICP_2 = "44444444-4444-4444-4444-444444444445";

function fakeTenantDb(rows: unknown[]) {
  const query = vi.fn().mockResolvedValueOnce({ rows });
  return { query } as unknown as import("pg").PoolClient;
}

describe("computeIcpConversionPerformance", () => {
  it("returns an honest zero-signal row for a profile with no matched leads", async () => {
    const tenantDb = fakeTenantDb([
      {
        icp_profile_id: ICP_1,
        icp_profile_name: "Working professionals",
        matched_leads: 0,
        qualified_leads: 0,
        deals_count: 0,
        deals_won: 0,
        deals_lost: 0,
        won_value: 0,
      },
    ]);

    const result = await computeIcpConversionPerformance(tenantDb, TENANT_A, PROJECT_1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      icpProfileId: ICP_1,
      matchedLeads: 0,
      conversionRatePct: null,
    });
    expect(result[0].signal).toContain("No leads have matched");

    // Queries the existing icp_match_scores/leads/deals tables scoped to tenant+project, no new table.
    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM icp_profiles icp"),
      [TENANT_A, PROJECT_1],
    );
  });

  it("reports leads-matched-but-no-deals-yet honestly, without inventing a conversion rate", async () => {
    const tenantDb = fakeTenantDb([
      {
        icp_profile_id: ICP_1,
        icp_profile_name: "Agencies",
        matched_leads: 5,
        qualified_leads: 2,
        deals_count: 0,
        deals_won: 0,
        deals_lost: 0,
        won_value: 0,
      },
    ]);

    const result = await computeIcpConversionPerformance(tenantDb, TENANT_A, PROJECT_1);
    expect(result[0].matchedLeads).toBe(5);
    // matchedLeads > 0 so a rate IS computed (0%, since no deals exist yet) — it's the
    // signal text, not the rate itself, that must avoid implying a real conversion outcome.
    expect(result[0].conversionRatePct).toBe(0);
    expect(result[0].signal).toContain("too early to score conversion");
  });

  it("computes a real conversion rate from matched leads vs. won deals", async () => {
    const tenantDb = fakeTenantDb([
      {
        icp_profile_id: ICP_1,
        icp_profile_name: "Enterprise SaaS",
        matched_leads: 10,
        qualified_leads: 6,
        deals_count: 4,
        deals_won: 3,
        deals_lost: 1,
        won_value: "45000.00",
      },
    ]);

    const result = await computeIcpConversionPerformance(tenantDb, TENANT_A, PROJECT_1);
    expect(result[0].conversionRatePct).toBe(30);
    expect(result[0].wonValue).toBe(45000);
    expect(result[0].signal).toContain("30%");
    expect(result[0].signal).toContain("re-prioritizing prospecting toward");
  });

  it("handles numeric-as-string aggregate results from pg without throwing", async () => {
    const tenantDb = fakeTenantDb([
      {
        icp_profile_id: ICP_1,
        icp_profile_name: "Startups",
        matched_leads: "7",
        qualified_leads: "1",
        deals_count: "2",
        deals_won: "0",
        deals_lost: "2",
        won_value: null,
      },
    ]);

    const result = await computeIcpConversionPerformance(tenantDb, TENANT_A, PROJECT_1);
    expect(result[0].matchedLeads).toBe(7);
    expect(result[0].dealsLost).toBe(2);
    expect(result[0].wonValue).toBe(0);
    expect(result[0].conversionRatePct).toBe(0);
    expect(result[0].signal).toContain("re-examining whether to keep targeting");
  });
});

describe("buildIcpRefinementSummary", () => {
  it("says so honestly when there are no ICP profiles at all", () => {
    expect(buildIcpRefinementSummary([])).toContain("No ICP profiles exist");
  });

  it("says so honestly when no profile has any matched leads yet", () => {
    const summary = buildIcpRefinementSummary([
      {
        icpProfileId: ICP_1,
        icpProfileName: "A",
        matchedLeads: 0,
        qualifiedLeads: 0,
        dealsCount: 0,
        dealsWon: 0,
        dealsLost: 0,
        wonValue: 0,
        conversionRatePct: null,
        signal: "No leads have matched the \"A\" ICP profile yet — not enough data to refine this persona.",
      },
    ]);
    expect(summary).toContain("No leads have matched any ICP profile yet");
  });

  it("ranks two profiles with real data and recommends the better-converting one", () => {
    const summary = buildIcpRefinementSummary([
      {
        icpProfileId: ICP_1,
        icpProfileName: "Enterprise",
        matchedLeads: 10,
        qualifiedLeads: 6,
        dealsCount: 4,
        dealsWon: 4,
        dealsLost: 0,
        wonValue: 100000,
        conversionRatePct: 40,
        signal: "x",
      },
      {
        icpProfileId: ICP_2,
        icpProfileName: "Hobbyists",
        matchedLeads: 10,
        qualifiedLeads: 1,
        dealsCount: 2,
        dealsWon: 0,
        dealsLost: 2,
        wonValue: 0,
        conversionRatePct: 0,
        signal: "y",
      },
    ]);
    expect(summary).toContain("Enterprise");
    expect(summary).toContain("converts best");
    expect(summary).toContain("Hobbyists");
    expect(summary).toContain("converts worst");
    expect(summary).toContain('shifting future prospecting-campaign targeting toward "Enterprise"');
  });
});

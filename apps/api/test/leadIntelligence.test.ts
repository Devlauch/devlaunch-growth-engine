import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / scoring.test.ts: fake the pg
// pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { leadIntelligenceRouter } = await import("../src/routes/leadIntelligence.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { matchLeadToIcp } = await import("../src/lib/icpMatching.js");
const { detectBuyingSignals } = await import("../src/lib/buyingSignals.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/intelligence",
    leadIntelligenceRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "88888888-8888-8888-8888-888888888888";
const ICP_1 = "99999999-9999-9999-9999-999999999999";
const ORG_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

// ---------------------------------------------------------------------------
// matchLeadToIcp (pure function)
// ---------------------------------------------------------------------------

describe("matchLeadToIcp", () => {
  it("scores 0 and gives no reasons when nothing in the lead matches the ICP", () => {
    const lead = { custom_fields: { role: "Accountant" }, message: "Just browsing, no real need." };
    const icpProfile = {
      segment: "Career switchers",
      pain_points: ["re-skilling for a new career", "imposter syndrome"],
      channels: ["linkedin ads"],
    };

    const result = matchLeadToIcp(lead, icpProfile);

    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("gives a positive score and real reasons when the lead's data mentions the ICP's segment/pain points", () => {
    const lead = {
      custom_fields: { note: "Looking to re-skilling into tech after a layoff" },
      message: "I'm a career switcher exploring bootcamps.",
    };
    const icpProfile = {
      segment: "Career switchers",
      pain_points: ["re-skilling", "imposter syndrome"],
      channels: ["linkedin ads"],
    };

    const result = matchLeadToIcp(lead, icpProfile);

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.toLowerCase().includes("segment"))).toBe(true);
    expect(result.reasons.some((r) => r.toLowerCase().includes("pain point"))).toBe(true);
  });

  it("caps the total score at 100 even with many real matches", () => {
    const lead = {
      custom_fields: {},
      message: "enterprise segment buyers mention budget timeline procurement compliance security onboarding",
    };
    const icpProfile = {
      segment: "enterprise segment",
      pain_points: ["budget", "timeline", "procurement", "compliance", "security", "onboarding"],
      channels: ["buyers"],
    };

    const result = matchLeadToIcp(lead, icpProfile);

    expect(result.score).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// detectBuyingSignals (pure function)
// ---------------------------------------------------------------------------

describe("detectBuyingSignals", () => {
  it("detects a hiring signal", () => {
    const signals = detectBuyingSignals("We're hiring across the engineering team this quarter.");
    expect(signals.some((s) => s.signalType === "hiring")).toBe(true);
  });

  it("detects a funding signal with high confidence for a specific round", () => {
    const signals = detectBuyingSignals("Thrilled to announce our Series B funding round.");
    const fundingSignal = signals.find((s) => s.signalType === "funding");
    expect(fundingSignal).toBeDefined();
    expect(fundingSignal?.confidence).toBe("high");
  });

  it("detects an expansion signal", () => {
    const signals = detectBuyingSignals("We are now expanding to the European market with a new office.");
    expect(signals.some((s) => s.signalType === "expansion")).toBe(true);
  });

  it("detects a leadership_change signal", () => {
    const signals = detectBuyingSignals("The board announced our new CEO starting next month.");
    expect(signals.some((s) => s.signalType === "leadership_change")).toBe(true);
  });

  it("detects a product_launch signal", () => {
    const signals = detectBuyingSignals("Introducing our newest feature, now available to all customers.");
    expect(signals.some((s) => s.signalType === "product_launch")).toBe(true);
  });

  it("returns no signals for text with none of the known phrases", () => {
    const signals = detectBuyingSignals("Just a quiet Tuesday update with nothing notable happening.");
    expect(signals).toHaveLength(0);
  });

  it("returns no signals for empty text", () => {
    expect(detectBuyingSignals("")).toHaveLength(0);
  });

  it("attaches the given sourceUrl to each detected signal", () => {
    const signals = detectBuyingSignals("We're hiring!", "https://example.com/careers");
    expect(signals[0]?.sourceUrl).toBe("https://example.com/careers");
  });
});

// ---------------------------------------------------------------------------
// POST /enrich — domain-then-name match order (mirrors scoreLead.ts's
// recompute route test pattern)
// ---------------------------------------------------------------------------

describe("POST /enrich", () => {
  it("matches by normalized email domain before falling back to company name", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, email: "jane@acme.com", company: "Acme Corp", custom_fields: {} }],
      }, // lead exists
      {
        rowCount: 1,
        rows: [{ id: ORG_1, name: "Acme Corp", domain: "acme.com", raw_metadata: { industry: "software" } }],
      }, // matched by normalized_domain (name-based lookup never runs)
      {
        rowCount: 1,
        rows: [
          {
            id: "enrich-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            matched_organization_id: ORG_1,
            domain: "acme.com",
            firmographics: { domain: "acme.com", matchedOrganizationName: "Acme Corp" },
            data_sources: ["lead.email:domain", "discovered_organizations:domain_match"],
          },
        ],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/enrich`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    expect(res.body.enrichment.matched_organization_id).toBe(ORG_1);

    // Only one discovered_organizations lookup happened, and it was the
    // domain lookup, not the name lookup.
    const orgLookupCalls = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("FROM discovered_organizations"),
    );
    expect(orgLookupCalls).toHaveLength(1);
    expect(orgLookupCalls[0][0]).toContain("normalized_domain");
  });

  it("falls back to company-name matching when there is no email domain match", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, email: null, company: "Acme Corp", custom_fields: {} }],
      }, // lead exists, no email so no domain lookup at all
      {
        rowCount: 1,
        rows: [{ id: ORG_1, name: "Acme Corp", domain: "acme.com", raw_metadata: {} }],
      }, // matched by normalized_name
      {
        rowCount: 1,
        rows: [
          {
            id: "enrich-1",
            lead_id: LEAD_1,
            matched_organization_id: ORG_1,
            domain: "acme.com",
            firmographics: {},
            data_sources: ["discovered_organizations:name_match"],
          },
        ],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/enrich`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    const orgLookupCalls = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("FROM discovered_organizations"),
    );
    expect(orgLookupCalls).toHaveLength(1);
    expect(orgLookupCalls[0][0]).toContain("normalized_name");
  });

  it("404s when the lead doesn't exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead lookup fails
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/enrich`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /explain — graceful composition
// ---------------------------------------------------------------------------

describe("GET /explain", () => {
  it("composes a full summary when rubric score, ICP match, and buying signals all exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      { rowCount: 1, rows: [{ id: "score-1", lead_id: LEAD_1, total_score: "72", why_summary: "...", next_research_note: null }] }, // lead_scores
      {
        rowCount: 1,
        rows: [{ id: "match-1", icp_profile_id: ICP_1, icp_profile_name: "Career Switchers", match_score: "65", match_reasons: ["mentions re-skilling"] }],
      }, // icp_match_scores
      {
        rowCount: 1,
        rows: [{ id: "signal-1", signal_type: "hiring", detail: "Mentions hiring", confidence: "medium" }],
      }, // buying_signals
      { rowCount: 0, rows: [] }, // company_enrichment
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/explain`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.rubricScore.total_score).toBe("72");
    expect(res.body.icpMatches).toHaveLength(1);
    expect(res.body.buyingSignals).toHaveLength(1);
    expect(res.body.enrichment).toBeNull();
    expect(res.body.summary).toContain("72/100");
    expect(res.body.summary).toContain("Career Switchers");
    expect(res.body.summary).toContain("hiring");
  });

  it("gracefully omits clauses when nothing exists yet for the lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      { rowCount: 0, rows: [] }, // lead_scores
      { rowCount: 0, rows: [] }, // icp_match_scores
      { rowCount: 0, rows: [] }, // buying_signals
      { rowCount: 0, rows: [] }, // company_enrichment
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/explain`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.rubricScore).toBeNull();
    expect(res.body.icpMatches).toHaveLength(0);
    expect(res.body.buyingSignals).toHaveLength(0);
    expect(res.body.enrichment).toBeNull();
    expect(res.body.summary).toBe("No rubric score, ICP match, or buying signal is available yet for this lead.");
  });

  it("404s when the lead doesn't exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead lookup fails
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/explain`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /icp-match, POST /buying-signals — basic route wiring sanity checks
// ---------------------------------------------------------------------------

describe("POST /icp-match", () => {
  it("scores the lead against every ICP profile in the project and returns them sorted by score", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1, custom_fields: { note: "re-skilling into tech" }, message: null }] }, // lead
      { rowCount: 1, rows: [{ id: ICP_1, name: "Career Switchers", segment: "career switchers", pain_points: ["re-skilling"], channels: [] }] }, // icp_profiles
      {
        rowCount: 1,
        rows: [{ id: "match-1", lead_id: LEAD_1, icp_profile_id: ICP_1, match_score: 15, match_reasons: ["Lead's data mentions a pain point keyword from this ICP (\"re-skilling\")"] }],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/icp-match`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].match_score).toBe(15);
  });
});

describe("POST /buying-signals", () => {
  it("detects and persists signals from the supplied text", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      {
        rowCount: 1,
        rows: [{ id: "signal-1", signal_type: "hiring", detail: "Mentions \"hiring\"", confidence: "medium" }],
      }, // insert for the one detected signal
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/buying-signals`)
      .set("X-Dev-User-Id", USER_1)
      .send({ text: "We are hiring across the team." });

    expect(res.status).toBe(201);
    expect(res.body.signals).toHaveLength(1);
    expect(res.body.signals[0].signal_type).toBe("hiring");
  });

  it("rejects an empty text body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/intelligence/buying-signals`)
      .set("X-Dev-User-Id", USER_1)
      .send({ text: "" });

    expect(res.status).toBe(400);
  });
});

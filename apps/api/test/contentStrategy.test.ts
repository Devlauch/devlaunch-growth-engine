import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  buildBrandVoiceProfile,
  generateContentCalendar,
  repurposeContent,
  type ProjectProfileInput,
  type IcpProfileInput,
} from "../src/lib/contentGeneration.js";

// Same mocking pattern as discovery.test.ts / messaging.test.ts: fake the pg
// pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { contentCalendarsRouter, contentDraftsRouter } = await import("../src/routes/contentStrategy.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-calendars", contentCalendarsRouter);
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-drafts", contentDraftsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const ICP_1 = "77777777-7777-7777-7777-777777777777";
const CALENDAR_1 = "99999999-9999-9999-9999-999999999999";
const ITEM_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DRAFT_1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
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

const SAAS_PROFILE: ProjectProfileInput = {
  company_name: "Acme SaaS",
  industry: "saas",
  website_url: "https://acme.example",
  value_proposition: "A platform that helps revenue teams eliminate fragmented, manual reporting.",
  target_markets: ["north_america"],
};

const EDUCATION_PROFILE: ProjectProfileInput = {
  company_name: "DevPilot Academy",
  industry: "education",
  website_url: "https://devpilotacademy.example",
  value_proposition: "Hands-on, project-based courses that take learners to job-ready skills.",
  target_markets: [],
};

const SAAS_ICP: IcpProfileInput = {
  name: "Series A-B RevOps Leaders",
  segment: "revops_leaders",
  description: "VP/Director of RevOps at growth-stage B2B SaaS companies.",
  pain_points: [
    "pipeline data fragmented across CRM, spreadsheets, and BI tools",
    "no single source of truth for pipeline health",
    "a full day a week lost to manual reporting",
  ],
};

describe("buildBrandVoiceProfile", () => {
  it("derives a saas tone/vocabulary/anchor from project_profiles", () => {
    const voice = buildBrandVoiceProfile(SAAS_PROFILE, null);
    expect(voice.tone).toBe("direct, outcome-focused");
    expect(voice.vocabulary.length).toBeGreaterThan(0);
    expect(voice.anchorValueProp).toBe(SAAS_PROFILE.value_proposition);
  });

  it("derives an education tone distinct from saas", () => {
    const voice = buildBrandVoiceProfile(EDUCATION_PROFILE, null);
    expect(voice.tone).toBe("encouraging, practical");
    expect(voice.tone).not.toBe(buildBrandVoiceProfile(SAAS_PROFILE, null).tone);
  });

  it("folds in real ICP segment/pain_points when supplied", () => {
    const voice = buildBrandVoiceProfile(SAAS_PROFILE, SAAS_ICP);
    expect(voice.vocabulary).toContain("revops leaders");
    expect(voice.vocabulary).toContain(SAAS_ICP.pain_points![0]);
  });

  it("falls back to a general tone for an unmodeled/missing industry", () => {
    const voice = buildBrandVoiceProfile({ ...SAAS_PROFILE, industry: null }, null);
    expect(voice.tone).toBe("clear, professional");
  });
});

describe("generateContentCalendar", () => {
  it("produces a realistic cadence: ~3 linkedin/week, 1 blog/week, 1 email/week", () => {
    const items = generateContentCalendar(SAAS_PROFILE, SAAS_ICP, "2026-01-05");
    const byType = { linkedin_post: 0, blog: 0, email: 0 };
    for (const item of items) byType[item.contentType]++;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.dayOffset >= 0 && i.dayOffset < 30)).toBe(true);
    // 30 days / 7-day pattern (3 linkedin, 1 blog, 1 email per week) => roughly:
    expect(byType.linkedin_post).toBeGreaterThanOrEqual(10);
    expect(byType.blog).toBeGreaterThanOrEqual(3);
    expect(byType.email).toBeGreaterThanOrEqual(3);
  });

  it("rotates through ICP pain points instead of repeating the same one every time", () => {
    const items = generateContentCalendar(SAAS_PROFILE, SAAS_ICP, "2026-01-05");
    const linkedinBodies = items.filter((i) => i.contentType === "linkedin_post").map((i) => i.body);
    expect(linkedinBodies.length).toBeGreaterThanOrEqual(3);

    // Not every linkedin post should mention the same pain point verbatim.
    const mentionsFirstPain = linkedinBodies.filter((b) =>
      b.includes(SAAS_ICP.pain_points![0]),
    ).length;
    expect(mentionsFirstPain).toBeLessThan(linkedinBodies.length);
  });

  it("still generates real content with no ICP supplied (grounded in brand voice alone)", () => {
    const items = generateContentCalendar(SAAS_PROFILE, null, "2026-01-05");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.title.length > 0 && i.body.length > 0)).toBe(true);
  });
});

describe("repurposeContent", () => {
  const blogBody =
    "This is the opening paragraph that explains the core problem teams face today. It sets up the stakes clearly.\n\n" +
    "This second paragraph describes how the product solves that problem in practice. Teams see results quickly.\n\n" +
    "This third paragraph wraps up with a call to action for the reader to get in touch.";

  const brandVoice = buildBrandVoiceProfile(SAAS_PROFILE, null);

  it("extracts a linkedin hook from the blog's own first paragraph plus a CTA", () => {
    const [piece] = repurposeContent(blogBody, "blog", ["linkedin_post"], brandVoice);
    expect(piece.format).toBe("linkedin_post");
    expect(piece.body).toContain("opening paragraph that explains the core problem");
    expect(piece.body.toLowerCase()).toContain("read the full");
  });

  it("extracts an email intro from the blog's own first paragraph with link-out framing", () => {
    const [piece] = repurposeContent(blogBody, "blog", ["email"], brandVoice);
    expect(piece.format).toBe("email");
    expect(piece.body).toContain("opening paragraph that explains the core problem");
  });

  it("builds a numbered twitter thread from the blog's own paragraphs", () => {
    const [piece] = repurposeContent(blogBody, "blog", ["twitter_thread"], brandVoice);
    expect(piece.format).toBe("twitter_thread");
    expect(piece.body).toContain("1/3");
    expect(piece.body).toContain("2/3");
    expect(piece.body).toContain("3/3");
    expect(piece.body).toContain("second paragraph describes how the product solves");
  });

  it("produces a summary from the first 2 real sentences of the body", () => {
    const [piece] = repurposeContent(blogBody, "blog", ["summary"], brandVoice);
    expect(piece.format).toBe("summary");
    expect(piece.body).toContain("opening paragraph that explains the core problem teams face today.");
    expect(piece.body).toContain("It sets up the stakes clearly.");
    expect(piece.body).not.toContain("second paragraph describes");
  });

  it("supports multiple target formats in one call", () => {
    const pieces = repurposeContent(blogBody, "blog", ["linkedin_post", "email", "summary"], brandVoice);
    expect(pieces.map((p) => p.format)).toEqual(["linkedin_post", "email", "summary"]);
  });
});

describe("POST /content-calendars", () => {
  it("404s when the project has no project profile yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // project_profiles lookup -> none
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "November calendar", startDate: "2026-11-01" });

    expect(res.status).toBe(404);
  });

  it("generates and persists a calendar with items when a profile exists", async () => {
    const app = buildApp();
    const items = generateContentCalendar(SAAS_PROFILE, SAAS_ICP, "2026-11-01");

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [SAAS_PROFILE] }, // project_profiles
      { rowCount: 1, rows: [SAAS_ICP] }, // icp_profiles
      {
        rowCount: 1,
        rows: [
          {
            id: CALENDAR_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            name: "November calendar",
            start_date: "2026-11-01",
            icp_profile_id: ICP_1,
          },
        ],
      }, // INSERT content_calendars
      ...items.map((item, i) => ({ rowCount: 1, rows: [{ id: `item-${i}`, ...item }] })),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "November calendar", startDate: "2026-11-01", icpProfileId: ICP_1 });

    expect(res.status).toBe(201);
    expect(res.body.contentCalendar.id).toBe(CALENDAR_1);
    expect(res.body.items).toHaveLength(items.length);
  });

  it("rejects an invalid body (missing startDate)", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]); // project exists

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "no start date" });

    expect(res.status).toBe(400);
  });

  it("enhanceBlogsWithLlm: true is an honest no-op (every item stays generation_method: 'template') when no ANTHROPIC_API_KEY is configured — the real env.ts, not mocked", async () => {
    const app = buildApp();
    const items = generateContentCalendar(SAAS_PROFILE, null, "2026-11-01");

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [SAAS_PROFILE] }, // project_profiles
      {
        rowCount: 1,
        rows: [{ id: CALENDAR_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "November calendar", start_date: "2026-11-01", icp_profile_id: null }],
      }, // INSERT content_calendars
      // Each item insert: the route must pass generation_method: 'template'
      // for every item (no LLM configured, so enhanceBlogBodyWithLlm() is
      // an honest not_configured no-op) — echoed back here as the mock's
      // "stored" row.
      ...items.map((item, i) => ({ rowCount: 1, rows: [{ id: `item-${i}`, ...item, generation_method: "template" }] })),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "November calendar", startDate: "2026-11-01", enhanceBlogsWithLlm: true });

    expect(res.status).toBe(201);
    expect(res.body.items.every((i: { generation_method: string }) => i.generation_method === "template")).toBe(true);
    expect(res.body.llmEnhancement).toEqual({ requested: true, enhancedCount: 0, lastStatus: "not_configured" });

    // The actual INSERT calls for content_calendar_items must have been
    // given 'template' as the generation_method parameter for every blog
    // item, proving the route never silently claims an LLM produced it.
    const itemInsertCalls = queryMock.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO content_calendar_items"));
    expect(itemInsertCalls.length).toBe(items.length);
    for (const call of itemInsertCalls) {
      const params = call[1] as unknown[];
      expect(params[params.length - 1]).toBe("template");
    }
  });
});

describe("GET /content-calendars/:id", () => {
  it("returns a calendar with its items", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CALENDAR_1, tenant_id: TENANT_A, project_id: PROJECT_1 }] }, // loadCalendarOr404
      { rowCount: 1, rows: [{ id: ITEM_1, day_offset: 0, content_type: "linkedin_post" }] }, // items
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars/${CALENDAR_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.contentCalendar.id).toBe(CALENDAR_1);
    expect(res.body.items).toHaveLength(1);
  });

  it("404s for a calendar that doesn't belong to this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // loadCalendarOr404 -> not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars/${CALENDAR_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /content-calendars/:id/items/:itemId", () => {
  it("edits title/body/status of an item", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CALENDAR_1 }] }, // loadCalendarOr404
      { rowCount: 1, rows: [{ id: ITEM_1, title: "Edited title", status: "approved" }] }, // UPDATE
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars/${CALENDAR_1}/items/${ITEM_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ title: "Edited title", status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.item.title).toBe("Edited title");
    expect(res.body.item.status).toBe("approved");
  });

  it("rejects an empty patch body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CALENDAR_1 }] }, // loadCalendarOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars/${CALENDAR_1}/items/${ITEM_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /content-calendars/:id", () => {
  it("deletes a calendar", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CALENDAR_1 }] }, // loadCalendarOr404
      undefined, // DELETE
    ]);

    const res = await request(app)
      .delete(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-calendars/${CALENDAR_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});

describe("POST /content-drafts", () => {
  it("creates an original draft", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: DRAFT_1, tenant_id: TENANT_A, project_id: PROJECT_1, format: "blog", title: "My blog" }],
      }, // INSERT content_drafts
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-drafts`)
      .set("X-Dev-User-Id", USER_1)
      .send({ format: "blog", title: "My blog", body: "Some real body text." });

    expect(res.status).toBe(201);
    expect(res.body.contentDraft.id).toBe(DRAFT_1);
  });
});

describe("POST /content-drafts/:id/repurpose", () => {
  it("404s when the project has no project profile yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DRAFT_1, format: "blog", body: "Some blog body." }] }, // loadDraftOr404
      { rowCount: 0, rows: [] }, // project_profiles lookup -> none
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-drafts/${DRAFT_1}/repurpose`)
      .set("X-Dev-User-Id", USER_1)
      .send({ targetFormats: ["summary"] });

    expect(res.status).toBe(404);
  });

  it("repurposes a source draft into the requested target formats", async () => {
    const app = buildApp();
    const sourceBody =
      "Opening paragraph explaining the problem in depth. It really sets the stage.\n\nClosing paragraph with a call to action.";

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DRAFT_1, format: "blog", body: sourceBody }] }, // loadDraftOr404
      { rowCount: 1, rows: [SAAS_PROFILE] }, // project_profiles
      {
        rowCount: 1,
        rows: [{ id: "new-1", source_draft_id: DRAFT_1, format: "linkedin_post", title: "LinkedIn post (repurposed)" }],
      },
      {
        rowCount: 1,
        rows: [{ id: "new-2", source_draft_id: DRAFT_1, format: "summary", title: "Summary (repurposed)" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-drafts/${DRAFT_1}/repurpose`)
      .set("X-Dev-User-Id", USER_1)
      .send({ targetFormats: ["linkedin_post", "summary"] });

    expect(res.status).toBe(201);
    expect(res.body.repurposed).toHaveLength(2);
    expect(res.body.repurposed[0].format).toBe("linkedin_post");
    expect(res.body.repurposed[1].format).toBe("summary");
  });
});

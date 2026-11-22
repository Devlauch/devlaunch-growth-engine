import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as conversionOptimization.test.ts / publicLeads.test.ts:
// fake the pg pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { landingPagesRouter } = await import("../src/routes/landingPages.js");
const { publicLandingPagesRouter } = await import("../src/routes/publicLandingPages.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { buildLandingPageBlocks, resolveRenderedBlocks } = await import("../src/lib/landingPageBuilder.js");

function buildAuthedApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/landing-pages",
    landingPagesRouter,
  );
  app.use(errorHandler);
  return app;
}

function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public", publicLandingPagesRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const PAGE_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";
const ALLOWED_ORIGIN = "https://customer-site.example";

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

const projectRow = { rowCount: 1, rows: [{ "?column?": 1 }] };
const noProjectProfile = { rowCount: 0, rows: [] };

/* ------------------------------------------------------------------ */
/* landingPageBuilder.ts: deterministic template assembly               */
/* ------------------------------------------------------------------ */

describe("buildLandingPageBlocks", () => {
  it("always includes hero, form, and cta blocks", () => {
    const blocks = buildLandingPageBlocks(
      { company_name: "Acme", industry: "saas", value_proposition: "We ship fast" },
      null,
      {},
    );
    const types = blocks.map((b) => b.type);
    expect(types).toContain("hero");
    expect(types).toContain("form");
    expect(types).toContain("cta");
  });

  it("never fabricates a social_proof block without a real testimonial", () => {
    const blocks = buildLandingPageBlocks(
      { company_name: "Acme", industry: "saas", value_proposition: "We ship fast" },
      null,
      {},
    );
    expect(blocks.find((b) => b.type === "social_proof")).toBeUndefined();
  });

  it("includes a social_proof block only when a real testimonial quote is supplied", () => {
    const blocks = buildLandingPageBlocks(
      { company_name: "Acme", industry: "saas", value_proposition: "We ship fast" },
      null,
      { testimonialQuote: "Acme changed how we work.", testimonialAuthor: "Jane, CTO" },
    );
    const socialProof = blocks.find((b) => b.type === "social_proof") as { quote: string; author: string } | undefined;
    expect(socialProof).toBeDefined();
    expect(socialProof!.quote).toBe("Acme changed how we work.");
    expect(socialProof!.author).toBe("Jane, CTO");
  });

  it("falls back to real ICP pain points (reframed) for benefits when the user supplies none", () => {
    const blocks = buildLandingPageBlocks(
      { company_name: "Acme", industry: "saas", value_proposition: "We ship fast" },
      { name: "DevOps leads", segment: "devops", pain_points: ["slow deploys", "flaky pipelines"] },
      {},
    );
    const benefits = blocks.find((b) => b.type === "benefits") as { items: string[] } | undefined;
    expect(benefits).toBeDefined();
    expect(benefits!.items).toEqual(["No more slow deploys", "No more flaky pipelines"]);
  });

  it("prefers the user's own benefit copy over ICP pain points", () => {
    const blocks = buildLandingPageBlocks(
      { company_name: "Acme", industry: "saas", value_proposition: "We ship fast" },
      { name: "DevOps leads", segment: "devops", pain_points: ["slow deploys"] },
      { benefits: ["24/7 support", "Free onboarding"] },
    );
    const benefits = blocks.find((b) => b.type === "benefits") as { items: string[] } | undefined;
    expect(benefits!.items).toEqual(["24/7 support", "Free onboarding"]);
  });
});

describe("resolveRenderedBlocks", () => {
  it("falls back to base blocks when a variant has no override", () => {
    const base = [{ type: "hero", headline: "Base", subheadline: "", body: null }] as never;
    expect(resolveRenderedBlocks(base, [])).toBe(base);
    expect(resolveRenderedBlocks(base, null)).toBe(base);
  });

  it("uses the variant's own blocks when it has an override", () => {
    const base = [{ type: "hero", headline: "Base", subheadline: "", body: null }] as never;
    const variantBlocks = [{ type: "hero", headline: "Challenger", subheadline: "", body: null }] as never;
    expect(resolveRenderedBlocks(base, variantBlocks)).toBe(variantBlocks);
  });
});

/* ------------------------------------------------------------------ */
/* Authenticated CRUD (landingPagesRouter)                              */
/* ------------------------------------------------------------------ */

describe("POST /landing-pages", () => {
  it("creates a landing page with deterministic, rendered blocks", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      noProjectProfile, // project_profiles lookup (none set up)
      {
        rowCount: 1,
        rows: [
          {
            id: PAGE_1,
            slug: "cloud-consulting",
            title: "Cloud Consulting",
            status: "draft",
            blocks: [{ type: "hero" }, { type: "form" }, { type: "cta" }],
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages`)
      .set("X-Dev-User-Id", USER_1)
      .send({ slug: "cloud-consulting", title: "Cloud Consulting", audienceLabel: "cloud consulting" });

    expect(res.status).toBe(201);
    expect(res.body.landingPage.slug).toBe("cloud-consulting");

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO landing_pages"),
    );
    expect(insertCall).toBeDefined();
  });

  it("rejects an invalid slug", async () => {
    const app = buildAuthedApp();
    queueResponses([...mockMembership(), projectRow]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages`)
      .set("X-Dev-User-Id", USER_1)
      .send({ slug: "Not A Valid Slug!", title: "x" });

    expect(res.status).toBe(400);
  });

  it("returns 409 on a duplicate (project, slug)", async () => {
    const app = buildAuthedApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce(projectRow) // assertProjectInTenant
      .mockResolvedValueOnce(noProjectProfile) // project_profiles
      .mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" })); // INSERT

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages`)
      .set("X-Dev-User-Id", USER_1)
      .send({ slug: "cloud-consulting", title: "Cloud Consulting" });

    expect(res.status).toBe(409);
  });
});

describe("GET /landing-pages/:id", () => {
  it("returns 404 when the landing page does not exist in this project/tenant", async () => {
    const app = buildAuthedApp();
    queueResponses([...mockMembership(), projectRow, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("POST /landing-pages/:id/publish and /unpublish", () => {
  it("publishes a landing page, setting status and published_at", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: PAGE_1, status: "draft" }] }, // loadLandingPageOr404
      { rowCount: 1, rows: [{ id: PAGE_1, status: "published", published_at: new Date().toISOString() }] }, // UPDATE
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/publish`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.landingPage.status).toBe("published");
  });

  it("unpublishes a landing page, clearing published_at", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: PAGE_1, status: "published" }] },
      { rowCount: 1, rows: [{ id: PAGE_1, status: "draft", published_at: null }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/unpublish`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.landingPage.status).toBe("draft");
    expect(res.body.landingPage.published_at).toBeNull();
  });
});

describe("POST /landing-pages/:id/ab-test", () => {
  it("creates an experiment plus control(a)/challenger(b) variants, reusing the experiments table", async () => {
    const app = buildAuthedApp();
    const EXPERIMENT_1 = "66666666-6666-6666-6666-666666666666";
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rowCount: 1,
        rows: [
          {
            id: PAGE_1,
            audience_label: "cloud consulting",
            headline: "Base headline",
            subheadline: "Base sub",
            body_copy: null,
            benefits: [],
            testimonial_quote: null,
            testimonial_author: null,
            cta_text: "Talk to us",
            cta_url: null,
            qualifying_questions: [],
          },
        ],
      }, // loadLandingPageOr404
      { rowCount: 0, rows: [] }, // no existing variants
      noProjectProfile, // project_profiles
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, name: "Headline test", status: "running" }] }, // INSERT experiments
      undefined, // INSERT variant a
      { rowCount: 1, rows: [{ id: "variant-b", variant: "b", experiment_id: EXPERIMENT_1 }] }, // INSERT variant b
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/ab-test`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Headline test", hypothesis: "A sharper headline converts better.", variantBHeadline: "Challenger headline" });

    expect(res.status).toBe(201);
    expect(res.body.experiment.status).toBe("running");
    expect(res.body.variantB.variant).toBe("b");

    const experimentInsert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO experiments"),
    );
    expect(experimentInsert).toBeDefined();
  });

  it("rejects starting a second A/B test on a page that already has variants", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: PAGE_1 }] }, // loadLandingPageOr404
      { rowCount: 1, rows: [{ "?column?": 1 }] }, // existing variants present
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/ab-test`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Second test", hypothesis: "h" });

    expect(res.status).toBe(409);
  });
});

describe("lead magnets", () => {
  it("creates a lead magnet with a stub file_url (no upload infra)", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: PAGE_1 }] }, // loadLandingPageOr404
      {
        rowCount: 1,
        rows: [{ id: "magnet-1", title: "Free Guide", file_url: "https://cdn.example.com/guide.pdf" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/lead-magnets`)
      .set("X-Dev-User-Id", USER_1)
      .send({ title: "Free Guide", fileUrl: "https://cdn.example.com/guide.pdf" });

    expect(res.status).toBe(201);
    expect(res.body.leadMagnet.file_url).toBe("https://cdn.example.com/guide.pdf");
  });
});

describe("GET /landing-pages/:id/stats", () => {
  it("rolls up only real tracked events — never fabricates numbers", async () => {
    const app = buildAuthedApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: PAGE_1 }] }, // loadLandingPageOr404
      {
        rowCount: 3,
        rows: [
          { event_type: "page_view", variant: null, count: "40" },
          { event_type: "form_submit", variant: null, count: "6" },
          { event_type: "download", variant: null, count: "4" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/stats`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.views).toBe(40);
    expect(res.body.submits).toBe(6);
    expect(res.body.downloads).toBe(4);
    expect(res.body.conversionRate).toBeCloseTo(0.15);
  });

  it("reports a zero conversion rate (not NaN/fabricated) when there are no views yet", async () => {
    const app = buildAuthedApp();
    queueResponses([...mockMembership(), projectRow, { rowCount: 1, rows: [{ id: PAGE_1 }] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/stats`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.views).toBe(0);
    expect(res.body.conversionRate).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Public surface (publicLandingPagesRouter)                            */
/* ------------------------------------------------------------------ */

describe("GET /api/v1/public/projects/:projectPublicKey/landing-pages/:slug", () => {
  it("rejects an unknown project public key with 404", async () => {
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config lookup key
      { rowCount: 0, rows: [] }, // project lookup: none found
      undefined, // ROLLBACK
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .get("/api/v1/public/projects/pk_unknown/landing-pages/cloud-consulting")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(404);
  });

  it("rejects a request from a non-allowlisted origin", async () => {
    queueResponses([
      undefined,
      undefined,
      { rowCount: 1, rows: [{ id: "project-1", tenant_id: TENANT_A, allowed_origins: [ALLOWED_ORIGIN], public_widget_enabled: true }] },
      undefined, // ROLLBACK
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .get("/api/v1/public/projects/pk_valid/landing-pages/cloud-consulting")
      .set("Origin", "https://evil.example");

    expect(res.status).toBe(404);
  });

  it("renders a published page, assigning a real variant and never leaking a lead magnet's file_url", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9); // picks variant 'b'

    queueResponses([
      undefined, // BEGIN
      undefined, // set_config lookup key
      { rowCount: 1, rows: [{ id: "project-1", tenant_id: TENANT_A, allowed_origins: [ALLOWED_ORIGIN], public_widget_enabled: true }] },
      undefined, // set_config current_tenant_id
      {
        rowCount: 1,
        rows: [
          {
            id: PAGE_1,
            slug: "cloud-consulting",
            title: "Cloud Consulting",
            seo_title: null,
            seo_description: null,
            seo_og_image_url: null,
            blocks: [{ type: "hero", headline: "Base" }],
            qualifying_questions: [],
          },
        ],
      },
      {
        rowCount: 2,
        rows: [
          { variant: "a", blocks: [] },
          { variant: "b", blocks: [{ type: "hero", headline: "Challenger" }] },
        ],
      },
      {
        rowCount: 1,
        rows: [{ id: "magnet-1", title: "Free Guide", description: "A real PDF guide" }],
      },
      undefined, // COMMIT
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .get("/api/v1/public/projects/pk_valid/landing-pages/cloud-consulting")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.variant).toBe("b");
    expect(res.body.landingPage.blocks).toEqual([{ type: "hero", headline: "Challenger" }]);
    expect(res.body.leadMagnets[0].file_url).toBeUndefined();

    vi.restoreAllMocks();
  });
});

describe("POST /api/v1/public/projects/:projectPublicKey/landing-pages/:slug/submit", () => {
  it("writes through the shared ingestLead() path and unlocks a gated lead magnet download only after a real submission", async () => {
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config lookup key
      { rowCount: 1, rows: [{ id: "project-1", tenant_id: TENANT_A, allowed_origins: [ALLOWED_ORIGIN], public_widget_enabled: true }] },
      undefined, // set_config current_tenant_id
      { rowCount: 1, rows: [{ id: PAGE_1, slug: "cloud-consulting" }] }, // landing page lookup
      { rowCount: 1, rows: [{ file_url: "https://cdn.example.com/guide.pdf" }] }, // lead magnet lookup
      { rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }, // ingestLead: INSERT leads
      undefined, // ingestLead: INSERT audit_events
      undefined, // ingestLead: INSERT usage_events
      { rowCount: 0, rows: [] }, // ingestLead: notifyTenantOwnersAndAdmins
      undefined, // INSERT landing_page_events (form_submit)
      undefined, // INSERT landing_page_events (download)
      undefined, // COMMIT
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/landing-pages/cloud-consulting/submit")
      .set("Origin", ALLOWED_ORIGIN)
      .send({ email: "lead@example.com", name: "Jane Lead", leadMagnetId: "11111111-2222-3333-4444-555555555555" });

    expect(res.status).toBe(201);
    expect(res.body.lead.id).toBe("lead-1");
    expect(res.body.download.fileUrl).toBe("https://cdn.example.com/guide.pdf");

    const leadsInsert = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"));
    expect(leadsInsert).toBeDefined();
    const noSecondLeadPath = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"),
    );
    expect(noSecondLeadPath.length).toBe(1);
  });

  it("never returns a download without a successful submission (unknown project key -> 404, no lead written)", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const app = buildPublicApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_unknown/landing-pages/cloud-consulting/submit")
      .set("Origin", ALLOWED_ORIGIN)
      .send({ email: "lead@example.com" });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO leads"), expect.anything());
  });
});

describe("POST /api/v1/public/projects/:projectPublicKey/landing-pages/:slug/track", () => {
  it("records a real page_view event", async () => {
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config lookup key
      { rowCount: 1, rows: [{ id: "project-1", tenant_id: TENANT_A, allowed_origins: [ALLOWED_ORIGIN], public_widget_enabled: true }] },
      undefined, // set_config current_tenant_id
      { rowCount: 1, rows: [{ id: PAGE_1 }] }, // page lookup
      undefined, // INSERT landing_page_events
      undefined, // COMMIT
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/landing-pages/cloud-consulting/track")
      .set("Origin", ALLOWED_ORIGIN)
      .send({ eventType: "page_view" });

    expect(res.status).toBe(201);
    expect(res.body.tracked).toBe(true);

    const eventInsert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO landing_page_events"),
    );
    expect(eventInsert).toBeDefined();
  });

  it("rejects a track call from a non-allowlisted origin", async () => {
    queueResponses([
      undefined,
      undefined,
      { rowCount: 1, rows: [{ id: "project-1", tenant_id: TENANT_A, allowed_origins: [ALLOWED_ORIGIN], public_widget_enabled: true }] },
      undefined, // ROLLBACK
    ]);

    const app = buildPublicApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/landing-pages/cloud-consulting/track")
      .set("Origin", "https://evil.example")
      .send({ eventType: "page_view" });

    expect(res.status).toBe(404);
  });
});

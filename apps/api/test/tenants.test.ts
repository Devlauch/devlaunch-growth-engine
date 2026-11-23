import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// requireTenantMembership and the route handlers both get a fake pg
// client whose query() we control per test (same pattern as
// tenantMiddleware.test.ts and projects.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
  // tenantsRouter's POST / and GET / handlers use withTransaction/
  // withUserContext directly (they run before any tenantId is known), but
  // this file only exercises the PATCH /:tenantId branding route and the
  // onboarding-completeness route, both of which only go through
  // requireTenantMembership's pool.connect() usage above.
  withTransaction: vi.fn(),
  withUserContext: vi.fn(),
}));

const { tenantsRouter } = await import("../src/routes/tenants.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { withTransaction } = await import("../src/db/pool.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants", tenantsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  vi.mocked(withTransaction).mockReset();
});

describe("PATCH /api/v1/tenants/:tenantId (branding & onboarding fields)", () => {
  it("updates industry/goals/logoUrl/primaryColor/subdomain and is audited as tenant.branding_updated", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: TENANT_A,
            slug: "acme",
            name: "Acme Inc",
            industry: "SaaS",
            goals: "Grow qualified pipeline",
            logo_url: "https://cdn.example.com/acme-logo.png",
            primary_color: "#6d5cf0",
            subdomain: "acme",
            status: "active",
            settings: {},
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce(undefined); // INSERT audit_events

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        industry: "SaaS",
        goals: "Grow qualified pipeline",
        logoUrl: "https://cdn.example.com/acme-logo.png",
        primaryColor: "#6d5cf0",
        subdomain: "acme",
      });

    expect(res.status).toBe(200);
    expect(res.body.tenant.primary_color).toBe("#6d5cf0");
    expect(res.body.tenant.subdomain).toBe("acme");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([
      TENANT_A,
      true,
      "SaaS",
      true,
      "Grow qualified pipeline",
      true,
      "https://cdn.example.com/acme-logo.png",
      true,
      "#6d5cf0",
      true,
      "acme",
    ]);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][0]).toBe(TENANT_A);
    expect(auditCall![1][1]).toBe(USER_1);
    expect(auditCall![1][2]).toBe("tenant.branding_updated");
    expect(JSON.parse(auditCall![1][3])).toEqual({
      industry: "SaaS",
      goals: "Grow qualified pipeline",
      logoUrl: "https://cdn.example.com/acme-logo.png",
      primaryColor: "#6d5cf0",
      subdomain: "acme",
    });
  });

  it("rejects a non-hex primaryColor with a validation error and never reaches the UPDATE", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "not-a-color" });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });

  it("rejects a primaryColor missing the # or with the wrong length", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }); // membership

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "6d5cf0" }); // missing leading '#'

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });

  it("denies a cross-tenant user from updating another tenant's branding (tenant isolation)", async () => {
    const app = buildApp();

    // USER_2 has no active membership row for TENANT_B -> requireTenantMembership
    // rejects with 403 before the route handler (and its UPDATE query) ever runs.
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // membership lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_B}`)
      .set("X-Dev-User-Id", USER_2)
      .send({ primaryColor: "#000000" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });

  it("denies a member (non owner/admin) from updating branding", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "member", status: "active" }] }) // membership
      .mockResolvedValueOnce(undefined); // ROLLBACK (403 >= 400)

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ primaryColor: "#000000" });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
  });
});

describe("POST /api/v1/tenants (one-owned-organization-per-user)", () => {
  function fakeClient(queryImpl: (sql: string, params?: unknown[]) => unknown) {
    return { query: vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)) };
  }

  it("creates an organization + owner membership + default project in one transaction", async () => {
    const app = buildApp();
    const client = fakeClient((sql) => {
      if (sql.startsWith("SELECT set_config")) return undefined;
      if (sql.includes("role = 'owner' AND status = 'active' LIMIT 1")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT 1 FROM tenants WHERE slug")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO tenants")) {
        return { rowCount: 1, rows: [{ id: "t1", slug: "acme-inc", name: "Acme Inc", industry: null, status: "active", created_at: "now" }] };
      }
      if (sql.startsWith("INSERT INTO memberships")) return undefined;
      if (sql.startsWith("INSERT INTO projects")) {
        return { rowCount: 1, rows: [{ id: "p1", tenant_id: "t1", name: "Main website", slug: "main-website", status: "active", created_at: "now" }] };
      }
      if (sql.startsWith("INSERT INTO audit_events")) return undefined;
      throw new Error(`unexpected query: ${sql}`);
    });
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));

    const res = await request(app).post("/api/v1/tenants").set("X-Dev-User-Id", USER_1).send({ name: "Acme Inc" });

    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe("acme-inc");
    expect(res.body.project.name).toBe("Main website");
    const projectInsert = client.query.mock.calls.find(([sql]: [string]) => sql.startsWith("INSERT INTO projects"));
    expect(projectInsert).toBeDefined();
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.startsWith("INSERT INTO project_profiles"))).toBe(
      false,
    ); // no websiteUrl given
  });

  it("stores the website URL on a project_profiles row when provided", async () => {
    const app = buildApp();
    const client = fakeClient((sql) => {
      if (sql.startsWith("SELECT set_config")) return undefined;
      if (sql.includes("role = 'owner' AND status = 'active' LIMIT 1")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT 1 FROM tenants WHERE slug")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO tenants"))
        return { rowCount: 1, rows: [{ id: "t1", slug: "acme-inc", name: "Acme Inc", industry: null, status: "active", created_at: "now" }] };
      if (sql.startsWith("INSERT INTO memberships")) return undefined;
      if (sql.startsWith("INSERT INTO projects"))
        return { rowCount: 1, rows: [{ id: "p1", tenant_id: "t1", name: "Main website", slug: "main-website", status: "active", created_at: "now" }] };
      if (sql.startsWith("INSERT INTO project_profiles")) return undefined;
      if (sql.startsWith("INSERT INTO audit_events")) return undefined;
      throw new Error(`unexpected query: ${sql}`);
    });
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));

    const res = await request(app)
      .post("/api/v1/tenants")
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Inc", websiteUrl: "https://acme.com" });

    expect(res.status).toBe(201);
    const profileInsert = client.query.mock.calls.find(([sql]: [string]) => sql.startsWith("INSERT INTO project_profiles"));
    expect(profileInsert).toBeDefined();
    // params[0]/[1] are the route's own freshly-generated tenantId/projectId
    // (not the mocked RETURNING ids) — only company_name/website_url matter here.
    expect(profileInsert![1].slice(2)).toEqual(["Acme Inc", "https://acme.com"]);
  });

  it("returns 409 if the user already owns an organization (pre-check)", async () => {
    const app = buildApp();
    const client = fakeClient((sql) => {
      if (sql.startsWith("SELECT set_config")) return undefined;
      if (sql.includes("role = 'owner' AND status = 'active' LIMIT 1")) return { rowCount: 1, rows: [{ "?column?": 1 }] };
      throw new Error(`unexpected query after owner pre-check: ${sql}`);
    });
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));

    const res = await request(app).post("/api/v1/tenants").set("X-Dev-User-Id", USER_1).send({ name: "Second Co" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already own an organization/i);
  });

  it("maps a unique_violation (23505) on the owner-limit constraint to 409 (concurrent create race)", async () => {
    // Regression guard for a real bug found via live smoke-testing: this
    // MUST key off err.constraint, never message-sniffing or "any 23505",
    // since tenants.slug has its own, unrelated unique constraint (see the
    // slug-collision test below) that must NOT produce this message.
    const app = buildApp();
    const client = fakeClient((sql) => {
      if (sql.startsWith("SELECT set_config")) return undefined;
      if (sql.includes("role = 'owner' AND status = 'active' LIMIT 1")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO tenants"))
        return { rowCount: 1, rows: [{ id: "t1", slug: "acme-inc", name: "Acme Inc", industry: null, status: "active", created_at: "now" }] };
      if (sql.startsWith("INSERT INTO memberships")) {
        const err: any = new Error('duplicate key value violates unique constraint "memberships_one_owned_tenant_per_user"');
        err.code = "23505";
        err.constraint = "memberships_one_owned_tenant_per_user";
        throw err;
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));

    const res = await request(app).post("/api/v1/tenants").set("X-Dev-User-Id", USER_1).send({ name: "Acme Inc" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already own an organization/i);
    expect(vi.mocked(withTransaction)).toHaveBeenCalledTimes(1); // no retry for this constraint
  });

  it("auto-suffixes the slug on a real tenants_slug_key collision instead of rejecting", async () => {
    // Regression test for the real bug found live: a SELECT-based
    // pre-check against `tenants` can never see another tenant's slug
    // (RLS scopes it to the caller's own tenant/memberships — see the
    // route's own doc comment and docs/DECISIONS.md D6), so collision
    // detection must happen by retrying the actual INSERT on a
    // tenants_slug_key violation, not by checking first.
    const app = buildApp();
    let tenantInsertAttempts = 0;
    const client = fakeClient((sql, params) => {
      if (sql.startsWith("SELECT set_config")) return undefined;
      if (sql.includes("role = 'owner' AND status = 'active' LIMIT 1")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO tenants")) {
        tenantInsertAttempts += 1;
        if (tenantInsertAttempts === 1) {
          const err: any = new Error('duplicate key value violates unique constraint "tenants_slug_key"');
          err.code = "23505";
          err.constraint = "tenants_slug_key";
          throw err;
        }
        const slug = (params as unknown[])[1];
        return { rowCount: 1, rows: [{ id: "t1", slug, name: "Acme Inc", industry: null, status: "active", created_at: "now" }] };
      }
      if (sql.startsWith("INSERT INTO memberships")) return undefined;
      if (sql.startsWith("INSERT INTO projects"))
        return { rowCount: 1, rows: [{ id: "p1", tenant_id: "t1", name: "Main website", slug: "main-website", status: "active", created_at: "now" }] };
      if (sql.startsWith("INSERT INTO audit_events")) return undefined;
      throw new Error(`unexpected query: ${sql}`);
    });
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));

    const res = await request(app).post("/api/v1/tenants").set("X-Dev-User-Id", USER_1).send({ name: "Acme Inc" });

    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe("acme-inc-2");
    expect(tenantInsertAttempts).toBe(2);
    expect(vi.mocked(withTransaction)).toHaveBeenCalledTimes(2); // one retry attempt
  });

  it("rejects a reserved-word slug with 400 and never starts a transaction", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/v1/tenants")
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Admin Co", slug: "admin" });

    expect(res.status).toBe(400);
    expect(vi.mocked(withTransaction)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/tenants/:tenantId/onboarding-completeness", () => {
  it("computes the checklist from real row existence, with no project yet", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ industry: null, goals: null, logo_url: null, primary_color: null }],
      }) // tenant branding fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_count: 0, widget_enabled_count: 0 }] }); // project stats

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/onboarding-completeness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(4);
    expect(res.body.completedCount).toBe(1); // only orgCreated
    const byKey = Object.fromEntries(
      (res.body.checklist as { key: string; done: boolean }[]).map((c) => [c.key, c.done]),
    );
    expect(byKey.orgCreated).toBe(true);
    expect(byKey.brandingSet).toBe(false);
    expect(byKey.firstProjectCreated).toBe(false);
    expect(byKey.widgetEnabled).toBe(false);
  });

  it("marks brandingSet/firstProjectCreated/widgetEnabled true once real rows exist", async () => {
    const app = buildApp();

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", role: "owner", status: "active" }] }) // membership
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ industry: "SaaS", goals: null, logo_url: null, primary_color: "#6d5cf0" }],
      }) // tenant branding fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_count: 2, widget_enabled_count: 1 }] }); // project stats

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/onboarding-completeness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.completedCount).toBe(4);
    const byKey = Object.fromEntries(
      (res.body.checklist as { key: string; done: boolean }[]).map((c) => [c.key, c.done]),
    );
    expect(byKey.brandingSet).toBe(true);
    expect(byKey.firstProjectCreated).toBe(true);
    expect(byKey.widgetEnabled).toBe(true);
  });
});

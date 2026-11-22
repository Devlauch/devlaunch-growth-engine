import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as campaigns.test.ts / projects.test.ts /
// tenantMiddleware.test.ts: fake the pg pool so these are true unit tests
// with no real Postgres, and no real DNS calls either (verifyEmail takes
// an injectable resolver for the route-level tests).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const discoverMock = vi.fn();
vi.mock("@devlaunch/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devlaunch/agent-sdk")>();
  return {
    ...actual,
    getConnector: vi.fn((id: string) =>
      id === "public-directory"
        ? {
            id: "public-directory",
            type: "public_directory",
            termsNote: "test terms",
            defaultRateLimitPerMinute: 10,
            discover: discoverMock,
          }
        : undefined,
    ),
  };
});

const { discoverySourcesRouter, discoveredOrganizationsRouter, rankContactsForPromotion } = await import(
  "../src/routes/discovery.js"
);
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { verifyEmail, isSyntaxValid, isRoleBasedLocalPart } = await import("../src/lib/emailVerification.js");
const { normalizePhone, isPlausibleE164 } = await import("../src/lib/phoneVerification.js");
const { normalizeDomain, normalizeOrgName, normalizeEmail } = await import("../src/lib/dedup.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/discovery-sources",
    discoverySourcesRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/discovered-organizations",
    discoveredOrganizationsRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const ORG_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  discoverMock.mockReset();
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

describe("emailVerification", () => {
  it("flags syntactically invalid emails as invalid", async () => {
    const result = await verifyEmail("not-an-email");
    expect(result.syntaxValid).toBe(false);
    expect(result.verificationStatus).toBe("invalid");
  });

  it("accepts well-formed addresses as syntax-valid", () => {
    expect(isSyntaxValid("jane.doe+tag@example.com")).toBe(true);
    expect(isSyntaxValid("bad..dots@example.com")).toBe(false);
    expect(isSyntaxValid("missing-at-sign.com")).toBe(false);
    expect(isSyntaxValid("spaced out@example.com")).toBe(false);
  });

  it("detects common role-based local-parts", () => {
    expect(isRoleBasedLocalPart("info")).toBe(true);
    expect(isRoleBasedLocalPart("support")).toBe(true);
    expect(isRoleBasedLocalPart("jane.doe")).toBe(false);
  });

  it("returns verified when MX records are found and the local-part isn't role-based", async () => {
    const resolver = { resolveMx: vi.fn(async () => [{ exchange: "mx.example.com", priority: 10 }]) };
    const result = await verifyEmail("jane.doe@example.com", { resolver });
    expect(result.mxFound).toBe(true);
    expect(result.isRoleBased).toBe(false);
    expect(result.verificationStatus).toBe("verified");
  });

  it("returns role_based when MX is found but the local-part is a generic inbox", async () => {
    const resolver = { resolveMx: vi.fn(async () => [{ exchange: "mx.example.com", priority: 10 }]) };
    const result = await verifyEmail("info@example.com", { resolver });
    expect(result.verificationStatus).toBe("role_based");
  });

  it("handles DNS lookup failure gracefully (no throw) and returns risky, not a crash", async () => {
    const resolver = {
      resolveMx: vi.fn(async () => {
        throw new Error("ENOTFOUND flaky-dns.example");
      }),
    };
    await expect(verifyEmail("someone@flaky-dns.example", { resolver })).resolves.toMatchObject({
      mxFound: false,
      verificationStatus: "risky",
    });
  });
});

describe("phoneVerification", () => {
  it("normalizes formatted numbers into E.164 shape", () => {
    expect(normalizePhone("+1 (415) 555-0132")).toBe("+14155550132");
    expect(normalizePhone("00 44 20 7946 0958")).toBe("+442079460958");
  });

  it("rejects numbers without a usable country code or plus prefix", () => {
    expect(normalizePhone("5550132")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("flags implausible lengths", () => {
    expect(isPlausibleE164("+1234")).toBe(false);
    expect(isPlausibleE164("+14155550132")).toBe(true);
  });
});

describe("dedup normalization", () => {
  it("normalizes domains, stripping protocol/www/trailing slash", () => {
    expect(normalizeDomain("https://www.Example.com/")).toBe("example.com");
    expect(normalizeDomain("Example.COM")).toBe("example.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  it("normalizes org names, stripping common legal suffixes", () => {
    expect(normalizeOrgName("Acme Corp, Inc.")).toBe("acme");
    expect(normalizeOrgName("Beta Solutions Pvt Ltd")).toBe("beta solutions");
    expect(normalizeOrgName("  Gamma   LLC  ")).toBe("gamma");
  });

  it("normalizes emails to lowercase+trimmed", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("denies GET /discovery-sources when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // no active membership row
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });

  it("denies GET /discovered-organizations the same way", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });

  it("denies running a discovery source the same way (never reaches the connector)", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources/77777777-7777-7777-7777-777777777777/run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(403);
    expect(discoverMock).not.toHaveBeenCalled();
  });
});

describe("discovery-sources route validation", () => {
  it("rejects creating a discovery source with an invalid connector_type", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ connectorType: "not_a_real_type", name: "Bad source" });

    expect(res.status).toBe(400);
  });

  it("creates a discovery source with valid fields", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: "src-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            name: "Local restaurants",
            enabled: true,
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ connectorType: "public_directory", name: "Local restaurants" });

    expect(res.status).toBe(201);
    expect(res.body.discoverySource.connector_type).toBe("public_directory");
  });

  it("rejects a schema-valid but not-yet-approved connector_type (website_crawl) with a clear 400", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ connectorType: "website_crawl", name: "Crawl4AI seed list" });

    expect(res.status).toBe(400);
    expect(res.body.message ?? res.body.error).toBeTruthy();

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO discovery_sources"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("rejects csv_upload and licensed_api the same way", async () => {
    for (const connectorType of ["csv_upload", "licensed_api"]) {
      const app = buildApp();
      queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

      const res = await request(app)
        .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources`)
        .set("X-Dev-User-Id", USER_1)
        .send({ connectorType, name: "x" });

      expect(res.status).toBe(400);
    }
  });
});

describe("discovery-sources run endpoint", () => {
  const SOURCE_1 = "77777777-7777-7777-7777-777777777777";

  it("rejects running a disabled source with 409", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          { id: SOURCE_1, tenant_id: TENANT_A, project_id: PROJECT_1, connector_type: "public_directory", enabled: false, rate_limit_per_minute: 10, config: {} },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources/${SOURCE_1}/run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(409);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("runs the public-directory connector and persists a discovered organization", async () => {
    const app = buildApp();
    discoverMock.mockResolvedValueOnce({
      organizations: [
        {
          name: "Springfield Diner",
          domain: "springfielddiner.example",
          sourceUrl: "https://springfielddiner.example",
          discoveredAt: new Date().toISOString(),
          rawMetadata: { source: "openstreetmap-overpass" },
        },
      ],
      contacts: {},
    });

    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: SOURCE_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            connector_type: "public_directory",
            enabled: true,
            rate_limit_per_minute: 10,
            terms_note: null,
            config: { industry: "restaurant", geography: "Springfield" },
          },
        ],
      },
      { rowCount: 0, rows: [] }, // findDuplicateOrganization: by domain -> none
      { rowCount: 0, rows: [] }, // findDuplicateOrganization: by name fallback -> none
      {
        rowCount: 1,
        rows: [{ id: ORG_1, name: "Springfield Diner", domain: "springfielddiner.example" }],
      }, // INSERT discovered_organizations
      undefined, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovery-sources/${SOURCE_1}/run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.organizationsFound).toBe(1);
    expect(res.body.organizationsCreated).toBe(1);
    expect(discoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ industry: "restaurant", geography: "Springfield" }),
      expect.objectContaining({ enabled: true }),
    );

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO discovered_organizations"),
    );
    expect(insertCall).toBeDefined();
  });
});

describe("promote-to-lead", () => {
  const SOURCE_1 = "77777777-7777-7777-7777-777777777777";
  const CONTACT_1 = "88888888-8888-8888-8888-888888888888";

  it("creates a correctly-shaped lead row and marks the organization researched", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: ORG_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            discovery_source_id: SOURCE_1,
            name: "Acme Inc",
            domain: "acme.com",
            source_url: "https://acme.com",
            status: "new",
          },
        ],
      }, // loadOrganizationOr404
      {
        rowCount: 1,
        rows: [
          {
            id: CONTACT_1,
            name: "Jane Doe",
            email: "jane@acme.com",
            role_title: "Owner",
            verification_status: "verified",
            contact_channel: "named_person",
            created_at: new Date().toISOString(),
          },
        ],
      }, // discovered_contacts lookup
      {
        rowCount: 1,
        rows: [
          {
            id: "lead-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            name: "Jane Doe",
            email: "jane@acme.com",
            company: "acme.com",
            source: "discovery",
            status: "new",
          },
        ],
      }, // INSERT leads
      { rowCount: 1, rows: [{ id: ORG_1, status: "researched" }] }, // UPDATE discovered_organizations
      undefined, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations/${ORG_1}/promote-to-lead`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.lead).toMatchObject({ source: "discovery", name: "Jane Doe", email: "jane@acme.com" });
    expect(res.body.organization.status).toBe("researched");

    const insertLeadCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"),
    );
    expect(insertLeadCall).toBeDefined();
  });

  it("refuses to promote an organization that isn't in status 'new'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: ORG_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Acme Inc", status: "researched" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations/${ORG_1}/promote-to-lead`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(409);
  });
});

describe("rankContactsForPromotion", () => {
  it("prefers a verified named person over an unverified role inbox", () => {
    const now = new Date().toISOString();
    const ranked = rankContactsForPromotion([
      { verification_status: "role_based", contact_channel: "role_based", created_at: now, id: "a" },
      { verification_status: "verified", contact_channel: "named_person", created_at: now, id: "b" },
    ] as never);
    expect((ranked[0] as { id: string }).id).toBe("b");
  });
});

describe("discovered-organizations route validation", () => {
  it("rejects creating an organization without a sourceUrl", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Inc" });

    expect(res.status).toBe(400);
  });

  it("returns duplicate:true instead of inserting when a matching domain already exists", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: ORG_1, name: "Acme Inc", domain: "acme.com" }] }, // duplicate lookup by domain
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Acme Inc", domain: "https://www.acme.com/", sourceUrl: "https://directory.example/acme" });

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.organization.id).toBe(ORG_1);

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO discovered_organizations"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("rejects creating a contact with neither email, phone, nor name", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: ORG_1, project_id: PROJECT_1 }] }, // organization exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/discovered-organizations/${ORG_1}/contacts`)
      .set("X-Dev-User-Id", USER_1)
      .send({ contactChannel: "named_person" });

    expect(res.status).toBe(400);
  });
});

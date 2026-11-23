import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same DB-mocking pattern as leadMagnetUploads.test.ts / landingPages.test.ts:
// no real Postgres needed.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const verifyMock = vi.fn();
vi.mock("../src/lib/customDomainVerification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/customDomainVerification.js")>();
  return { ...actual, verifyCustomDomainOwnership: (...args: unknown[]) => verifyMock(...args) };
});

const { customDomainsRouter } = await import("../src/routes/customDomains.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/landing-pages", customDomainsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const PAGE_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  verifyMock.mockReset();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

describe("GET /:id/custom-domain/verification", () => {
  it("marks verification_status = verified and advances custom_domain_publish_status on a real DNS hit", async () => {
    verifyMock.mockResolvedValue({ status: "verified", recordName: "_devlaunch-verify.go.example.com" });
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: PAGE_1, custom_domain: "go.example.com", verification_token: "tok123" }],
      }, // loadLandingPageOr404
      {
        rowCount: 1,
        rows: [{ id: PAGE_1, verification_status: "verified", custom_domain_publish_status: "dns_verified" }],
      }, // UPDATE RETURNING
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/custom-domain/verification`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.landingPage.verification_status).toBe("verified");
    expect(res.body.landingPage.custom_domain_publish_status).toBe("dns_verified");
  });

  it("reports a real 409 conflict (never silently steals or overwrites) when the domain is already verified for a different tenant's page", async () => {
    // 560_custom_domain_public_lookup_rls.sql's partial unique index on
    // (custom_domain) WHERE verification_status = 'verified' is what makes
    // this reachable: DNS proved ownership for THIS page/token, but another
    // tenant already holds the unique "verified" slot for the same domain
    // string (e.g. a stale TXT record satisfied both tokens at once).
    verifyMock.mockResolvedValue({ status: "verified", recordName: "_devlaunch-verify.go.example.com" });
    const uniqueViolation = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: PAGE_1, custom_domain: "go.example.com", verification_token: "tok123" }] },
    ]);
    queryMock.mockRejectedValueOnce(uniqueViolation); // UPDATE ... SET verification_status = 'verified' fails

    const res = await request(buildApp())
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/custom-domain/verification`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("already verified and live on a different landing page");
  });

  it("never claims verified for a DNS lookup that didn't find the token", async () => {
    verifyMock.mockResolvedValue({ status: "not_found", recordName: "_devlaunch-verify.go.example.com" });
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: PAGE_1, custom_domain: "go.example.com", verification_token: "tok123" }] },
      { rowCount: 1, rows: [{ id: PAGE_1, verification_status: "pending" }] }, // UPDATE status=pending RETURNING
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/custom-domain/verification`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.landingPage.verification_status).toBe("pending");
  });
});

describe("POST /:id/custom-domain/publish", () => {
  it("honestly refuses to set status=live (no HTML renderer/CDN consumes this column to actually serve TLS)", async () => {
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: PAGE_1, verification_status: "verified" }] },
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${PAGE_1}/custom-domain/publish`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "live" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("no in-repo landing-page HTML renderer");
  });
});

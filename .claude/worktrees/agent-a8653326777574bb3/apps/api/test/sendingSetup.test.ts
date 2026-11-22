import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts: fake the pg pool so these are
// true unit tests with no real Postgres, and no real DNS calls either
// (dnsVerification.ts takes an injectable resolver for its own unit tests).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { sendingDomainsRouter, warmupConfigsRouter, sendHealthRouter } = await import("../src/routes/sendingSetup.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { checkSpf, checkDmarc, checkDkim } = await import("../src/lib/dnsVerification.js");
const { currentWarmupLimit, shouldPauseForHealth } = await import("../src/lib/warmupPlan.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/sending-domains", sendingDomainsRouter);
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/warmup",
    warmupConfigsRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/health",
    sendHealthRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const DOMAIN_1 = "55555555-5555-5555-5555-555555555555";
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
// dnsVerification
// ---------------------------------------------------------------------------

describe("dnsVerification", () => {
  describe("checkSpf", () => {
    it("returns pass with the record when a single v=spf1 TXT record is found", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["v=spf1 include:_spf.example.com ~all"]]) };
      const result = await checkSpf("example.com", { resolver });
      expect(result.status).toBe("pass");
      expect(result.record).toContain("v=spf1");
    });

    it("returns not_found when there is no SPF TXT record", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["google-site-verification=abc123"]]) };
      const result = await checkSpf("example.com", { resolver });
      expect(result.status).toBe("not_found");
    });

    it("returns not_found when DNS resolution fails (NXDOMAIN/ENOTFOUND)", async () => {
      const resolver = {
        resolveTxt: vi.fn(async () => {
          throw new Error("queryTxt ENOTFOUND example.invalid");
        }),
      };
      const result = await checkSpf("example.invalid", { resolver });
      expect(result.status).toBe("not_found");
    });

    it("returns fail for a malformed/duplicate case: more than one SPF record published", async () => {
      const resolver = {
        resolveTxt: vi.fn(async () => [["v=spf1 include:_spf.a.com ~all"], ["v=spf1 include:_spf.b.com ~all"]]),
      };
      const result = await checkSpf("example.com", { resolver });
      expect(result.status).toBe("fail");
    });
  });

  describe("checkDmarc", () => {
    it("returns pass with the parsed policy when a valid DMARC record is found", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]]) };
      const result = await checkDmarc("example.com", { resolver });
      expect(result.status).toBe("pass");
      expect(result.policy).toBe("reject");
    });

    it("returns not_found when there is no DMARC record at _dmarc.<domain>", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["some other txt"]]) };
      const result = await checkDmarc("example.com", { resolver });
      expect(result.status).toBe("not_found");
    });

    it("returns not_found on DNS resolution failure", async () => {
      const resolver = {
        resolveTxt: vi.fn(async () => {
          throw new Error("ENOTFOUND");
        }),
      };
      const result = await checkDmarc("example.invalid", { resolver });
      expect(result.status).toBe("not_found");
    });

    it("returns fail for a malformed-but-present record (v=DMARC1 with no parseable p= policy)", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["v=DMARC1; rua=mailto:dmarc@example.com"]]) };
      const result = await checkDmarc("example.com", { resolver });
      expect(result.status).toBe("fail");
    });
  });

  describe("checkDkim", () => {
    it("returns pass with the record when a valid DKIM record is found at the given selector", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN..."]]) };
      const result = await checkDkim("example.com", "selector1", { resolver });
      expect(result.status).toBe("pass");
    });

    it("returns not_found when there is no record at <selector>._domainkey.<domain>", async () => {
      const resolver = {
        resolveTxt: vi.fn(async () => {
          throw new Error("ENOTFOUND");
        }),
      };
      const result = await checkDkim("example.com", "nonexistent-selector", { resolver });
      expect(result.status).toBe("not_found");
    });

    it("returns fail for a malformed-but-present record (v=DKIM1 with no p= public key)", async () => {
      const resolver = { resolveTxt: vi.fn(async () => [["v=DKIM1; k=rsa"]]) };
      const result = await checkDkim("example.com", "selector1", { resolver });
      expect(result.status).toBe("fail");
    });
  });
});

// ---------------------------------------------------------------------------
// warmupPlan
// ---------------------------------------------------------------------------

describe("warmupPlan", () => {
  describe("currentWarmupLimit", () => {
    const base = {
      dailyLimit: 20,
      targetDailyLimit: 100,
      rampIncrement: 10,
      rampIntervalDays: 3,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    it("returns the starting daily limit when no time has elapsed", () => {
      expect(currentWarmupLimit(base, new Date("2026-01-01T00:00:00.000Z"))).toBe(20);
    });

    it("does not step up before a full ramp interval has elapsed", () => {
      expect(currentWarmupLimit(base, new Date("2026-01-02T12:00:00.000Z"))).toBe(20);
    });

    it("steps up once exactly one full ramp interval has elapsed", () => {
      expect(currentWarmupLimit(base, new Date("2026-01-04T00:00:00.000Z"))).toBe(30);
    });

    it("steps up multiple times across several elapsed intervals", () => {
      // 10 days elapsed / 3-day intervals = 3 full intervals -> 20 + 30 = 50
      expect(currentWarmupLimit(base, new Date("2026-01-11T00:00:00.000Z"))).toBe(50);
    });

    it("caps at targetDailyLimit even after many elapsed intervals", () => {
      expect(currentWarmupLimit(base, new Date("2027-01-01T00:00:00.000Z"))).toBe(100);
    });

    it("never returns less than dailyLimit for a clock that looks like it's before startedAt", () => {
      expect(currentWarmupLimit(base, new Date("2025-01-01T00:00:00.000Z"))).toBe(20);
    });
  });

  describe("shouldPauseForHealth", () => {
    it("does not pause when sentCount is zero, regardless of other counts (avoids false pause/divide-by-zero)", () => {
      const result = shouldPauseForHealth({ sentCount: 0, bouncedCount: 0, complainedCount: 0 });
      expect(result.pause).toBe(false);
    });

    it("does not pause when bounce/complaint rates are within default thresholds", () => {
      const result = shouldPauseForHealth({ sentCount: 1000, bouncedCount: 10, complainedCount: 0 });
      expect(result.pause).toBe(false);
    });

    it("pauses when the bounce rate exceeds the default 5% threshold", () => {
      const result = shouldPauseForHealth({ sentCount: 100, bouncedCount: 6, complainedCount: 0 });
      expect(result.pause).toBe(true);
      expect(result.reason).toMatch(/bounce/i);
    });

    it("pauses when the complaint rate exceeds the default 0.1% threshold", () => {
      const result = shouldPauseForHealth({ sentCount: 1000, bouncedCount: 0, complainedCount: 2 });
      expect(result.pause).toBe(true);
      expect(result.reason).toMatch(/complaint/i);
    });

    it("respects custom thresholds", () => {
      const result = shouldPauseForHealth(
        { sentCount: 100, bouncedCount: 3, complainedCount: 0 },
        { maxBounceRate: 0.01 },
      );
      expect(result.pause).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// route validation (mocked pg pool)
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("denies GET /sending-domains when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("sending-domains route validation", () => {
  it("lists sending domains for the tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.sendingDomains).toHaveLength(1);
  });

  it("rejects creating a sending domain with an invalid domain string", async () => {
    const app = buildApp();
    queueResponses([...mockMembership()]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "not a domain" });

    expect(res.status).toBe(400);
  });

  it("creates a sending domain with a valid domain", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com", spf_status: "unchecked" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains`)
      .set("X-Dev-User-Id", USER_1)
      .send({ domain: "example.com" });

    expect(res.status).toBe(201);
    expect(res.body.sendingDomain.domain).toBe("example.com");
  });

  it("404s verifying a sending domain that doesn't exist for this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/verify`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe("warmup-configs route validation", () => {
  it("rejects a config where targetDailyLimit is below dailyLimit", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] }, // sending domain exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/warmup`)
      .set("X-Dev-User-Id", USER_1)
      .send({ dailyLimit: 50, targetDailyLimit: 20 });

    expect(res.status).toBe(400);
  });

  it("creates a warmup config and returns a computed currentLimit", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
      {
        rowCount: 1,
        rows: [
          {
            id: "wu-1",
            tenant_id: TENANT_A,
            sending_domain_id: DOMAIN_1,
            daily_limit: 20,
            target_daily_limit: 100,
            ramp_increment: 10,
            ramp_interval_days: 3,
            started_at: new Date().toISOString(),
            is_paused: false,
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/warmup`)
      .set("X-Dev-User-Id", USER_1)
      .send({ dailyLimit: 20, targetDailyLimit: 100 });

    expect(res.status).toBe(201);
    expect(res.body.warmupConfig.currentLimit).toBe(20);
  });

  it("404s GET warmup config when none exists yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/warmup`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("send-health route validation", () => {
  it("rejects recording a day's stats with a malformed statDate", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/health`)
      .set("X-Dev-User-Id", USER_1)
      .send({ statDate: "not-a-date", sentCount: 10 });

    expect(res.status).toBe(400);
  });

  it("records a day's stats", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
      {
        rowCount: 1,
        rows: [
          {
            id: "hs-1",
            tenant_id: TENANT_A,
            sending_domain_id: DOMAIN_1,
            stat_date: "2026-01-01",
            sent_count: 100,
            bounced_count: 2,
            complained_count: 0,
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/health`)
      .set("X-Dev-User-Id", USER_1)
      .send({ statDate: "2026-01-01", sentCount: 100, bouncedCount: 2, complainedCount: 0 });

    expect(res.status).toBe(201);
    expect(res.body.sendHealthStat.sent_count).toBe(100);
  });

  it("GET / reports pauseEvaluation computed from the most recent day's row", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: DOMAIN_1, tenant_id: TENANT_A, domain: "example.com" }] },
      {
        rowCount: 1,
        rows: [
          {
            id: "hs-1",
            tenant_id: TENANT_A,
            sending_domain_id: DOMAIN_1,
            stat_date: "2026-01-01",
            sent_count: 100,
            bounced_count: 10,
            complained_count: 0,
          },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/sending-domains/${DOMAIN_1}/health`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.pauseEvaluation.pause).toBe(true);
  });
});

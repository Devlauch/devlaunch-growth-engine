import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { publicLeadsRouter } = await import("../src/routes/publicLeads.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public", publicLeadsRouter);
  app.use(errorHandler);
  return app;
}

const ALLOWED_ORIGIN = "https://customer-site.example";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe("POST /api/v1/public/projects/:projectPublicKey/leads", () => {
  it("rejects an unknown project public key with 404 and never writes a lead", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // project lookup: none found
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_totally_unknown_key_xxxxx/leads")
      .set("Origin", ALLOWED_ORIGIN)
      .send({ email: "lead@example.com", name: "Jane Lead" });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO leads"), expect.anything());
  });

  it("rejects a request from a non-allowlisted origin, even with a valid key", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "project-1",
            tenant_id: "tenant-1",
            allowed_origins: [ALLOWED_ORIGIN],
            public_widget_enabled: true,
          },
        ],
      })
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid_key_but_bad_origin/leads")
      .set("Origin", "https://evil-site.example")
      .send({ email: "lead@example.com" });

    expect(res.status).toBe(403);
  });

  it("accepts a valid key + allowlisted origin and writes through the shared lead-ingestion path", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "project-1",
            tenant_id: "tenant-1",
            allowed_origins: [ALLOWED_ORIGIN],
            public_widget_enabled: true,
          },
        ],
      })
      .mockResolvedValueOnce(undefined) // set_config current_tenant_id
      .mockResolvedValueOnce({ rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }) // insert lead
      .mockResolvedValueOnce(undefined) // insert audit_event
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid_key/leads")
      .set("Origin", ALLOWED_ORIGIN)
      .send({ email: "lead@example.com", name: "Jane Lead" });

    expect(res.status).toBe(201);
    expect(res.body.lead.id).toBe("lead-1");

    const auditCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"));
    expect(auditCall).toBeDefined();
    const auditMetadata = JSON.parse(auditCall![1][2]);
    expect(auditMetadata.source).toBe("public_widget");
  });

  it("enforces rate limiting (per IP and per key) once the configured threshold is exceeded", async () => {
    // Every call takes the same "unknown key -> 404" path, which is cheap
    // to mock repeatedly and still exercises the rate limiter (which runs
    // before any DB lookup). With `trust proxy` not enabled, every request
    // in this test resolves to the same source IP, so the per-IP limiter
    // (default max 10/min) trips first — still proving rate limiting is
    // enforced on this endpoint; publicLeads.ts applies the per-key limiter
    // with the exact same mechanism (see src/middleware/rateLimit.ts).
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });

    const app = buildApp();
    const key = "pk_rate_limit_test_key";
    const maxRequests = Math.max(
      Number(process.env.PUBLIC_LEADS_RATE_LIMIT_PER_IP_PER_MIN ?? 10),
      Number(process.env.PUBLIC_LEADS_RATE_LIMIT_PER_KEY_PER_MIN ?? 60),
    );

    let lastStatus = 0;
    for (let i = 0; i < maxRequests + 5; i++) {
      const res = await request(app)
        .post(`/api/v1/public/projects/${key}/leads`)
        .set("Origin", ALLOWED_ORIGIN)
        .send({ email: `lead${i}@example.com` });
      lastStatus = res.status;
      if (res.status === 429) break;
    }

    expect(lastStatus).toBe(429);
  });
});

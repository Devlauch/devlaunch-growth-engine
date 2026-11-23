import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { publicAnalyticsRouter } = await import("../src/routes/publicAnalytics.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public", publicAnalyticsRouter);
  app.use(errorHandler);
  return app;
}

const ALLOWED_ORIGIN = "https://customer-site.example";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function resolvedProjectRow() {
  return {
    rowCount: 1,
    rows: [
      {
        id: "project-1",
        tenant_id: "tenant-1",
        allowed_origins: [ALLOWED_ORIGIN],
        public_widget_enabled: true,
      },
    ],
  };
}

describe("POST /api/v1/public/projects/:projectPublicKey/analytics/collect", () => {
  it("rejects an unknown project public key with 404 and never writes any tracking rows", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // project lookup: none found
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_totally_unknown_key_xxxxx/analytics/collect")
      .set("Origin", ALLOWED_ORIGIN)
      .send({
        type: "pageview",
        visitorId: "visitor_aaaaaaaaaaaa",
        sessionId: "session_aaaaaaaaaaaa",
        url: "https://customer-site.example/",
      });

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO site_pageviews"), expect.anything());
  });

  it("rejects a request from a non-allowlisted origin, even with a valid key", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce(resolvedProjectRow())
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid_key_but_bad_origin/analytics/collect")
      .set("Origin", "https://evil-site.example")
      .send({
        type: "pageview",
        visitorId: "visitor_aaaaaaaaaaaa",
        sessionId: "session_aaaaaaaaaaaa",
      });

    expect(res.status).toBe(403);
  });

  it("accepts a valid pageview beacon and writes visitor + session + pageview rows", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce(resolvedProjectRow())
      .mockResolvedValueOnce(undefined) // set_config current_tenant_id
      .mockResolvedValueOnce(undefined) // INSERT site_visitors
      .mockResolvedValueOnce(undefined) // INSERT site_sessions
      .mockResolvedValueOnce(undefined) // INSERT site_pageviews
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/analytics/collect")
      .set("Origin", ALLOWED_ORIGIN)
      .set("User-Agent", "Mozilla/5.0 (real browser)")
      .send({
        type: "pageview",
        visitorId: "visitor_aaaaaaaaaaaa",
        sessionId: "session_aaaaaaaaaaaa",
        url: "https://customer-site.example/pricing?utm_source=newsletter",
        referrer: "https://google.com/",
        utmSource: "newsletter",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ tracked: true });

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO site_visitors"), expect.anything());
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO site_sessions"), expect.anything());
    const pageviewCall = queryMock.mock.calls.find((call) => typeof call[0] === "string" && call[0].includes("INSERT INTO site_pageviews"));
    expect(pageviewCall).toBeDefined();
    expect(pageviewCall![1]).toContain("session_aaaaaaaaaaaa");
  });

  it("marks a known crawler User-Agent's session as a bot (still stored, never dropped)", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce(resolvedProjectRow())
      .mockResolvedValueOnce(undefined) // set_config current_tenant_id
      .mockResolvedValueOnce(undefined) // INSERT site_visitors
      .mockResolvedValueOnce(undefined) // INSERT site_sessions
      .mockResolvedValueOnce(undefined) // INSERT site_pageviews
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/analytics/collect")
      .set("Origin", ALLOWED_ORIGIN)
      .set("User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")
      .send({
        type: "pageview",
        visitorId: "visitor_bbbbbbbbbbbb",
        sessionId: "session_bbbbbbbbbbbb",
        url: "https://customer-site.example/",
      });

    expect(res.status).toBe(201);
    const sessionCall = queryMock.mock.calls.find((call) => typeof call[0] === "string" && call[0].includes("INSERT INTO site_sessions"));
    expect(sessionCall).toBeDefined();
    // is_bot is the last bound parameter in the INSERT.
    expect(sessionCall![1][sessionCall![1].length - 1]).toBe(true);
  });

  it("accepts a custom event beacon and writes a site_events row", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config lookup key
      .mockResolvedValueOnce(resolvedProjectRow())
      .mockResolvedValueOnce(undefined) // set_config current_tenant_id
      .mockResolvedValueOnce(undefined) // INSERT site_visitors
      .mockResolvedValueOnce(undefined) // INSERT site_sessions
      .mockResolvedValueOnce(undefined) // INSERT site_events
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/analytics/collect")
      .set("Origin", ALLOWED_ORIGIN)
      .send({
        type: "event",
        visitorId: "visitor_cccccccccccc",
        sessionId: "session_cccccccccccc",
        eventName: "form_submitted",
        properties: { formId: "contact" },
      });

    expect(res.status).toBe(201);
    const eventCall = queryMock.mock.calls.find((call) => typeof call[0] === "string" && call[0].includes("INSERT INTO site_events"));
    expect(eventCall).toBeDefined();
    expect(eventCall![1]).toContain("form_submitted");
  });

  it("rejects an 'event' beacon missing eventName with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/projects/pk_valid/analytics/collect")
      .set("Origin", ALLOWED_ORIGIN)
      .send({
        type: "event",
        visitorId: "visitor_dddddddddddd",
        sessionId: "session_dddddddddddd",
      });

    expect(res.status).toBe(400);
  });
});

import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-client pattern as listmonkWebhooks.test.ts / compliance.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// The route's own job is orchestration (dedup, contact extraction, calling
// ingestLead, writing the chatwoot_contact_leads mapping) — ingestLead's
// own internals (leads insert, audit_events, usage_events,
// notifyTenantOwnersAndAdmins fan-out) are already covered by
// leadIngestion.test.ts, so this file mocks it to a simple stub rather than
// re-mocking that whole multi-query chain here.
const ingestLeadMock = vi.fn(async () => ({ id: "lead-1", createdAt: "2024-01-01T00:00:00.000Z" }));
vi.mock("../src/lib/leadIngestion.js", () => ({
  ingestLead: ingestLeadMock,
}));

// Real env.ts (not a partial `vi.mock` of the whole module) — a partial
// mock of config/env.js breaks src/lib/logger.ts's `pino({ level:
// env.logLevel })` call (logLevel ends up undefined), which this route
// pulls in transitively via src/lib/logger.ts. Setting the real env var
// before importing avoids that trap entirely.
const WEBHOOK_SECRET = "test-shared-secret";
process.env.CHATWOOT_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { chatwootWebhooksRouter } = await import("../src/routes/chatwootWebhooks.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp(router = chatwootWebhooksRouter) {
  const app = express();
  // Mirrors app.ts's express.json({ verify }) exactly — chatwootWebhooks.ts
  // verifies its HMAC signature over req.rawBody, so the test harness must
  // capture it the same way the real app does.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use("/api/v1/webhooks/chatwoot", router);
  app.use(errorHandler);
  return app;
}

function sign(body: unknown, timestamp: string, secret = WEBHOOK_SECRET): string {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return `sha256=${hmac}`;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";

function signedRequest(app: express.Express, body: Record<string, unknown>) {
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app)
    .post(`/api/v1/webhooks/chatwoot/${TENANT_A}/${PROJECT_1}`)
    .set("X-Chatwoot-Timestamp", ts)
    .set("X-Chatwoot-Signature", sign(body, ts))
    .send(body);
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  ingestLeadMock.mockClear();
});

describe("POST /api/v1/webhooks/chatwoot/:tenantId/:projectId — signature auth", () => {
  it("rejects a request with no signature/timestamp at all", async () => {
    const app = buildApp();

    const res = await request(app)
      .post(`/api/v1/webhooks/chatwoot/${TENANT_A}/${PROJECT_1}`)
      .send({ event: "conversation_updated" });

    expect(res.status).toBe(401);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects a request signed with the wrong secret", async () => {
    const app = buildApp();
    const body = { event: "conversation_updated" };
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post(`/api/v1/webhooks/chatwoot/${TENANT_A}/${PROJECT_1}`)
      .set("X-Chatwoot-Timestamp", ts)
      .set("X-Chatwoot-Signature", sign(body, ts, "wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp outside the replay window", async () => {
    const app = buildApp();
    const body = { event: "conversation_updated" };
    const staleTs = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 minutes old

    const res = await request(app)
      .post(`/api/v1/webhooks/chatwoot/${TENANT_A}/${PROJECT_1}`)
      .set("X-Chatwoot-Timestamp", staleTs)
      .set("X-Chatwoot-Signature", sign(body, staleTs))
      .send(body);

    expect(res.status).toBe(401);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/webhooks/chatwoot/:tenantId/:projectId — recording events", () => {
  it("404s when no chatwoot integration is registered for this tenant/project", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // integration lookup: none
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const res = await signedRequest(app, { event: "conversation_updated" });

    expect(res.status).toBe(404);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("reports deduplicated:true and never calls ingestLead for a repeat delivery of the same event", async () => {
    const app = buildApp();
    const body = { event: "message_created", id: 6 };
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "int-1" }] }) // integration lookup
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ON CONFLICT DO NOTHING -> no row
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduplicated: true });
    expect(ingestLeadMock).not.toHaveBeenCalled();
  });

  it("records a non-syncable event (conversation_updated) as 'ignored' without touching leads", async () => {
    const app = buildApp();
    const body = { event: "conversation_updated", conversation: { id: 77 } };
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "int-1" }] }) // integration lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-1" }] }) // insert webhook event
      .mockResolvedValueOnce(undefined) // UPDATE status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduplicated: false, leadId: null, status: "ignored" });
    expect(ingestLeadMock).not.toHaveBeenCalled();

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE integration_webhook_events"),
    );
    expect(updateCall![1]).toEqual(["evt-1", "ignored"]);
  });

  it("ignores an outgoing message_created event (an agent/bot's own reply, not a visitor)", async () => {
    const app = buildApp();
    const body = { event: "message_created", message_type: "outgoing", sender: { id: 1, type: "AgentBot" } };
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "int-1" }] }) // integration lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-1" }] }) // insert webhook event
      .mockResolvedValueOnce(undefined) // UPDATE status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ignored" });
    expect(ingestLeadMock).not.toHaveBeenCalled();
  });

  it("reuses an existing chatwoot_contact_leads mapping instead of calling ingestLead again", async () => {
    const app = buildApp();
    const body = { event: "contact_created", contact: { id: 42, name: "Ada", email: "ada@example.com" } };
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "int-1" }] }) // integration lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-1" }] }) // insert webhook event
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ lead_id: "lead-existing" }] }) // existing mapping found
      .mockResolvedValueOnce(undefined) // UPDATE status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduplicated: false, leadId: "lead-existing", status: "processed" });
    expect(ingestLeadMock).not.toHaveBeenCalled();
  });

  it("calls ingestLead and records a new chatwoot_contact_leads mapping for a first-time contact", async () => {
    const app = buildApp();
    const body = { event: "contact_created", contact: { id: 42, name: "Ada", email: "ada@example.com" } };
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "int-1" }] }) // integration lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-1" }] }) // insert webhook event
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no existing mapping
      .mockResolvedValueOnce(undefined) // INSERT chatwoot_contact_leads
      .mockResolvedValueOnce(undefined) // UPDATE status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduplicated: false, leadId: "lead-1", status: "processed" });
    expect(ingestLeadMock).toHaveBeenCalledTimes(1);
    const [[call]] = ingestLeadMock.mock.calls;
    expect(call).toMatchObject({
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      source: "public_widget",
      origin: "chatwoot",
      input: { name: "Ada", email: "ada@example.com" },
    });

    const mappingInsert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO chatwoot_contact_leads"),
    );
    expect(mappingInsert![1]).toEqual([TENANT_A, PROJECT_1, "int-1", "42", "lead-1"]);
  });

  it("rejects malformed tenantId/projectId path params before touching the database", async () => {
    const app = buildApp();
    const body = { event: "conversation_updated" };
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post(`/api/v1/webhooks/chatwoot/not-a-uuid/${PROJECT_1}`)
      .set("X-Chatwoot-Timestamp", ts)
      .set("X-Chatwoot-Signature", sign(body, ts))
      .send(body);

    expect(res.status).toBe(400);
    // zod's params.parse() throws before BEGIN is ever issued, so the
    // route's `began` guard means no ROLLBACK query is attempted either —
    // nothing here should reach the mocked query function at all.
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("when CHATWOOT_WEBHOOK_SECRET is not configured", () => {
  it("rejects every request with 503 rather than accepting unauthenticated events", async () => {
    const originalSecret = process.env.CHATWOOT_WEBHOOK_SECRET;
    delete process.env.CHATWOOT_WEBHOOK_SECRET;
    vi.resetModules();

    const { chatwootWebhooksRouter: router } = await import("../src/routes/chatwootWebhooks.js");
    const app = buildApp(router);

    const body = { event: "conversation_updated" };
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post(`/api/v1/webhooks/chatwoot/${TENANT_A}/${PROJECT_1}`)
      .set("X-Chatwoot-Timestamp", ts)
      .set("X-Chatwoot-Signature", sign(body, ts))
      .send(body);

    expect(res.status).toBe(503);
    expect(connectMock).not.toHaveBeenCalled();

    if (originalSecret === undefined) delete process.env.CHATWOOT_WEBHOOK_SECRET;
    else process.env.CHATWOOT_WEBHOOK_SECRET = originalSecret;
  });
});

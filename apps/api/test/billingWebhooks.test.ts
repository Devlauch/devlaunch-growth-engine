import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const notifyMock = vi.fn(async () => undefined);
vi.mock("../src/lib/notify.js", () => ({
  notifyTenantOwnersAndAdmins: notifyMock,
}));

const RAZORPAY_SECRET = "rzp_webhook_secret";
process.env.RAZORPAY_KEY_ID = "rzp_key_id";
process.env.RAZORPAY_KEY_SECRET = "rzp_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = RAZORPAY_SECRET;

const { billingWebhooksRouter } = await import("../src/routes/billingWebhooks.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use("/api/v1/webhooks/billing", billingWebhooksRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";

function sign(body: string, secret = RAZORPAY_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function razorpayRequest(app: express.Express, body: Record<string, unknown>, eventId = "evt_1") {
  const raw = JSON.stringify(body);
  return request(app)
    .post(`/api/v1/webhooks/billing/${TENANT_A}/razorpay`)
    .set("X-Razorpay-Signature", sign(raw))
    .set("x-razorpay-event-id", eventId)
    .set("Content-Type", "application/json")
    .send(raw);
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  notifyMock.mockClear();
});

describe("POST /api/v1/webhooks/billing/:tenantId/:provider — signature auth", () => {
  it("rejects a request with no signature at all", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/webhooks/billing/${TENANT_A}/razorpay`)
      .send({ event: "subscription.activated" });

    expect(res.status).toBe(401);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects a request signed with the wrong secret (tamper/forgery rejection)", async () => {
    const app = buildApp();
    const body = { event: "subscription.activated" };
    const raw = JSON.stringify(body);

    const res = await request(app)
      .post(`/api/v1/webhooks/billing/${TENANT_A}/razorpay`)
      .set("X-Razorpay-Signature", sign(raw, "wrong-secret"))
      .set("Content-Type", "application/json")
      .send(raw);

    expect(res.status).toBe(401);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("503s when the provider is not configured", async () => {
    const originalKey = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    vi.resetModules();
    const { billingWebhooksRouter: router } = await import("../src/routes/billingWebhooks.js");
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request).rawBody = buf) }));
    app.use("/api/v1/webhooks/billing", router);
    const { errorHandler: freshErrorHandler } = await import("../src/middleware/errorHandler.js");
    app.use(freshErrorHandler);

    const res = await request(app)
      .post(`/api/v1/webhooks/billing/${TENANT_A}/razorpay`)
      .send({ event: "x" });

    expect(res.status).toBe(503);
    process.env.RAZORPAY_KEY_ID = originalKey;
  });
});

describe("POST /api/v1/webhooks/billing/:tenantId/:provider — idempotency", () => {
  it("deduplicates a retried delivery of the same event id without reprocessing", async () => {
    const app = buildApp();
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ON CONFLICT DO NOTHING -> already exists
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await razorpayRequest(app, { event: "subscription.activated" }, "evt-dup-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, deduplicated: true });

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO billing_webhook_events"),
    );
    expect(insertCall![1]).toEqual([TENANT_A, "razorpay", "evt-dup-1", "subscription.activated", JSON.stringify({ event: "subscription.activated" })]);
  });
});

describe("POST /api/v1/webhooks/billing/:tenantId/:provider — subscription.activated applies the plan", () => {
  it("upserts billing_subscriptions and calls applyPlanChange's UPDATE tenants/INSERT audit_events", async () => {
    const app = buildApp();
    const body = {
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: { id: "sub_1", status: "active", notes: { tenantId: TENANT_A, planId: "starter" } },
        },
      },
    };

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-row-1" }] }) // insert webhook event
      .mockResolvedValueOnce(undefined) // upsert billing_subscriptions
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: TENANT_A, slug: "acme", name: "Acme", plan: "starter" }] }) // UPDATE tenants
      .mockResolvedValueOnce(undefined) // INSERT audit_events
      .mockResolvedValueOnce(undefined) // UPDATE billing_webhook_events status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await razorpayRequest(app, body, "evt-activate-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: true });

    const tenantUpdate = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants"));
    expect(tenantUpdate![1]).toEqual([TENANT_A, "starter"]);

    const auditInsert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditInsert![0]).toContain("'system'");
    expect(auditInsert![0]).toContain("tenant.plan_changed");
  });

  it("refuses to apply a plan change when the event's own tenantId doesn't match the URL tenantId", async () => {
    const app = buildApp();
    const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
    const body = {
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: { id: "sub_evil", status: "active", notes: { tenantId: OTHER_TENANT, planId: "starter" } },
        },
      },
    };

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-row-2" }] }) // insert webhook event
      .mockResolvedValueOnce(undefined) // UPDATE billing_webhook_events -> failed
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await razorpayRequest(app, body, "evt-mismatch-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: "tenant_mismatch" });
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants"))).toBe(false);
  });
});

describe("POST /api/v1/webhooks/billing/:tenantId/:provider — payment.failed", () => {
  it("marks past_due and notifies tenant owners/admins via the existing notify.ts system", async () => {
    const app = buildApp();
    const body = {
      event: "payment.failed",
      payload: {
        payment: { entity: { id: "pay_1", amount: 50000, currency: "INR", notes: { tenantId: TENANT_A, planId: "starter" } } },
      },
    };

    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "evt-row-3" }] }) // insert webhook event
      .mockResolvedValueOnce(undefined) // UPDATE billing_webhook_events status
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await razorpayRequest(app, body, "evt-fail-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ tenantId: TENANT_A, type: "billing.payment_failed" });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";
const INTEGRATION_1 = "33333333-3333-3333-3333-333333333333";

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

const ORIGINAL_SECRET = process.env.POSTIZ_WEBHOOK_SECRET;

/**
 * config/env.ts reads process.env ONCE at module-evaluation time (same
 * convention noted in listmonkIntegration.test.ts/credentialEncryption.test.ts),
 * and apps/api/src/routes/postizWebhooks.ts imports `env` statically at its
 * top. Because vitest shares a module registry across test files within a
 * worker, an EARLIER test file may have already evaluated config/env.ts
 * before this file ever sets POSTIZ_WEBHOOK_SECRET — a plain
 * `process.env.POSTIZ_WEBHOOK_SECRET = ...` after that point would have no
 * effect on the already-cached `env` object. vi.resetModules() + a fresh
 * dynamic import, with the env var set BEFORE that import, is what actually
 * makes each test's intended secret value take effect.
 */
async function buildAppWithSecret(secret: string | undefined) {
  if (secret === undefined) delete process.env.POSTIZ_WEBHOOK_SECRET;
  else process.env.POSTIZ_WEBHOOK_SECRET = secret;

  vi.resetModules();
  const { postizWebhooksRouter } = await import("../src/routes/postizWebhooks.js");
  const { errorHandler } = await import("../src/middleware/errorHandler.js");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/webhooks/postiz", postizWebhooksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.POSTIZ_WEBHOOK_SECRET;
  else process.env.POSTIZ_WEBHOOK_SECRET = ORIGINAL_SECRET;
  vi.resetModules();
});

describe(`POST /api/v1/webhooks/postiz/:tenantId/:projectId`, () => {
  it("rejects with 503 when POSTIZ_WEBHOOK_SECRET is not configured — never silently accepts", async () => {
    const app = await buildAppWithSecret(undefined);
    const res = await request(app).post(`/api/v1/webhooks/postiz/${TENANT_1}/${PROJECT_1}`).send({ type: "post.published" });
    expect(res.status).toBe(503);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the shared secret is missing or wrong", async () => {
    const app = await buildAppWithSecret("real-secret");
    const res = await request(app)
      .post(`/api/v1/webhooks/postiz/${TENANT_1}/${PROJECT_1}`)
      .query({ secret: "wrong" })
      .send({ type: "post.published" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unregistered tenant/project rather than guessing a tenant", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);
    const app = await buildAppWithSecret("real-secret");
    const res = await request(app)
      .post(`/api/v1/webhooks/postiz/${TENANT_1}/${PROJECT_1}`)
      .query({ secret: "real-secret" })
      .send({ type: "post.published" });
    expect(res.status).toBe(404);
  });

  it("records a real pending event into integration_webhook_events on a valid request", async () => {
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 1, rows: [{ id: INTEGRATION_1 }] }, // integration lookup
      { rowCount: 1, rows: [{ id: "event-1" }] }, // insert integration_webhook_events
      undefined, // COMMIT
    ]);
    const app = await buildAppWithSecret("real-secret");

    const res = await request(app)
      .post(`/api/v1/webhooks/postiz/${TENANT_1}/${PROJECT_1}`)
      .set("X-Postiz-Webhook-Secret", "real-secret")
      .send({ type: "post.published", postId: "postiz-post-1" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.deduplicated).toBe(false);
    expect(res.body.note).toMatch(/Best-effort/);

    const insertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO integration_webhook_events"),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall![1]).toEqual(
      expect.arrayContaining([TENANT_1, INTEGRATION_1, "postiz-post-1", "post.published"]),
    );
  });

  it("deduplicates a retried delivery via the integration_webhook_events unique constraint", async () => {
    queueResponses([
      undefined,
      undefined,
      { rowCount: 1, rows: [{ id: INTEGRATION_1 }] },
      { rowCount: 0, rows: [] }, // ON CONFLICT DO NOTHING
      undefined,
    ]);
    const app = await buildAppWithSecret("real-secret");

    const res = await request(app)
      .post(`/api/v1/webhooks/postiz/${TENANT_1}/${PROJECT_1}`)
      .set("X-Postiz-Webhook-Secret", "real-secret")
      .send({ type: "post.published", postId: "postiz-post-1" });

    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
  });
});

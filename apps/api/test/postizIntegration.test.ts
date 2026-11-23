import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Must be set BEFORE the dynamic import below: config/env.ts reads
// process.env once at module-evaluation time (same convention as
// credentialEncryption.test.ts / listmonkIntegration.test.ts).
process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");

const { postizIntegrationRouter } = await import("../src/routes/postizIntegration.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/integrations/postiz", postizIntegrationRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const POST_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";
const BASE = `/api/v1/tenants/${TENANT_1}/projects/${PROJECT_1}/integrations/postiz`;

function mockMembership(role = "owner") {
  return [undefined, undefined, { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }];
}

function mockProjectInTenant() {
  return { rowCount: 1, rows: [{ "?column?": 1 }] };
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

function jsonFetchResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");
  delete process.env.POSTIZ_BASE_URL;
  delete process.env.POSTIZ_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /connect", () => {
  it("verifies the API key via a real GET /me call before ever storing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetchResponse(200, { organization: { id: "org-1", name: "Acme Co" } }));
    vi.stubGlobal("fetch", fetchMock);

    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 0, rows: [] }, // existing org link: none
      { rows: [{ id: "integration-1" }] }, // insert integrations
      { rows: [] }, // insert postiz_organization_links
      { rows: [] }, // audit event
    ]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ baseUrl: "https://postiz.example.com", apiKey: "real-key" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://postiz.example.com/public/v1/me",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "real-key" }) }),
    );
    expect(res.status).toBe(201);
    expect(res.body.organization).toEqual({ id: "org-1", name: "Acme Co" });

    const insertCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO integrations"));
    expect(insertCall![1]).not.toContain("real-key"); // never stored in plaintext
  });

  it("rejects with 502 and never stores anything when the API key doesn't verify", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetchResponse(401, { msg: "Invalid API key" }));
    vi.stubGlobal("fetch", fetchMock);

    queueResponses([...mockMembership(), mockProjectInTenant(), { rowCount: 0, rows: [] }]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ baseUrl: "https://postiz.example.com", apiKey: "bad-key" });

    expect(res.status).toBe(502);
    const insertCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO integrations"));
    expect(insertCall).toBeUndefined();
  });

  it("refuses to rebind an already-connected tenant to a second Postiz Organization (1:1 enforcement)", async () => {
    queueResponses([...mockMembership(), mockProjectInTenant(), { rowCount: 1, rows: [{ postiz_organization_id: "org-existing" }] }]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/connect`)
      .set("X-Dev-User-Id", USER_1)
      .send({ baseUrl: "https://postiz.example.com", apiKey: "another-key" });

    expect(res.status).toBe(409);
  });
});

describe("GET /health", () => {
  it("reports not_configured with no fabricated health result when nothing is connected", async () => {
    queueResponses([...mockMembership(), mockProjectInTenant(), { rowCount: 0, rows: [] }]);
    const app = buildApp();
    const res = await request(app).get(`${BASE}/health`).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("not_configured");
  });

  it("updates integrations.status to 'error' (never leaves a stale 'connected') when Postiz is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const encrypted = (await import("../src/lib/credentialEncryption.js")).encryptCredential("a-real-key");
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ config: { baseUrl: "https://postiz.example.com" }, encrypted_credential_ref: encrypted, status: "connected" }] },
      { rows: [] }, // UPDATE integrations status='error'
    ]);

    const app = buildApp();
    const res = await request(app).get(`${BASE}/health`).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");

    const updateCall = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("UPDATE integrations"));
    expect(updateCall![1]).toEqual([TENANT_1, PROJECT_1, "error"]);
  });
});

describe("POST /posts/:postId/publish — the non-negotiable approval gate", () => {
  it("refuses to publish a post with no approval row at all", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: POST_1, status: "draft", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: null }] },
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(403);
  });

  it("refuses to publish a post whose approval is still 'pending' (not yet decided by a human)", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "pending_approval", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: "pending" }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(403);
  });

  it("refuses to publish a post whose approval was 'rejected'", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "pending_approval", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: "rejected" }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(403);
  });

  it("publishes for real (via the real PostizSocialPostProvider) once — and only once — a real approval row is 'approved'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetchResponse(200, { posts: [{ id: "postiz-post-99", group: "group-99" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const encrypted = (await import("../src/lib/credentialEncryption.js")).encryptCredential("a-real-key");
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "pending_approval", content: "hi there", platforms: ["int-1"], scheduled_at: null, approval_status: "approved" }],
      },
      { rows: [] }, // UPDATE status='approved'
      { rowCount: 1, rows: [{ config: { baseUrl: "https://postiz.example.com" }, encrypted_credential_ref: encrypted, status: "connected" }] }, // getIntegrationCredential
      {
        rows: [{ id: POST_1, status: "published", postiz_post_id: "postiz-post-99", published_at: "2025-01-01T00:00:00.000Z" }],
      }, // UPDATE with published result
      { rows: [] }, // audit event
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});

    expect(res.status).toBe(200);
    expect(res.body.post.postiz_post_id).toBe("postiz-post-99");
    expect(fetchMock).toHaveBeenCalledWith("https://postiz.example.com/public/v1/posts", expect.objectContaining({ method: "POST" }));
  });

  it("reports postiz_not_configured (409) rather than fabricating a publish when no Postiz credential resolves, even though the approval is real", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "pending_approval", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: "approved" }],
      },
      { rows: [] }, // UPDATE status='approved'
      { rowCount: 0, rows: [] }, // getIntegrationCredential: nothing connected
      { rows: [] }, // UPDATE postiz_social_posts status='failed'... (not reached if provider throws NotConfiguredError handled before the failed-update branch)
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("postiz_not_configured");
  });

  it("is idempotent: publishing an already-published post is a no-op, never a duplicate publish call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: POST_1, status: "published", content: "hi", platforms: ["int-1"], scheduled_at: null, approval_status: "approved" }],
      },
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/publish`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyPublished).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /posts/:postId/request-approval", () => {
  it("inserts a real pending approvals row linked to this post (never auto-approves)", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: POST_1, status: "draft" }] },
      { rows: [{ id: "approval-1" }] }, // insert approvals
      { rows: [] }, // update postiz_social_posts
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/request-approval`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");

    const insertApproval = queryMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("INSERT INTO approvals"));
    expect(insertApproval![1]).toEqual(expect.arrayContaining([TENANT_1, POST_1, USER_1]));
    // Never writes status='approved' itself.
    expect(insertApproval![0]).not.toContain("'approved'");
  });

  it("refuses to re-submit a post that isn't 'draft'", async () => {
    queueResponses([...mockMembership(), mockProjectInTenant(), { rowCount: 1, rows: [{ id: POST_1, status: "published" }] }]);
    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/request-approval`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(409);
  });
});

describe("POST /posts/:postId/sync", () => {
  it("never fabricates engagement — reports the real error when Postiz is unreachable, without advancing status", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const encrypted = (await import("../src/lib/credentialEncryption.js")).encryptCredential("a-real-key");
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: POST_1, postiz_post_id: "postiz-post-99", status: "published" }] },
      { rowCount: 1, rows: [{ config: { baseUrl: "https://postiz.example.com" }, encrypted_credential_ref: encrypted, status: "connected" }] },
      { rows: [] }, // UPDATE last_error
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/posts/${POST_1}/sync`).set("X-Dev-User-Id", USER_1).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("postiz_sync_failed");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPostizClient,
  PostizApiError,
  PostizUnreachableError,
  getPostizClientForTenant,
  checkHealth,
} from "../src/lib/postizClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("PostizClient", () => {
  it("sends the raw API key (no 'Bearer ' prefix) in the Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { organization: { id: "org-1", name: "Acme" } }));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "secret-key", fetchImpl });

    await client.getIdentity();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://postiz.example.com/public/v1/me",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "secret-key" }) }),
    );
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com/", apiKey: "k", fetchImpl });
    await client.listIntegrations();
    expect(fetchImpl).toHaveBeenCalledWith("https://postiz.example.com/public/v1/integrations", expect.anything());
  });

  it("createPost posts the mapped CreatePostDto shape and extracts the real postId from the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { posts: [{ id: "post-123", group: "group-1" }] }),
    );
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });

    const result = await client.createPost({
      type: "now",
      date: "2025-01-01T00:00:00.000Z",
      integrationIds: ["int-1"],
      content: "hello",
    });

    expect(result.postId).toBe("post-123");
    expect(result.postGroup).toBe("group-1");
    const [, options] = fetchImpl.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.type).toBe("now");
    expect(body.posts[0].integration.id).toBe("int-1");
    expect(body.posts[0].value[0].content).toBe("hello");
  });

  it("createPost never fabricates a postId when the response shape has none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });
    const result = await client.createPost({ type: "now", date: "2025-01-01T00:00:00.000Z", integrationIds: ["int-1"], content: "x" });
    expect(result.postId).toBeNull();
  });

  it("throws PostizApiError on a non-2xx response, carrying the real status and message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { msg: "Invalid API key" }));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "bad-key", fetchImpl });
    await expect(client.getIdentity()).rejects.toMatchObject({ status: 401, message: "Invalid API key" });
    await expect(client.getIdentity()).rejects.toBeInstanceOf(PostizApiError);
  });

  it("throws PostizUnreachableError on a network/transport failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });
    await expect(client.listIntegrations()).rejects.toBeInstanceOf(PostizUnreachableError);
  });

  it("checkHealth never throws — maps any failure to an honest { status: 'error' }", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });
    const health = await client.checkHealth();
    expect(health.status).toBe("error");
    expect(health.detail).toContain("timeout");
  });

  it("checkHealth reports { status: 'ok' } on a successful GET /me", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { organization: { id: "org-1", name: "Acme" } }));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });
    const health = await client.checkHealth();
    expect(health).toEqual({ status: "ok" });
  });

  it("getPostAnalytics passes the real postId/days through unmodified and returns the raw response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [{ label: "likes", value: 42 }]));
    const client = createPostizClient({ baseUrl: "https://postiz.example.com", apiKey: "k", fetchImpl });
    const result = await client.getPostAnalytics("post-123", 7);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://postiz.example.com/public/v1/analytics/post/post-123?date=7",
      expect.anything(),
    );
    expect(result).toEqual([{ label: "likes", value: 42 }]);
  });
});

describe("getPostizClientForTenant", () => {
  beforeEach(() => {
    delete process.env.POSTIZ_BASE_URL;
    delete process.env.POSTIZ_API_KEY;
  });

  it("returns { status: 'not_configured' } when no per-tenant credential and no env vars are set", async () => {
    const tenantDb = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    const resolution = await getPostizClientForTenant(tenantDb as never, "tenant-1", "project-1");
    expect(resolution).toMatchObject({ status: "not_configured" });
  });
});

// Matches the generic contract routes/integrations.ts's
// loadProviderHealthCheck() dynamically imports and calls.
describe("checkHealth(credential) — generic integrations.ts health-check contract", () => {
  it("reports 'error' (never throws) when config/secret are incomplete", async () => {
    const result = await checkHealth({ config: {}, secret: null });
    expect(result.status).toBe("error");
  });

  it("reports 'connected' on a real successful GET /me", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ organization: { id: "org-1", name: "Acme" } }) }),
    );
    const result = await checkHealth({ config: { baseUrl: "https://postiz.example.com" }, secret: "a-key" });
    expect(result).toEqual({ status: "connected" });
    vi.unstubAllGlobals();
  });

  it("reports 'error' with a real detail message when Postiz is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await checkHealth({ config: { baseUrl: "https://postiz.example.com" }, secret: "a-key" });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });
});

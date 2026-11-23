import { describe, it, expect, vi } from "vitest";
import {
  QdrantClient,
  NotConfiguredVectorStore,
  QdrantApiError,
  QdrantTimeoutError,
  QdrantNetworkError,
  QdrantNotConfiguredError,
  type QdrantFetcher,
} from "../src/lib/qdrantClient.js";

/**
 * All tests here exercise real request/response handling LOGIC (request
 * shapes, response mapping, error classification) against a fake, injected
 * `fetcher` — there is no real Qdrant instance reachable in this
 * environment, so no test ever talks to a real Qdrant server. Same
 * convention as test/llmProvider.test.ts.
 */

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("NotConfiguredVectorStore", () => {
  it("reports isConfigured: false and every method throws QdrantNotConfiguredError rather than fabricating a result", async () => {
    const store = new NotConfiguredVectorStore();
    expect(store.isConfigured).toBe(false);
    await expect(store.ensureCollection()).rejects.toBeInstanceOf(QdrantNotConfiguredError);
    await expect(store.upsertPoints()).rejects.toBeInstanceOf(QdrantNotConfiguredError);
    await expect(store.searchForTenant()).rejects.toBeInstanceOf(QdrantNotConfiguredError);
    await expect(store.deletePoints()).rejects.toBeInstanceOf(QdrantNotConfiguredError);
  });
});

describe("QdrantClient.ensureCollection", () => {
  it("sends PUT /collections/{name} with the documented vectors shape", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: true, status: "ok", time: 0.01 }));
    const client = new QdrantClient("https://qdrant.example.com", "test-key", { fetcher });

    await client.ensureCollection("docs", 1536, "Cosine");

    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://qdrant.example.com/collections/docs");
    expect(init.method).toBe("PUT");
    expect(init.headers["api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ vectors: { size: 1536, distance: "Cosine" } });
  });

  it("omits the api-key header entirely when no apiKey is configured (self-hosted convention)", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: true, status: "ok" }));
    const client = new QdrantClient("https://qdrant.local", null, { fetcher });

    await client.ensureCollection("docs", 10, "Dot");

    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["api-key"]).toBeUndefined();
  });

  it("treats a 400 'already exists' response as idempotent success, not a failure", async () => {
    const fetcher: QdrantFetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { status: { error: "Collection `docs` already exists!" }, time: 0.001 }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });

    await expect(client.ensureCollection("docs", 1536, "Cosine")).resolves.toBeUndefined();
  });

  it("throws QdrantApiError for any other 400 (real failure, not an already-exists case)", async () => {
    const fetcher: QdrantFetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { status: { error: "Wrong input: vector size mismatch" } }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });

    const err = await client.ensureCollection("docs", 1536, "Cosine").catch((e) => e);
    expect(err).toBeInstanceOf(QdrantApiError);
    expect((err as QdrantApiError).status).toBe(400);
  });

  it("classifies a 429 as retryable and a 401 as non-retryable", async () => {
    const client = new QdrantClient("https://qdrant.example.com", null, {
      fetcher: vi.fn().mockResolvedValue(jsonResponse(429, { status: { error: "rate limited" } })),
    });
    const err429 = await client.ensureCollection("docs", 10, "Cosine").catch((e) => e);
    expect((err429 as QdrantApiError).retryable).toBe(true);

    const client2 = new QdrantClient("https://qdrant.example.com", null, {
      fetcher: vi.fn().mockResolvedValue(jsonResponse(401, { status: { error: "unauthorized" } })),
    });
    const err401 = await client2.ensureCollection("docs", 10, "Cosine").catch((e) => e);
    expect((err401 as QdrantApiError).retryable).toBe(false);
  });

  it("converts an aborted (timed-out) request into QdrantTimeoutError", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher, timeoutMs: 10 });
    await expect(client.ensureCollection("docs", 10, "Cosine")).rejects.toBeInstanceOf(QdrantTimeoutError);
  });

  it("converts any other fetch rejection into QdrantNetworkError", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });
    await expect(client.ensureCollection("docs", 10, "Cosine")).rejects.toBeInstanceOf(QdrantNetworkError);
  });
});

describe("QdrantClient.upsertPoints", () => {
  it("sends PUT /collections/{name}/points with the documented points shape", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: { status: "completed" }, status: "ok" }));
    const client = new QdrantClient("https://qdrant.example.com", "key", { fetcher });

    await client.upsertPoints("docs", [
      { id: "11111111-1111-1111-1111-111111111111", vector: [0.1, 0.2], payload: { tenant_id: "tenant-1", text: "hello" } },
    ]);

    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://qdrant.example.com/collections/docs/points");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      points: [{ id: "11111111-1111-1111-1111-111111111111", vector: [0.1, 0.2], payload: { tenant_id: "tenant-1", text: "hello" } }],
    });
  });

  it("throws QdrantApiError on a non-ok response", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(500, { status: { error: "internal error" } }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });
    await expect(client.upsertPoints("docs", [])).rejects.toBeInstanceOf(QdrantApiError);
  });
});

describe("QdrantClient.searchForTenant", () => {
  it("sends POST /collections/{name}/points/search with vector/limit/filter and ALWAYS merges a tenant_id match clause", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        result: [
          { id: "a", score: 0.9, payload: { tenant_id: "tenant-1", text: "match one" } },
          { id: "b", score: 0.7, payload: { tenant_id: "tenant-1", text: "match two" } },
        ],
        status: "ok",
      }),
    );
    const client = new QdrantClient("https://qdrant.example.com", "key", { fetcher });

    const results = await client.searchForTenant("docs", "tenant-1", [0.1, 0.2], { limit: 5 });

    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://qdrant.example.com/collections/docs/points/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.vector).toEqual([0.1, 0.2]);
    expect(body.limit).toBe(5);
    expect(body.with_payload).toBe(true);
    expect(body.filter.must).toContainEqual({ key: "tenant_id", match: { value: "tenant-1" } });

    expect(results).toEqual([
      { id: "a", score: 0.9, payload: { tenant_id: "tenant-1", text: "match one" } },
      { id: "b", score: 0.7, payload: { tenant_id: "tenant-1", text: "match two" } },
    ]);
  });

  it("preserves a caller-supplied filter's must clauses alongside the tenant_id clause (AND semantics), never overwriting it", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: [], status: "ok" }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });

    await client.searchForTenant("docs", "tenant-1", [0.1], {
      filter: { must: [{ key: "category", match: { value: "faq" } }] },
    });

    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.filter.must).toContainEqual({ key: "category", match: { value: "faq" } });
    expect(body.filter.must).toContainEqual({ key: "tenant_id", match: { value: "tenant-1" } });
  });

  it("defaults payload to {} when a result item has no payload field", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: [{ id: "a", score: 0.5 }], status: "ok" }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });
    const results = await client.searchForTenant("docs", "tenant-1", [0.1]);
    expect(results).toEqual([{ id: "a", score: 0.5, payload: {} }]);
  });

  it("throws QdrantApiError on a non-ok response", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(404, { status: { error: "collection not found" } }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });
    await expect(client.searchForTenant("missing", "tenant-1", [0.1])).rejects.toBeInstanceOf(QdrantApiError);
  });
});

describe("QdrantClient.deletePoints", () => {
  it("sends POST /collections/{name}/points/delete with { points: [ids] }", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { result: { status: "completed" }, status: "ok" }));
    const client = new QdrantClient("https://qdrant.example.com", "key", { fetcher });

    await client.deletePoints("docs", ["a", "b"]);

    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://qdrant.example.com/collections/docs/points/delete");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ points: ["a", "b"] });
  });

  it("throws QdrantApiError on a non-ok response", async () => {
    const fetcher: QdrantFetcher = vi.fn().mockResolvedValue(jsonResponse(500, { status: { error: "internal error" } }));
    const client = new QdrantClient("https://qdrant.example.com", null, { fetcher });
    await expect(client.deletePoints("docs", ["a"])).rejects.toBeInstanceOf(QdrantApiError);
  });
});

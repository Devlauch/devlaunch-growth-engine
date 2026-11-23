import { describe, it, expect, vi } from "vitest";
import {
  OpenAiEmbeddingProvider,
  NotConfiguredEmbeddingProvider,
  EmbeddingApiError,
  EmbeddingTimeoutError,
  EmbeddingNetworkError,
  EmbeddingNotConfiguredError,
  type EmbeddingFetcher,
} from "../src/lib/embeddingProvider.js";

/**
 * All tests here exercise real request/response handling LOGIC (request
 * shape, response mapping, error classification) against a fake, injected
 * `fetcher` — there is no real OpenAI API key in this environment, so no
 * test ever talks to the real api.openai.com. Same convention as
 * test/llmProvider.test.ts.
 */

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("NotConfiguredEmbeddingProvider", () => {
  it("reports isConfigured: false and always throws EmbeddingNotConfiguredError rather than fabricating a vector", async () => {
    const provider = new NotConfiguredEmbeddingProvider();
    expect(provider.isConfigured).toBe(false);
    await expect(provider.embed(["hello"])).rejects.toBeInstanceOf(EmbeddingNotConfiguredError);
  });
});

describe("OpenAiEmbeddingProvider", () => {
  it("sends the documented request shape: Authorization Bearer header, model + input array body", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: "text-embedding-3-small" }),
    );
    const provider = new OpenAiEmbeddingProvider("test-key-123", "text-embedding-3-small", { fetcher });

    const result = await provider.embed(["hello world"]);

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.headers.authorization).toBe("Bearer test-key-123");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ model: "text-embedding-3-small", input: ["hello world"] });
  });

  it("re-sorts response data by index rather than trusting array order, so each vector pairs with the right input text", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { embedding: [9, 9], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
      }),
    );
    const provider = new OpenAiEmbeddingProvider("key", "model", { fetcher });
    const result = await provider.embed(["first", "second"]);
    expect(result).toEqual([[1, 1], [9, 9]]);
  });

  it("classifies a 401 (bad key) as a non-retryable EmbeddingApiError", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: "invalid api key" } }));
    const provider = new OpenAiEmbeddingProvider("bad-key", "model", { fetcher });

    const err = await provider.embed(["x"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingApiError);
    expect((err as EmbeddingApiError).status).toBe(401);
    expect((err as EmbeddingApiError).retryable).toBe(false);
  });

  it("classifies a 429 (rate limit) and 5xx as retryable EmbeddingApiError", async () => {
    const fetcher429: EmbeddingFetcher = vi.fn().mockResolvedValue(jsonResponse(429, { error: { message: "rate limited" } }));
    const provider429 = new OpenAiEmbeddingProvider("key", "model", { fetcher: fetcher429 });
    const err429 = await provider429.embed(["x"]).catch((e) => e);
    expect((err429 as EmbeddingApiError).retryable).toBe(true);

    const fetcher500: EmbeddingFetcher = vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: "overloaded" } }));
    const provider500 = new OpenAiEmbeddingProvider("key", "model", { fetcher: fetcher500 });
    const err500 = await provider500.embed(["x"]).catch((e) => e);
    expect((err500 as EmbeddingApiError).retryable).toBe(true);
  });

  it("converts an aborted (timed-out) request into EmbeddingTimeoutError", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const provider = new OpenAiEmbeddingProvider("key", "model", { fetcher, timeoutMs: 10 });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(EmbeddingTimeoutError);
  });

  it("converts any other fetch rejection into EmbeddingNetworkError", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new OpenAiEmbeddingProvider("key", "model", { fetcher });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(EmbeddingNetworkError);
  });

  it("never fabricates a vector: defaults to an empty array if embedding is somehow missing from a successful response", async () => {
    const fetcher: EmbeddingFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0 }] }));
    const provider = new OpenAiEmbeddingProvider("key", "model", { fetcher });
    const result = await provider.embed(["x"]);
    expect(result).toEqual([[]]);
  });
});

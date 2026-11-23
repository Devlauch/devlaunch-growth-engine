import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnthropicLlmProvider,
  NotConfiguredLlmProvider,
  LlmApiError,
  LlmTimeoutError,
  LlmNetworkError,
  LlmNotConfiguredError,
  type LlmFetcher,
} from "../src/lib/llmProvider.js";

/**
 * All tests here exercise real request/response handling LOGIC (headers,
 * body shape, token-count extraction, error classification) against a
 * fake, injected `fetcher` — there is no real Anthropic API key in this
 * environment, so no test ever talks to the real api.anthropic.com. Same
 * convention as test/hunterProvider.test.ts. See
 * test/llmRealApi.skip.test.ts for the documented-but-BLOCKED real-API
 * validation this would require.
 */

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("NotConfiguredLlmProvider", () => {
  it("reports isConfigured: false and always throws LlmNotConfiguredError rather than fabricating a completion", async () => {
    const provider = new NotConfiguredLlmProvider();
    expect(provider.isConfigured).toBe(false);
    await expect(provider.complete("hello")).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

describe("AnthropicLlmProvider", () => {
  it("sends the documented request shape: x-api-key header, anthropic-version header, model/messages body", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { content: [{ type: "text", text: "hi there" }], usage: { input_tokens: 10, output_tokens: 4 } }),
    );
    const provider = new AnthropicLlmProvider("test-key-123", "claude-sonnet-4-5-20250929", { fetcher });

    const result = await provider.complete("say hi", { maxTokens: 50, systemPrompt: "be brief" });

    expect(result).toEqual({ text: "hi there", inputTokens: 10, outputTokens: 4 });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("test-key-123");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-sonnet-4-5-20250929");
    expect(body.max_tokens).toBe(50);
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
  });

  it("concatenates multiple text content blocks into one string", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const provider = new AnthropicLlmProvider("key", "model", { fetcher });
    const result = await provider.complete("x");
    expect(result.text).toBe("part one part two");
  });

  it("never fabricates a token count: defaults to 0 if usage is somehow missing from a successful response", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "ok" }] }));
    const provider = new AnthropicLlmProvider("key", "model", { fetcher });
    const result = await provider.complete("x");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("classifies a 401 (bad key) as a non-retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    );
    const provider = new AnthropicLlmProvider("bad-key", "model", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect((err as LlmApiError).status).toBe(401);
    expect((err as LlmApiError).retryable).toBe(false);
  });

  it("classifies a 429 (rate limit) as a retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(429, { error: { message: "rate limited" } }));
    const provider = new AnthropicLlmProvider("key", "model", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect((err as LlmApiError).retryable).toBe(true);
  });

  it("classifies a 5xx as a retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: "overloaded" } }));
    const provider = new AnthropicLlmProvider("key", "model", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect((err as LlmApiError).retryable).toBe(true);
  });

  it("converts an aborted (timed-out) request into LlmTimeoutError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const provider = new AnthropicLlmProvider("key", "model", { fetcher, timeoutMs: 10 });

    await expect(provider.complete("x")).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it("converts any other fetch rejection into LlmNetworkError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new AnthropicLlmProvider("key", "model", { fetcher });

    await expect(provider.complete("x")).rejects.toBeInstanceOf(LlmNetworkError);
  });
});

describe("getLlmProvider resolver", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns NotConfiguredLlmProvider when no ANTHROPIC_API_KEY is set (the default in every environment this codebase runs in today)", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { anthropicApiKey: null, anthropicModel: "claude-sonnet-4-5-20250929" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(false);
    expect(provider.name).toBe("not_configured");
  });

  it("returns a real AnthropicLlmProvider when ANTHROPIC_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { anthropicApiKey: "a-real-key", anthropicModel: "claude-sonnet-4-5-20250929" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("anthropic");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AnthropicLlmProvider,
  OpenAiLlmProvider,
  GrokLlmProvider,
  GeminiLlmProvider,
  GroqLlmProvider,
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

describe("OpenAiCompatibleLlmProvider (OpenAI + Grok)", () => {
  it("OpenAiLlmProvider sends Authorization: Bearer, system prompt as a message, model/messages body, and hits api.openai.com", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "hi there" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    );
    const provider = new OpenAiLlmProvider("test-key-123", "gpt-4o", { fetcher });

    const result = await provider.complete("say hi", { maxTokens: 50, systemPrompt: "be brief" });

    expect(result).toEqual({ text: "hi there", inputTokens: 10, outputTokens: 4 });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key-123");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "say hi" },
    ]);
  });

  it("GrokLlmProvider hits api.x.ai with the same OpenAI-compatible shape", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "yo" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
    );
    const provider = new GrokLlmProvider("grok-key", "grok-2-latest", { fetcher });

    const result = await provider.complete("hey");

    expect(result).toEqual({ text: "yo", inputTokens: 2, outputTokens: 1 });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer grok-key");
    expect(provider.name).toBe("grok");
  });

  it("never fabricates a token count or completion text when fields are missing from a successful response", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const provider = new OpenAiLlmProvider("key", "gpt-4o", { fetcher });
    const result = await provider.complete("x");
    expect(result).toEqual({ text: "", inputTokens: 0, outputTokens: 0 });
  });

  it("classifies a 401 as non-retryable and a 429 as retryable, same as the Anthropic client", async () => {
    const unauthorized: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: "invalid key" } }));
    const unauthorizedErr = await new OpenAiLlmProvider("bad", "gpt-4o", { fetcher: unauthorized }).complete("x").catch((e) => e);
    expect((unauthorizedErr as LlmApiError).retryable).toBe(false);

    const rateLimited: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(429, { error: { message: "rate limited" } }));
    const rateLimitedErr = await new GrokLlmProvider("key", "grok-2-latest", { fetcher: rateLimited }).complete("x").catch((e) => e);
    expect((rateLimitedErr as LlmApiError).retryable).toBe(true);
  });

  it("GroqLlmProvider hits api.groq.com with the same OpenAI-compatible shape (groq.com, NOT xAI's Grok)", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "sup" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    );
    const provider = new GroqLlmProvider("groq-key", "llama-3.3-70b-versatile", { fetcher });

    const result = await provider.complete("hey");

    expect(result).toEqual({ text: "sup", inputTokens: 3, outputTokens: 1 });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer groq-key");
    expect(provider.name).toBe("groq");
  });
});

describe("GeminiLlmProvider", () => {
  it("sends the documented generateContent request shape with `key` as a QUERY PARAM (not a header, unlike every other provider)", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "hi there" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
    );
    const provider = new GeminiLlmProvider("test-key-123", "gemini-2.5-flash-lite", { fetcher });

    const result = await provider.complete("say hi", { maxTokens: 50, systemPrompt: "be brief", temperature: 0.2 });

    expect(result).toEqual({ text: "hi there", inputTokens: 10, outputTokens: 4 });
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=test-key-123",
    );
    expect(init.headers["x-api-key"]).toBeUndefined();
    expect(init.headers.authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([{ parts: [{ text: "say hi" }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 50, temperature: 0.2 });
  });

  it("concatenates multiple candidate parts into one string", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "part one " }, { text: "part two" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      }),
    );
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher });
    const result = await provider.complete("x");
    expect(result.text).toBe("part one part two");
  });

  it("never fabricates a token count: defaults to 0 if usageMetadata is somehow missing from a successful response", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    );
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher });
    const result = await provider.complete("x");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("classifies a 401 (bad key) as a non-retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" } }),
    );
    const provider = new GeminiLlmProvider("bad-key", "gemini-2.5-flash-lite", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect((err as LlmApiError).status).toBe(401);
    expect((err as LlmApiError).retryable).toBe(false);
  });

  it("classifies a 429 (rate limit) as a retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(
      jsonResponse(429, { error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }),
    );
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect((err as LlmApiError).retryable).toBe(true);
  });

  it("classifies a 5xx as a retryable LlmApiError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockResolvedValue(jsonResponse(503, { error: { message: "overloaded" } }));
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher });

    const err = await provider.complete("x").catch((e) => e);
    expect((err as LlmApiError).retryable).toBe(true);
  });

  it("converts an aborted (timed-out) request into LlmTimeoutError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher, timeoutMs: 10 });

    await expect(provider.complete("x")).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it("converts any other fetch rejection into LlmNetworkError", async () => {
    const fetcher: LlmFetcher = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new GeminiLlmProvider("key", "gemini-2.5-flash-lite", { fetcher });

    await expect(provider.complete("x")).rejects.toBeInstanceOf(LlmNetworkError);
  });
});

describe("getLlmProvider resolver", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const noneConfigured = {
    anthropicApiKey: null,
    anthropicModel: "claude-sonnet-4-5-20250929",
    openaiApiKey: null,
    openaiModel: "gpt-4o",
    grokApiKey: null,
    grokModel: "grok-2-latest",
    geminiApiKey: null,
    geminiModel: "gemini-2.5-flash-lite",
    groqApiKey: null,
    groqModel: "llama-3.3-70b-versatile",
    llmProviderOverride: null,
  };

  it("returns NotConfiguredLlmProvider when no key is set at all", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: noneConfigured }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(false);
    expect(provider.name).toBe("not_configured");
  });

  it("returns a real AnthropicLlmProvider when only ANTHROPIC_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, anthropicApiKey: "a-real-key" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("anthropic");
  });

  it("returns a real OpenAiLlmProvider when only OPENAI_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, openaiApiKey: "an-openai-key" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("openai");
  });

  it("returns a real GrokLlmProvider when only GROK_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, grokApiKey: "a-grok-key" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("grok");
  });

  it("returns a real GeminiLlmProvider when only GEMINI_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, geminiApiKey: "a-gemini-key" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("gemini");
  });

  it("returns a real GroqLlmProvider when only GROQ_API_KEY is set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, groqApiKey: "a-groq-key" } }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    const provider = getLlmProvider();
    expect(provider.isConfigured).toBe(true);
    expect(provider.name).toBe("groq");
  });

  it("prefers anthropic > openai > grok > gemini > groq when multiple keys are set and no explicit LLM_PROVIDER override is given", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: {
        ...noneConfigured,
        anthropicApiKey: "a",
        openaiApiKey: "b",
        grokApiKey: "c",
        geminiApiKey: "d",
        groqApiKey: "e",
      },
    }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    expect(getLlmProvider().name).toBe("anthropic");
  });

  it("falls back to gemini then groq when neither anthropic, openai, nor grok keys are set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { ...noneConfigured, geminiApiKey: "d", groqApiKey: "e" },
    }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    expect(getLlmProvider().name).toBe("gemini");
  });

  it("honors an explicit LLM_PROVIDER override even when a higher-priority key is also set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { ...noneConfigured, anthropicApiKey: "a", openaiApiKey: "b", llmProviderOverride: "openai" },
    }));
    const { getLlmProvider } = await import("../src/lib/llmProvider.js");
    expect(getLlmProvider().name).toBe("openai");
  });

  it("throws rather than silently falling back when LLM_PROVIDER names a provider whose key isn't set", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { ...noneConfigured, llmProviderOverride: "grok" } }));
    const { getLlmProvider, LlmNotConfiguredError: Thrown } = await import("../src/lib/llmProvider.js");
    expect(() => getLlmProvider()).toThrow(Thrown);
  });
});

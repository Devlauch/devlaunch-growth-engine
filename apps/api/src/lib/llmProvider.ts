import { env } from "../config/env.js";

/**
 * llmProvider.ts: Milestone 5 (P4) pluggable LLM provider architecture.
 *
 * CRITICAL HONESTY STATEMENT (same convention as hunterProvider.ts,
 * bookingProvider.ts, coreWebVitals.ts): no real Anthropic/OpenAI/any LLM
 * API key is available anywhere in this environment (confirmed by
 * docs/BROADER_WORKSTREAM_AUDIT.md — zero LLM credentials exist, not even a
 * reserved env var, before this file). `AnthropicLlmProvider` below is
 * real, working client code written against Anthropic's documented
 * Messages API shape, but it has never been exercised against the real
 * api.anthropic.com — only against injected fake `fetch` responses in
 * test/llmProvider.test.ts. That specific gap is BLOCKED, not hidden (see
 * this task's handback / docs/BROADER_WORKSTREAM_AUDIT.md).
 *
 * Dependency choice: a minimal `fetch`-based client against Anthropic's
 * documented REST API, NOT the `@anthropic-ai/sdk` package. Justification:
 * every other third-party API client in this codebase
 * (hunterProvider.ts, chatwootClient.ts, postizClient.ts, listmonkClient.ts,
 * crawl4aiClient.ts) is a hand-rolled fetch client with no HTTP SDK
 * dependency at all — apps/api/package.json has no axios/node-fetch/any
 * HTTP client library, relying on Node's built-in global `fetch`. Adding
 * `@anthropic-ai/sdk` would be the first HTTP SDK dependency in this
 * codebase, pulls in its own transitive deps, and buys nothing here beyond
 * what a ~60-line fetch wrapper already gives: this file calls exactly one
 * endpoint (POST /v1/messages) with one documented request/response shape.
 * Consistency with the existing convention wins.
 *
 * API shape (Anthropic Messages API, POST https://api.anthropic.com/v1/messages):
 *   - Auth: `x-api-key: <key>` header (NOT Authorization: Bearer).
 *   - Required header: `anthropic-version: 2023-06-01`.
 *   - Request body: { model, max_tokens, system?, messages: [{role, content}] }.
 *   - Response body: { content: [{type: "text", text}], usage: {input_tokens, output_tokens}, stop_reason, ... }.
 *   - Errors: { type: "error", error: { type, message } } body shape;
 *     401 invalid key, 429 rate limit, 5xx provider-side failure.
 */

export interface LlmCompleteOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface LlmCompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** True when this provider can actually make real calls (a real key is configured). */
  readonly isConfigured: boolean;
  complete(prompt: string, opts?: LlmCompleteOptions): Promise<LlmCompleteResult>;
}

export class LlmNotConfiguredError extends Error {
  constructor(message = "No LLM provider is configured (ANTHROPIC_API_KEY is not set).") {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

/** A real, classified failure response from the Anthropic API (never thrown for a merely-short completion). */
export class LlmApiError extends Error {
  readonly status: number;
  readonly errorType: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, errorType: string | null) {
    super(message);
    this.name = "LlmApiError";
    this.status = status;
    this.errorType = errorType;
    // 429 (rate limit) and 5xx (provider-side) are worth a caller retrying
    // later; 400/401/404/422 mean the request/key itself is wrong.
    this.retryable = status === 429 || status >= 500;
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM API request timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

export class LlmNetworkError extends Error {
  constructor(cause: unknown) {
    super(`LLM API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LlmNetworkError";
  }
}

/**
 * Always honestly reports not-configured — used whenever no real LLM API
 * key exists (every environment this codebase has actually run in today).
 * `complete()` throws LlmNotConfiguredError rather than ever returning a
 * fabricated completion; every real call site must check `isConfigured`
 * before calling `complete()` so this throw is a defensive backstop, not
 * the primary control-flow mechanism (same "check isConfigured() /
 * status: not_configured first" convention as bookingProvider.ts /
 * chatwootClient.ts).
 */
export class NotConfiguredLlmProvider implements LlmProvider {
  readonly name = "not_configured";
  readonly isConfigured = false;

  async complete(): Promise<LlmCompleteResult> {
    throw new LlmNotConfiguredError();
  }
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;

export interface LlmFetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
}

/** Injectable for tests. Defaults to the real global fetch. */
function defaultFetcher(): LlmFetcher {
  return (url, init) => fetch(url, init);
}

interface AnthropicMessagesResponseBody {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Real Anthropic Messages API client. Constructed with an explicit apiKey +
 * model so it is directly unit-testable without touching process.env/env.ts
 * — getLlmProvider() below is the one place that reads env.ts and decides
 * whether to construct this at all.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly isConfigured = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly options: { timeoutMs?: number; fetcher?: LlmFetcher } = {},
  ) {}

  async complete(prompt: string, opts: LlmCompleteOptions = {}): Promise<LlmCompleteResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts.systemPrompt) body.system = opts.systemPrompt;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(ANTHROPIC_BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmTimeoutError(timeoutMs);
      }
      throw new LlmNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: AnthropicMessagesResponseBody | null = null;
    try {
      parsed = (await response.json()) as AnthropicMessagesResponseBody;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new LlmApiError(
        parsed?.error?.message ?? `Anthropic API returned HTTP ${response.status}`,
        response.status,
        parsed?.error?.type ?? null,
      );
    }

    const text = (parsed?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");

    return {
      text,
      // Real token counts ONLY — Anthropic's Messages API always reports
      // usage on a successful response; default to 0 rather than guess if
      // a field is somehow missing (never fabricated, per usageEvents.ts's
      // own convention).
      inputTokens: parsed?.usage?.input_tokens ?? 0,
      outputTokens: parsed?.usage?.output_tokens ?? 0,
    };
  }
}

/**
 * Resolver: the one place every call site should go through. Returns a real
 * AnthropicLlmProvider when env.anthropicApiKey is set, otherwise the
 * honest NotConfiguredLlmProvider — never throws, so callers always check
 * `.isConfigured` rather than try/catch-ing a missing-key error.
 */
export function getLlmProvider(): LlmProvider {
  if (!env.anthropicApiKey) {
    return new NotConfiguredLlmProvider();
  }
  return new AnthropicLlmProvider(env.anthropicApiKey, env.anthropicModel);
}

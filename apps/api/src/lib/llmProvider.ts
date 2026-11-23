import { env } from "../config/env.js";

/**
 * llmProvider.ts: Milestone 5 (P4) pluggable LLM provider architecture,
 * extended to support five interchangeable providers — Anthropic, OpenAI,
 * xAI's Grok, Google Gemini, and Groq (the fast-inference company,
 * groq.com — NOT xAI's Grok; the two are easy to confuse by name alone) —
 * selected via `getLlmProvider()` below.
 *
 * CRITICAL HONESTY STATEMENT (same convention as hunterProvider.ts,
 * bookingProvider.ts, coreWebVitals.ts): no real Anthropic/OpenAI/xAI/
 * Gemini/Groq API key is available anywhere in this environment.
 * `AnthropicLlmProvider`, `OpenAiCompatibleLlmProvider`, and
 * `GeminiLlmProvider` below are real, working client code written against
 * each provider's own documented API shape, but none has ever been
 * exercised against the real api.anthropic.com / api.openai.com / api.x.ai /
 * generativelanguage.googleapis.com / api.groq.com — only against injected
 * fake `fetch` responses in test/llmProvider.test.ts. That specific gap is
 * BLOCKED, not hidden (see docs/BROADER_WORKSTREAM_AUDIT.md).
 *
 * Dependency choice: minimal `fetch`-based clients against each provider's
 * documented REST API, NOT the `@anthropic-ai/sdk` / `openai` npm packages.
 * Justification: every other third-party API client in this codebase
 * (hunterProvider.ts, chatwootClient.ts, postizClient.ts, listmonkClient.ts,
 * crawl4aiClient.ts) is a hand-rolled fetch client with no HTTP SDK
 * dependency at all. Consistency with the existing convention wins.
 *
 * Anthropic API shape (Messages API, POST https://api.anthropic.com/v1/messages):
 *   - Auth: `x-api-key: <key>` header (NOT Authorization: Bearer).
 *   - Required header: `anthropic-version: 2023-06-01`.
 *   - Request body: { model, max_tokens, system?, messages: [{role, content}] }.
 *   - Response body: { content: [{type: "text", text}], usage: {input_tokens, output_tokens}, stop_reason, ... }.
 *   - Errors: { type: "error", error: { type, message } } body shape;
 *     401 invalid key, 429 rate limit, 5xx provider-side failure.
 *
 * OpenAI / Grok API shape (both use the same OpenAI-compatible Chat
 * Completions API — xAI's docs at docs.x.ai explicitly document Grok as a
 * drop-in-compatible replacement for the OpenAI client, same request/
 * response shape, different base URL):
 *   - POST https://api.openai.com/v1/chat/completions (OpenAI)
 *     POST https://api.x.ai/v1/chat/completions (xAI / Grok)
 *   - Auth: `Authorization: Bearer <key>` header (both).
 *   - Request body: { model, max_tokens, temperature?, messages: [{role, content}] }
 *     — a `system` prompt is passed as a {role: "system", content} message,
 *     not a separate top-level field (unlike Anthropic).
 *   - Response body: { choices: [{ message: { content } }], usage: { prompt_tokens, completion_tokens } }.
 *   - Errors: { error: { message, type, code } } body shape;
 *     401 invalid key, 429 rate limit, 5xx provider-side failure.
 *
 * Groq API shape — Groq (groq.com, the fast-inference hardware company; NOT
 * xAI's "Grok" model above, a frequent name collision) publishes its own
 * API as OpenAI-Chat-Completions-compatible (docs at console.groq.com/docs/
 * openai, "mostly compatible with OpenAI's client libraries") at base URL
 * `https://api.groq.com/openai/v1/chat/completions`, Bearer auth — i.e. the
 * exact same request/response shape as OpenAI/Grok above. Reused via
 * `OpenAiCompatibleLlmProvider` below rather than a new parser. Confirmed
 * current production model id (console.groq.com/docs/models, Nov 2026):
 * `llama-3.3-70b-versatile` (Meta Llama 3.3 70B, Groq-hosted) — used here as
 * the default; `llama-3.1-8b-instant` is Groq's smaller/faster alternative.
 *
 * Google Gemini API shape (generateContent REST API, confirmed against
 * Google's own AI Studio / Gemini API docs, Nov 2026):
 *   - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
 *   - Auth: `key` QUERY PARAMETER — not a header. This is a real difference
 *     from every other provider in this file (all of which use a header)
 *     and is handled explicitly in GeminiLlmProvider below.
 *   - Request body: { contents: [{ parts: [{ text: prompt }] }],
 *     systemInstruction?: { parts: [{ text }] },
 *     generationConfig?: { maxOutputTokens, temperature } }.
 *   - Response body: { candidates: [{ content: { parts: [{ text }] } }],
 *     usageMetadata: { promptTokenCount, candidatesTokenCount } }.
 *   - Errors: Google's standard `{ error: { code, message, status } }` body
 *     shape (`status` is a string like "UNAUTHENTICATED"/"RESOURCE_EXHAUSTED");
 *     401/403 invalid key, 429 rate limit, 5xx provider-side failure.
 *   - Default model: `gemini-2.5-flash-lite` — chosen deliberately over the
 *     newer gemini-3.x flash family (gemini-3.5-flash / 3.6 / 3.8) because
 *     Google's own docs describe those as being actively superseded/
 *     auto-rerouted release-to-release (e.g. gemini-3.5-flash is already
 *     documented as deprecated and silently routed to gemini-3.6-flash);
 *     gemini-2.5-flash-lite is the stable, explicitly-free-tier flash-lite
 *     id as of these docs. GEMINI_MODEL remains overridable without a code
 *     change if a newer id becomes the better default.
 *
 *   *** FREE-TIER DATA-USE DISCLOSURE (Google AI Studio / Gemini API docs,
 *   pricing page, Nov 2026) — read before setting GEMINI_API_KEY: on the
 *   free/unpaid API tier, Google's own pricing page lists "Content used to
 *   improve our products" as "Yes" for the free tier's flash/flash-lite
 *   models, versus "No" for the same models on the paid tier. In other
 *   words, prompts and responses sent through a free-tier Gemini API key
 *   may be used by Google to improve its products (the paid tier is the one
 *   that disclaims this). Google's terms are the authoritative source for
 *   exactly what "improve our products" covers (e.g. human review, model
 *   training) — this file only flags the tier distinction so whoever
 *   enables GEMINI_API_KEY in this platform makes that call deliberately,
 *   not by accident. ***
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
  constructor(
    message = "No LLM provider is configured (set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GROK_API_KEY, GEMINI_API_KEY, GROQ_API_KEY).",
  ) {
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

const OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions";
const GROK_BASE_URL = "https://api.x.ai/v1/chat/completions";

interface OpenAiCompatibleResponseBody {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Real client for any OpenAI-Chat-Completions-compatible API — used for
 * both OpenAI itself and xAI's Grok (same request/response shape, only the
 * base URL and model id differ; see this file's header comment for the
 * exact citations). `name` is passed in by the two constructors below so
 * error messages/usage-event provider labels stay accurate per provider.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly isConfigured = true;

  constructor(
    public readonly name: "openai" | "grok" | "groq",
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly options: { timeoutMs?: number; fetcher?: LlmFetcher } = {},
  ) {}

  async complete(prompt: string, opts: LlmCompleteOptions = {}): Promise<LlmCompleteResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const messages: { role: string; content: string }[] = [];
    if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
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

    let parsed: OpenAiCompatibleResponseBody | null = null;
    try {
      parsed = (await response.json()) as OpenAiCompatibleResponseBody;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new LlmApiError(
        parsed?.error?.message ?? `${this.name} API returned HTTP ${response.status}`,
        response.status,
        parsed?.error?.type ?? null,
      );
    }

    return {
      text: parsed?.choices?.[0]?.message?.content ?? "",
      // Real token counts ONLY — defaults to 0 rather than guess if a field
      // is somehow missing (never fabricated, per usageEvents.ts's own
      // convention).
      inputTokens: parsed?.usage?.prompt_tokens ?? 0,
      outputTokens: parsed?.usage?.completion_tokens ?? 0,
    };
  }
}

/** Real OpenAI Chat Completions client — a thin, named wrapper over OpenAiCompatibleLlmProvider. */
export class OpenAiLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(apiKey: string, model: string, options: { timeoutMs?: number; fetcher?: LlmFetcher } = {}) {
    super("openai", OPENAI_BASE_URL, apiKey, model, options);
  }
}

/** Real xAI Grok client (OpenAI-compatible API, different base URL/model id) — see this file's header comment. */
export class GrokLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(apiKey: string, model: string, options: { timeoutMs?: number; fetcher?: LlmFetcher } = {}) {
    super("grok", GROK_BASE_URL, apiKey, model, options);
  }
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Real Groq client (the fast-inference company, groq.com — NOT xAI's
 * "Grok" above). Groq's API is OpenAI-Chat-Completions-compatible (see this
 * file's header comment), so this is a third thin subclass of
 * OpenAiCompatibleLlmProvider, the same pattern as OpenAiLlmProvider/
 * GrokLlmProvider above — no new parser needed.
 */
export class GroqLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(apiKey: string, model: string, options: { timeoutMs?: number; fetcher?: LlmFetcher } = {}) {
    super("groq", GROQ_BASE_URL, apiKey, model, options);
  }
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiGenerateContentResponseBody {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Real Google Gemini generateContent REST API client — see this file's
 * header comment for the exact request/response shape citation and the
 * free-tier data-use disclosure. Unlike every other provider in this file,
 * auth is a `key` QUERY PARAMETER, not a header — handled explicitly below.
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";
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
      contents: [{ parts: [{ text: prompt }] }],
    };
    if (opts.systemPrompt) {
      body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    else generationConfig.maxOutputTokens = DEFAULT_MAX_TOKENS;
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    body.generationConfig = generationConfig;

    // Auth is a `key` query param (NOT a header) — the one real difference
    // from every other provider client in this file.
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
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

    let parsed: GeminiGenerateContentResponseBody | null = null;
    try {
      parsed = (await response.json()) as GeminiGenerateContentResponseBody;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new LlmApiError(
        parsed?.error?.message ?? `Gemini API returned HTTP ${response.status}`,
        response.status,
        parsed?.error?.status ?? null,
      );
    }

    const text = (parsed?.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    return {
      text,
      // Real token counts ONLY — defaults to 0 rather than guess if a field
      // is somehow missing (never fabricated, per usageEvents.ts's own
      // convention).
      inputTokens: parsed?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: parsed?.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

/**
 * Resolver: the one place every call site should go through. Returns a real
 * provider for whichever of ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GROK_API_KEY / GEMINI_API_KEY / GROQ_API_KEY is configured, otherwise the
 * honest NotConfiguredLlmProvider — never throws, so callers always check
 * `.isConfigured` rather than try/catch-ing a missing-key error.
 *
 * Selection: `LLM_PROVIDER` (env.llmProviderOverride) explicitly picks one
 * ("anthropic" | "openai" | "grok" | "gemini" | "groq") and throws at
 * startup if that provider's key isn't actually set — a deliberate
 * fail-loud choice so a misconfigured override is never silently ignored.
 * With no override, the first configured key wins in this fixed priority
 * order: anthropic, openai, grok, gemini, groq — arbitrary but documented,
 * since nothing in this codebase has ever run with more than one key
 * configured at once to motivate a smarter policy.
 *
 * IMPORTANT — this auto-pick is the only provider-selection logic in this
 * file, and it is deliberately NOT extended by this change beyond adding
 * gemini/groq to the same existing, explicit, documented priority order.
 * There is no "try provider A, catch a failure, silently retry on provider
 * B" fallback-on-error logic anywhere here, and none was added: a
 * mid-request failure (LlmApiError/LlmTimeoutError/LlmNetworkError) always
 * propagates to the caller rather than triggering an automatic switch to a
 * different provider/model. Per this round's explicit requirement, this
 * file never silently switches providers when a task requires a particular
 * model's capability — selection happens once, up front, via the
 * user-configurable LLM_PROVIDER override or the documented static
 * priority order, never reactively mid-call.
 */
export function getLlmProvider(): LlmProvider {
  const override = env.llmProviderOverride;

  if (override === "anthropic") {
    if (!env.anthropicApiKey) throw new LlmNotConfiguredError("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.");
    return new AnthropicLlmProvider(env.anthropicApiKey, env.anthropicModel);
  }
  if (override === "openai") {
    if (!env.openaiApiKey) throw new LlmNotConfiguredError("LLM_PROVIDER=openai but OPENAI_API_KEY is not set.");
    return new OpenAiLlmProvider(env.openaiApiKey, env.openaiModel);
  }
  if (override === "grok") {
    if (!env.grokApiKey) throw new LlmNotConfiguredError("LLM_PROVIDER=grok but GROK_API_KEY is not set.");
    return new GrokLlmProvider(env.grokApiKey, env.grokModel);
  }
  if (override === "gemini") {
    if (!env.geminiApiKey) throw new LlmNotConfiguredError("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set.");
    return new GeminiLlmProvider(env.geminiApiKey, env.geminiModel);
  }
  if (override === "groq") {
    if (!env.groqApiKey) throw new LlmNotConfiguredError("LLM_PROVIDER=groq but GROQ_API_KEY is not set.");
    return new GroqLlmProvider(env.groqApiKey, env.groqModel);
  }

  if (env.anthropicApiKey) return new AnthropicLlmProvider(env.anthropicApiKey, env.anthropicModel);
  if (env.openaiApiKey) return new OpenAiLlmProvider(env.openaiApiKey, env.openaiModel);
  if (env.grokApiKey) return new GrokLlmProvider(env.grokApiKey, env.grokModel);
  if (env.geminiApiKey) return new GeminiLlmProvider(env.geminiApiKey, env.geminiModel);
  if (env.groqApiKey) return new GroqLlmProvider(env.groqApiKey, env.groqModel);
  return new NotConfiguredLlmProvider();
}

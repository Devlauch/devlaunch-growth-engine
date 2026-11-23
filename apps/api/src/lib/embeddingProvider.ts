import { env } from "../config/env.js";

/**
 * embeddingProvider.ts: a real, fetch-based client producing text
 * embeddings — the required prerequisite for anything to usefully go INTO
 * Qdrant (see qdrantClient.ts). New ground for this codebase.
 *
 * CRITICAL HONESTY STATEMENT (same convention as llmProvider.ts/
 * qdrantClient.ts): no real OpenAI API key is available anywhere in this
 * environment. `OpenAiEmbeddingProvider` below is real, working client
 * code written against OpenAI's own documented API shape, but has never
 * been exercised against the real api.openai.com — only against injected
 * fake `fetch` responses in test/embeddingProvider.test.ts.
 *
 * OpenAI embeddings API shape (POST https://api.openai.com/v1/embeddings):
 *   - Auth: `Authorization: Bearer <key>` header (same as llmProvider.ts's
 *     OpenAiLlmProvider — reuses env.openaiApiKey, no new credential).
 *   - Request body: { model, input: string[] }.
 *   - Response body: { data: [{ embedding: number[], index }], model,
 *     usage: { prompt_tokens, total_tokens } }, with `data` entries in the
 *     same order as the input array (OpenAI's documented ordering
 *     guarantee).
 *   - Errors: { error: { message, type, code } } body shape (identical
 *     shape to the Chat Completions API — same as llmProvider.ts's
 *     OpenAiCompatibleResponseBody); 401 invalid key, 429 rate limit, 5xx
 *     provider-side failure.
 *   - Default model: "text-embedding-3-small" — OpenAI's current
 *     small/cheap embedding model (1536 dimensions by default, output
 *     dimensionality is reducible via a `dimensions` param we do not use
 *     here), per OpenAI's own embeddings documentation
 *     (platform.openai.com/docs/guides/embeddings) and models list
 *     (platform.openai.com/docs/models/text-embedding-3-small). Chosen over
 *     "text-embedding-3-large" as the conservative default for a brand-new,
 *     not-yet-exercised code path — overridable via EMBEDDING_MODEL without
 *     a code change.
 *
 * Gemini embeddings: this round's sibling LLM-provider work may or may not
 * have landed `env.geminiApiKey` by the time this file runs (confirmed by
 * checking apps/api/src/config/env.ts directly before writing this: no
 * `geminiApiKey` exists there as of this file's authoring). Per this task's
 * own scope instruction ("do NOT block on this"), Gemini embedding support
 * is deliberately NOT implemented here — OpenAI alone is a complete,
 * sufficient implementation for this round. A future round can add a
 * GeminiEmbeddingProvider (POST
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent)
 * once env.geminiApiKey actually exists.
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** True when this provider can actually make real calls (a real key is configured). */
  readonly isConfigured: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor(message = "No embedding provider is configured (set OPENAI_API_KEY).") {
    super(message);
    this.name = "EmbeddingNotConfiguredError";
  }
}

export class EmbeddingApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "EmbeddingApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export class EmbeddingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Embedding API request timed out after ${timeoutMs}ms`);
    this.name = "EmbeddingTimeoutError";
  }
}

export class EmbeddingNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Embedding API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "EmbeddingNetworkError";
  }
}

/**
 * Always honestly reports not-configured — used whenever no real
 * OPENAI_API_KEY exists (every environment this codebase has actually run
 * in today). `embed()` throws EmbeddingNotConfiguredError rather than ever
 * returning fabricated vectors; every real call site must check
 * `isConfigured` before calling `embed()` so this throw is a defensive
 * backstop, not the primary control-flow mechanism (same convention as
 * NotConfiguredLlmProvider in llmProvider.ts).
 */
export class NotConfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly name = "not_configured";
  readonly isConfigured = false;

  async embed(): Promise<number[][]> {
    throw new EmbeddingNotConfiguredError();
  }
}

export interface EmbeddingFetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): EmbeddingFetcher {
  return (url, init) => fetch(url, init);
}

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OpenAiEmbeddingsResponseBody {
  data?: { embedding?: number[]; index?: number }[];
  error?: { message?: string; type?: string };
}

/**
 * Real OpenAI embeddings client. Constructed with an explicit apiKey +
 * model so it is directly unit-testable without touching process.env/env.ts
 * — getEmbeddingProvider() below is the one place that reads env.ts.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly isConfigured = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly options: { timeoutMs?: number; fetcher?: EmbeddingFetcher } = {},
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new EmbeddingTimeoutError(timeoutMs);
      }
      throw new EmbeddingNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: OpenAiEmbeddingsResponseBody | null = null;
    try {
      parsed = (await response.json()) as OpenAiEmbeddingsResponseBody;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      throw new EmbeddingApiError(parsed?.error?.message ?? `OpenAI embeddings API returned HTTP ${response.status}`, response.status);
    }

    // OpenAI documents `data` entries in the same order as the input array
    // — sort by `index` defensively rather than assume array order, since
    // that ordering guarantee is what every downstream caller (pairing a
    // text with its vector) depends on.
    const entries = (parsed?.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return entries.map((entry) => entry.embedding ?? []);
  }
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Resolver: the one place every call site should go through. Returns a real
 * OpenAiEmbeddingProvider when env.openaiApiKey is set, otherwise the
 * honest NotConfiguredEmbeddingProvider — never throws, so callers always
 * check `.isConfigured` rather than try/catch-ing a missing-key error.
 * Reuses env.openaiApiKey (the existing llmProvider.ts credential) rather
 * than inventing a separate one, per this task's own instruction.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (env.openaiApiKey) {
    return new OpenAiEmbeddingProvider(env.openaiApiKey, env.embeddingModel ?? DEFAULT_EMBEDDING_MODEL);
  }
  return new NotConfiguredEmbeddingProvider();
}

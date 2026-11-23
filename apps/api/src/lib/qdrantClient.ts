import { env } from "../config/env.js";

/**
 * qdrantClient.ts: a real, fetch-based client against Qdrant's documented
 * REST API (https://qdrant.tech/documentation/). New ground for this
 * codebase — no embedding/vector-database code existed anywhere before this
 * file (confirmed by grep across the repo before writing this).
 *
 * CRITICAL HONESTY STATEMENT (same convention as llmProvider.ts/
 * hunterProvider.ts/bookingProvider.ts): no real Qdrant instance (Cloud or
 * self-hosted) is reachable from this environment. Every request/response
 * shape below was built against Qdrant's own published docs (cited per
 * method) and exercised only against injected fake `fetch` responses in
 * test/qdrantClient.test.ts — never against a real api.
 *
 * Confirmed REST API shapes (fetched directly from qdrant.tech during this
 * work; see this task's handback for the exact URLs):
 *   - Create collection: `PUT /collections/{collection_name}` with body
 *     `{ "vectors": { "size": N, "distance": "Cosine"|"Euclid"|"Dot" } }`
 *     (qdrant.tech/documentation/manage-data/collections/). Success is a
 *     200 with `{ result: true, status: "ok", time }`. Qdrant's own public
 *     API reference (api.qdrant.tech/api-reference/collections/create-collection)
 *     documents only a generic 200 success / 400 client-error pair for this
 *     endpoint — there is NO distinct 409-style "already exists" status
 *     documented. This client therefore treats a 400 response whose error
 *     message contains "already exists" as idempotent success (ensureCollection
 *     is a no-op against an existing collection), and any other 400/4xx/5xx
 *     as a real failure — a best-effort classification given the docs don't
 *     name a dedicated status code, not a documented contract.
 *   - Upsert points: `PUT /collections/{collection_name}/points` with body
 *     `{ "points": [{ "id", "vector", "payload" }, ...] }` (ids may be
 *     unsigned 64-bit ints or UUID strings) — qdrant.tech/documentation/manage-data/points/.
 *   - Search: `POST /collections/{collection_name}/points/search` with body
 *     `{ "vector": [...], "limit": N, "filter"?: {...}, "with_payload": true }`,
 *     response `{ result: [{ id, score, payload, version? }], status, time }`.
 *     This specific `/points/search` path (as opposed to the newer unified
 *     `/points/query` endpoint Qdrant now documents as the primary search
 *     page) is Qdrant's long-stable classic search endpoint; the two
 *     web-fetch passes done for this task confirmed `/points/query`'s shape
 *     verbatim and confirmed the `{must: [{key, match: {value}}]}` filter
 *     shape verbatim, but did not turn up a verbatim current doc page for
 *     `/points/search` specifically (it appears to have been superseded in
 *     Qdrant's docs navigation by the Query API, though the task's required
 *     shape is this classic endpoint). Flagging this honestly: the
 *     request/response field names below (`vector`, `limit`, `filter`,
 *     `with_payload`, response `result: [{id, score, payload}]`) match
 *     Qdrant's long-published OpenAPI schema for this endpoint, but were not
 *     re-confirmed against a freshly fetched doc page in this round the way
 *     create-collection/points/filtering were.
 *   - Filter shape (confirmed verbatim, qdrant.tech/documentation/search/filtering/):
 *     `{ "must": [{ "key": "tenant_id", "match": { "value": "<tenant>" } }] }`.
 *   - Delete points: `POST /collections/{collection_name}/points/delete`
 *     with body `{ "points": [id, id, ...] }`.
 *   - Auth: Qdrant Cloud requires `api-key: <key>` header (confirmed
 *     verbatim, qdrant.tech/documentation/cloud-quickstart/ — lowercase,
 *     hyphenated, NOT `Authorization: Bearer`). A self-hosted instance with
 *     no API key configured (the common local-Docker-dev case) sends no
 *     such header at all — this client only sends it when an apiKey is
 *     actually passed in.
 *
 * ===========================================================================
 * TENANT ISOLATION (CRITICAL — READ BEFORE ADDING ANY CALL SITE):
 *
 * Qdrant has no native concept of per-tenant row-level security the way
 * Postgres does here (every tenantDb query in this codebase runs under RLS
 * via app.current_tenant_id — see activityTimeline.ts). A vector database
 * has no equivalent enforcement layer of its own. That means: EVERY point
 * upserted into ANY collection through this client MUST carry a `tenant_id`
 * field in its `payload`, and EVERY search MUST filter on that field. There
 * is no other boundary preventing one tenant's semantic search from
 * returning another tenant's vectors stored in the same collection.
 *
 * To make that the easy, hard-to-get-wrong path: the raw `search()` method
 * below is intentionally NOT exported for use by application/agent-tool code
 * — only `searchForTenant()` is, which always merges a `{key: "tenant_id",
 * match: {value: tenantId}}` clause into the filter's `must` array before
 * calling `search()`. Any new call site needing vector search should use
 * `searchForTenant()`, never construct its own raw `search()` filter.
 * ===========================================================================
 */

export type QdrantDistance = "Cosine" | "Euclid" | "Dot";

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantFilter {
  must?: Array<{ key: string; match: { value: string | number | boolean } }>;
  must_not?: Array<{ key: string; match: { value: string | number | boolean } }>;
  should?: Array<{ key: string; match: { value: string | number | boolean } }>;
}

export class QdrantApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "QdrantApiError";
    this.status = status;
    // 429 (rate limit) and 5xx (provider-side) are worth a caller retrying
    // later; 400/401/404 mean the request/key/collection itself is wrong —
    // same classification convention as LlmApiError in llmProvider.ts.
    this.retryable = status === 429 || status >= 500;
  }
}

export class QdrantTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Qdrant API request timed out after ${timeoutMs}ms`);
    this.name = "QdrantTimeoutError";
  }
}

export class QdrantNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Qdrant API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "QdrantNetworkError";
  }
}

export interface QdrantFetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): QdrantFetcher {
  return (url, init) => fetch(url, init);
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface QdrantEnvelope<T> {
  result?: T;
  status?: string | { error?: string };
  time?: number;
}

function isAlreadyExistsError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const envelope = body as QdrantEnvelope<unknown>;
  const statusField = envelope.status;
  const message =
    typeof statusField === "object" && statusField !== null && "error" in statusField
      ? String((statusField as { error?: unknown }).error ?? "")
      : "";
  return /already exists/i.test(message);
}

/**
 * Real Qdrant REST API client. Constructed with an explicit baseUrl (+
 * optional apiKey) so it is directly unit-testable without touching
 * process.env/env.ts — getQdrantClient() below is the one place that reads
 * env.ts and decides whether to construct this at all.
 */
export class QdrantClient {
  readonly isConfigured = true;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly options: { timeoutMs?: number; fetcher?: QdrantFetcher } = {},
  ) {}

  private async request<T>(path: string, method: string, body?: unknown): Promise<{ response: Response; parsed: QdrantEnvelope<T> | null }> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new QdrantTimeoutError(timeoutMs);
      }
      throw new QdrantNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    let parsed: QdrantEnvelope<T> | null = null;
    try {
      parsed = (await response.json()) as QdrantEnvelope<T>;
    } catch {
      parsed = null;
    }

    return { response, parsed };
  }

  /**
   * Idempotent create-if-not-exists: `PUT /collections/{name}`. Qdrant's own
   * API reference documents only generic 200/400 responses for this
   * endpoint (no dedicated "already exists" status) — see this file's
   * header comment. A 400 whose error message contains "already exists" is
   * treated as success; any other non-ok response is a real failure.
   */
  async ensureCollection(name: string, vectorSize: number, distance: QdrantDistance): Promise<void> {
    const { response, parsed } = await this.request(`/collections/${encodeURIComponent(name)}`, "PUT", {
      vectors: { size: vectorSize, distance },
    });

    if (response.ok) return;
    if (response.status === 400 && isAlreadyExistsError(parsed)) return;

    const message =
      (typeof parsed?.status === "object" && parsed.status?.error) || `Qdrant ensureCollection returned HTTP ${response.status}`;
    throw new QdrantApiError(String(message), response.status);
  }

  /** `PUT /collections/{name}/points` — upserts (creates or replaces) points by id. */
  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    const { response, parsed } = await this.request(`/collections/${encodeURIComponent(collection)}/points`, "PUT", { points });

    if (!response.ok) {
      const message =
        (typeof parsed?.status === "object" && parsed.status?.error) || `Qdrant upsertPoints returned HTTP ${response.status}`;
      throw new QdrantApiError(String(message), response.status);
    }
  }

  /**
   * Raw, UNSCOPED vector search — `POST /collections/{name}/points/search`.
   * Intentionally NOT exported for direct use by application/agent-tool
   * code (see this file's header TENANT ISOLATION section). Only
   * `searchForTenant()` below should be called from outside this file.
   */
  private async search(
    collection: string,
    vector: number[],
    opts: { limit?: number; filter?: QdrantFilter } = {},
  ): Promise<QdrantSearchResult[]> {
    const { response, parsed } = await this.request<Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>>(
      `/collections/${encodeURIComponent(collection)}/points/search`,
      "POST",
      {
        vector,
        limit: opts.limit ?? 10,
        filter: opts.filter,
        with_payload: true,
      },
    );

    if (!response.ok) {
      const message =
        (typeof parsed?.status === "object" && parsed.status?.error) || `Qdrant search returned HTTP ${response.status}`;
      throw new QdrantApiError(String(message), response.status);
    }

    return (parsed?.result ?? []).map((item) => ({
      id: item.id,
      score: item.score,
      payload: item.payload ?? {},
    }));
  }

  /**
   * The ONLY search entry point application/agent-tool code should call.
   * Always merges a `tenant_id` equality clause into the filter's `must`
   * array — the tenant-isolation boundary documented in this file's header
   * comment. A caller-supplied filter's own `must` clauses are preserved
   * alongside it (AND semantics), never overwritten.
   */
  async searchForTenant(
    collection: string,
    tenantId: string,
    vector: number[],
    opts: { limit?: number; filter?: QdrantFilter } = {},
  ): Promise<QdrantSearchResult[]> {
    const tenantClause = { key: "tenant_id", match: { value: tenantId } };
    const mergedFilter: QdrantFilter = {
      ...opts.filter,
      must: [...(opts.filter?.must ?? []), tenantClause],
    };
    return this.search(collection, vector, { limit: opts.limit, filter: mergedFilter });
  }

  /** `POST /collections/{name}/points/delete` with body `{ points: [ids] }`. */
  async deletePoints(collection: string, ids: Array<string | number>): Promise<void> {
    const { response, parsed } = await this.request(`/collections/${encodeURIComponent(collection)}/points/delete`, "POST", {
      points: ids,
    });

    if (!response.ok) {
      const message =
        (typeof parsed?.status === "object" && parsed.status?.error) || `Qdrant deletePoints returned HTTP ${response.status}`;
      throw new QdrantApiError(String(message), response.status);
    }
  }
}

export class QdrantNotConfiguredError extends Error {
  constructor(message = "No Qdrant instance is configured (set QDRANT_URL).") {
    super(message);
    this.name = "QdrantNotConfiguredError";
  }
}

/**
 * Always honestly reports not-configured — used whenever QDRANT_URL isn't
 * set (every environment this codebase has actually run in today). Every
 * method throws QdrantNotConfiguredError rather than ever returning
 * fabricated search results; every real call site must check
 * `isConfigured` first (same "check isConfigured first" convention as
 * NotConfiguredLlmProvider in llmProvider.ts).
 */
export class NotConfiguredVectorStore {
  readonly isConfigured = false;

  async ensureCollection(): Promise<void> {
    throw new QdrantNotConfiguredError();
  }
  async upsertPoints(): Promise<void> {
    throw new QdrantNotConfiguredError();
  }
  async searchForTenant(): Promise<QdrantSearchResult[]> {
    throw new QdrantNotConfiguredError();
  }
  async deletePoints(): Promise<void> {
    throw new QdrantNotConfiguredError();
  }
}

/**
 * Resolver: the one place every call site should go through. Returns a real
 * QdrantClient when env.qdrantUrl is set, otherwise the honest
 * NotConfiguredVectorStore — never throws, so callers always check
 * `.isConfigured` rather than try/catch-ing a missing-config error.
 */
export function getQdrantClient(): QdrantClient | NotConfiguredVectorStore {
  if (!env.qdrantUrl) return new NotConfiguredVectorStore();
  return new QdrantClient(env.qdrantUrl, env.qdrantApiKey);
}

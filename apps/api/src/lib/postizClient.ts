/**
 * Fetch-based Postiz HTTP client for apps/api, following the same pattern
 * as apps/api/src/lib/listmonkClient.ts (slim, direct, fetch-based,
 * honest-failure, never fabricates a result standing in for a real call).
 *
 * Verified against a real read-only clone of gitroomhq/postiz-app
 * (~/project/Growth/postiz-app, reference only, AGPLv3, never forked/
 * modified — see docs/LICENCE_COMPLIANCE.md's Postiz entry) at:
 *   - apps/backend/src/public-api/routes/v1/public.integrations.controller.ts
 *     (the actual `/public/v1` route table this client calls)
 *   - apps/sdk/src/index.ts (Postiz's own official Node SDK — confirms the
 *     auth header convention: `Authorization: <apiKey>`, no "Bearer "
 *     prefix, no custom scheme)
 *   - libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts /
 *     get.posts.dto.ts / change.post.status.dto.ts (request bodies)
 *   - libraries/nestjs-libraries/src/dtos/integrations/connect.link.dto.ts
 *     (POST /integrations/connect body)
 *   - libraries/nestjs-libraries/src/database/prisma/schema.prisma's
 *     `enum State { QUEUE PUBLISHED ERROR DRAFT }` (a post's real status
 *     values)
 *
 * Endpoints used (all under `${baseUrl}/public/v1`):
 *   - POST   /posts                  — schedule ('schedule'/'now') or save
 *     a draft. Real create; returns Postiz's own post/group id.
 *   - GET    /posts                  — list posts in a date range (there is
 *     no GET /posts/:id in the public API — see getPost()'s doc comment
 *     for how this client works around that honestly).
 *   - DELETE /posts/:id              — cancel/delete a scheduled post.
 *   - GET    /integrations           — the organization's connected social
 *     accounts (real connection state, not guessed).
 *   - POST   /integrations/connect   — starts Postiz's own OAuth connect
 *     flow for one more social network; returns a URL to redirect the
 *     tenant's browser to. Postiz handles the entire per-network OAuth
 *     dance itself — this platform never re-implements OAuth per network.
 *   - GET    /analytics/post/:postId — real engagement metrics for a
 *     published post, when the connected provider supports analytics
 *     (passed through completely unmodified — never reshaped into a
 *     fabricated number).
 *   - GET    /me                     — resolves the API key to its
 *     Organization (id + name) and, for an OAuth app token, the acting
 *     user. Used as this client's real identity-confirming call before
 *     ever storing a postiz_organization_links row, and doubles as the
 *     lightweight health-check call.
 *
 * Honesty contract (same convention as ListmonkApiError/
 * ListmonkUnreachableError): every method throws a typed error on a
 * non-2xx/transport failure rather than returning a fabricated success —
 * except checkHealth(), which always resolves to an honest
 * { status: "ok" | "error" } result instead of throwing.
 */

export class PostizApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "PostizApiError";
    this.status = status;
    this.body = body;
  }
}

export class PostizUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Postiz service at ${baseUrl} is unreachable or errored: ${causeMessage}`);
    this.name = "PostizUnreachableError";
    this.cause = cause;
  }
}

export interface PostizClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface PostizIntegrationSummary {
  id: string;
  name: string;
  identifier: string;
  picture?: string | null;
  disabled?: boolean;
}

export interface CreatePostInput {
  /** 'now' publishes immediately; 'schedule' queues for `scheduledAt`; 'draft' saves without publishing. */
  type: "now" | "schedule" | "draft";
  /** ISO 8601. Required by Postiz's CreatePostDto even for type 'now' (it still validates as a date). */
  date: string;
  /** Postiz integration ids (GET /integrations' `id` field) this post targets. */
  integrationIds: string[];
  content: string;
  shortLink?: boolean;
}

export interface CreatePostResult {
  /** Raw, unmodified Postiz response — contains at least one post's id/group per targeted integration. */
  raw: unknown;
  /** Best-effort extraction of the first created post's id, when present in the response shape. */
  postId: string | null;
  postGroup: string | null;
}

export interface ListPostsInput {
  startDate: string;
  endDate: string;
  customer?: string;
}

export interface ConnectLinkResult {
  url: string;
}

export interface PostizHealthResult {
  status: "ok" | "error";
  detail?: string;
}

export interface PostizIdentity {
  organization: { id: string; name: string };
  user: { id: string; name: string; picture: string | null } | null;
}

function extractPostIds(raw: unknown): { postId: string | null; postGroup: string | null } {
  // createPost's real response shape is "whatever PostsService.createPost
  // returns" (not documented as a fixed public-API DTO) — this extraction
  // is deliberately defensive/best-effort over a few plausible shapes
  // rather than asserting one, so a client caller can still treat a
  // genuinely-successful-but-differently-shaped response as success
  // (falling back to null ids, never inventing one).
  if (!raw || typeof raw !== "object") return { postId: null, postGroup: null };
  const obj = raw as Record<string, unknown>;
  const postsArray = Array.isArray(obj.posts) ? obj.posts : Array.isArray(obj) ? (obj as unknown[]) : null;
  const first = postsArray && postsArray.length > 0 ? (postsArray[0] as Record<string, unknown>) : obj;
  const postId = typeof first?.id === "string" ? first.id : null;
  const postGroup = typeof first?.group === "string" ? first.group : typeof obj.group === "string" ? (obj.group as string) : null;
  return { postId, postGroup };
}

/**
 * Thin typed wrapper over Postiz's `/public/v1` REST API. Construct via
 * createPostizClient() — this class itself takes no DB/env dependency,
 * matching listmonkClient.ts's "pure, explicit config" factory pattern.
 */
export class PostizClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PostizClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Verified against apps/sdk/src/index.ts: the raw API key, no
      // "Bearer " prefix — Postiz's own SDK sends it exactly this way.
      Authorization: this.apiKey,
    };
    try {
      response = await this.fetchImpl(`${this.baseUrl}/public/v1${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PostizUnreachableError(this.baseUrl, err);
    }

    let parsedBody: unknown;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }

    if (!response.ok) {
      const message =
        parsedBody && typeof parsedBody === "object" && "msg" in (parsedBody as Record<string, unknown>)
          ? String((parsedBody as Record<string, unknown>).msg)
          : `Postiz ${method} ${path} failed with HTTP ${response.status}`;
      throw new PostizApiError(response.status, message, parsedBody);
    }

    return parsedBody as T;
  }

  /** GET /me — resolves the configured API key to its Organization (+ acting user, for an OAuth app token). */
  async getIdentity(): Promise<PostizIdentity> {
    return this.request<PostizIdentity>("GET", "/me");
  }

  /** GET /integrations — the organization's real connected social accounts. */
  async listIntegrations(): Promise<PostizIntegrationSummary[]> {
    return this.request<PostizIntegrationSummary[]>("GET", "/integrations");
  }

  /**
   * POST /integrations/connect — starts Postiz's own OAuth connect flow
   * for `integration` (a Postiz provider identifier, e.g. "x", "linkedin").
   * Returns a URL this platform redirects the tenant's browser to; Postiz
   * performs the entire OAuth dance for that network itself.
   */
  async createConnectLink(integration: string, redirectUrl?: string): Promise<ConnectLinkResult> {
    return this.request<ConnectLinkResult>("POST", "/integrations/connect", {
      integration,
      redirectUrl,
    });
  }

  /** POST /posts — real schedule/publish/draft create call. */
  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const raw = await this.request("POST", "/posts", {
      type: input.type,
      date: input.date,
      shortLink: input.shortLink ?? false,
      tags: [],
      posts: input.integrationIds.map((id) => ({
        integration: { id },
        value: [{ content: input.content, image: [] }],
        settings: { __type: id },
      })),
    });
    const { postId, postGroup } = extractPostIds(raw);
    return { raw, postId, postGroup };
  }

  /**
   * GET /posts?startDate&endDate — the public API has no GET /posts/:id
   * (confirmed against public.integrations.controller.ts's full route
   * table above) so a single post's current state is found by listing a
   * date range that contains it and filtering client-side. Callers doing a
   * status sync should pass a window that comfortably covers the post's
   * `date`/`scheduled_at`.
   */
  async listPosts(input: ListPostsInput): Promise<unknown[]> {
    const params = new URLSearchParams({ startDate: input.startDate, endDate: input.endDate });
    if (input.customer) params.set("customer", input.customer);
    const result = await this.request<{ posts: unknown[] } | unknown[]>("GET", `/posts?${params.toString()}`);
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.posts) ? result.posts : [];
  }

  /** DELETE /posts/:id — cancels/deletes a scheduled (not-yet-published) post. */
  async deletePost(postId: string): Promise<void> {
    await this.request("DELETE", `/posts/${encodeURIComponent(postId)}`);
  }

  /**
   * GET /analytics/post/:postId?date=<days> — real engagement metrics,
   * returned completely unmodified. `days` mirrors the controller's own
   * `@Query('date') date: string` param (a lookback window in days, per
   * PostsService.checkPostAnalytics's signature), default 30.
   */
  async getPostAnalytics(postId: string, days = 30): Promise<unknown> {
    return this.request("GET", `/analytics/post/${encodeURIComponent(postId)}?date=${days}`);
  }

  /**
   * Lightweight health check: GET /me is the cheapest authenticated call
   * that proves both reachability and that the API key is still valid.
   * Never throws — maps any failure to an honest { status: "error" }.
   */
  async checkHealth(): Promise<PostizHealthResult> {
    try {
      await this.getIdentity();
      return { status: "ok" };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { status: "error", detail };
    }
  }
}

/** Pure factory: explicit config, no DB/env access — directly testable. */
export function createPostizClient(opts: PostizClientOptions): PostizClient {
  return new PostizClient(opts);
}

/**
 * Standalone module-level export matching the generic health-check
 * contract `apps/api/src/routes/integrations.ts`'s loadProviderHealthCheck()
 * documents and dynamically imports (`checkHealth(credential): Promise<{status,
 * detail?}>`). This lets the GENERIC `POST .../integrations/postiz/health-check`
 * route (shared across all 3 Milestone 2 providers) pick up a real Postiz
 * health-check automatically, in addition to this integration's own
 * dedicated `GET .../integrations/postiz/health` (postizIntegration.ts),
 * which additionally updates channel_provider_configs' org-link-aware
 * status. Never throws for an ordinary unreachable/unauthorized provider —
 * only for a genuine config error (missing baseUrl), matching the
 * contract's "reserve thrown errors for programmer bugs" rule.
 */
export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: "connected" | "error"; detail?: string }> {
  const baseUrl = credential.config?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl || !credential.secret) {
    return { status: "error", detail: "Missing baseUrl in config or no secret (API key) on file for this integration." };
  }
  const client = createPostizClient({ baseUrl, apiKey: credential.secret });
  const result = await client.checkHealth();
  return result.status === "ok" ? { status: "connected" } : { status: "error", detail: result.detail };
}

export type PostizClientResolution = PostizClient | { status: "not_configured"; detail: string };

/**
 * Resolves a PostizClient for a given tenant/project.
 *
 * Resolution order (same documented fallback contract as
 * listmonkClient.ts's getListmonkClientForTenant()):
 *   1. Per-tenant encrypted credential, via
 *      apps/api/src/lib/integrationCredentials.ts's
 *      getIntegrationCredential(tenantDb, tenantId, projectId, "postiz").
 *      Expected shape once connected (see routes/postizIntegration.ts's
 *      connect handler, the only writer of this row): config.baseUrl,
 *      secret = the decrypted Postiz API key.
 *   2. Global env vars POSTIZ_BASE_URL / POSTIZ_API_KEY (see
 *      apps/api/src/config/env.ts) — a single shared Postiz instance/org
 *      fallback, same convention as LISTMONK_BASE_URL/LISTMONK_API_KEY.
 *   3. Neither configured -> { status: "not_configured" }, never a
 *      fabricated client.
 */
export async function getPostizClientForTenant(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<PostizClientResolution> {
  try {
    const { getIntegrationCredential } = await import("./integrationCredentials.js");
    const credential = await getIntegrationCredential(tenantDb, tenantId, projectId, "postiz");
    if (credential && credential.status === "connected" && credential.secret) {
      const baseUrl = credential.config?.baseUrl;
      if (typeof baseUrl === "string" && baseUrl) {
        return createPostizClient({ baseUrl, apiKey: credential.secret });
      }
    }
  } catch {
    // integrationCredentials.ts unavailable for some reason — fall through
    // to the env-var path rather than failing the request.
  }

  const { env } = await import("../config/env.js");
  if (env.postizBaseUrl && env.postizApiKey) {
    return createPostizClient({ baseUrl: env.postizBaseUrl, apiKey: env.postizApiKey });
  }

  return {
    status: "not_configured",
    detail: "No per-tenant Postiz credential is connected and POSTIZ_BASE_URL/POSTIZ_API_KEY are not set.",
  };
}

/**
 * Chatwoot HTTP client for apps/api.
 *
 * Same "slim, fetch-based, honest about failure" pattern as
 * apps/api/src/lib/crawl4aiClient.ts (that module's doc comment is the
 * canonical explanation of why this codebase writes these clients this
 * way): a typed class wrapping a handful of real HTTP calls against a
 * self-hosted service, no silent fabrication of data when the service is
 * unreachable or not configured.
 *
 * Endpoint shapes and auth header verified directly against the Chatwoot
 * source in the reference clone (~/project/Growth/chatwoot, read-only,
 * never modified by this change):
 *   - Account-scoped REST API: `/api/v1/accounts/:account_id/...`
 *     (contacts, conversations, conversations/:id/messages) — see
 *     app/controllers/api/v1/accounts/{contacts,conversations}_controller.rb
 *     and app/controllers/api/v1/accounts/conversations/messages_controller.rb.
 *   - Auth header: `api_access_token` (lowercase, underscored) — confirmed
 *     in app/controllers/concerns/access_token_auth_helper.rb:
 *     `request.headers[:api_access_token] || request.headers[:HTTP_API_ACCESS_TOKEN]`.
 *     This is a user/agent-bot access token, not a JWT — sent as a plain
 *     header value, no "Bearer " prefix.
 *
 * Only a handful of response fields are modeled (id + the few fields this
 * codebase actually reads) — Chatwoot's real payloads carry many more
 * fields than are declared here, so these interfaces are intentionally a
 * loose subset, not a full schema.
 */

import { parseChatwootSecret } from "./chatwootIdentity.js";

export class ChatwootNotConfiguredError extends Error {
  constructor() {
    super("Chatwoot is not configured for this tenant/project — no baseUrl/accountId/apiAccessToken available.");
    this.name = "ChatwootNotConfiguredError";
  }
}

export class ChatwootApiError extends Error {
  status: number;
  body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ChatwootApiError";
    this.status = status;
    this.body = body;
  }
}

export class ChatwootUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Chatwoot service at ${baseUrl} is unreachable: ${causeMessage}`);
    this.name = "ChatwootUnreachableError";
    this.cause = cause;
  }
}

export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: string;
  apiAccessToken: string;
  fetchImpl?: typeof fetch;
}

export interface ChatwootContactInput {
  name?: string;
  email?: string;
  phoneNumber?: string;
  identifier?: string;
  customAttributes?: Record<string, unknown>;
}

export interface ChatwootContact {
  id: number;
  name?: string;
  email?: string;
  phoneNumber?: string;
}

export interface ChatwootConversationInput {
  /** Chatwoot source_id of the contact's contact_inbox, OR contactId below (API accepts either). */
  contactId?: number;
  inboxId: number;
  sourceId?: string;
  additionalAttributes?: Record<string, unknown>;
}

export interface ChatwootConversation {
  id: number;
  inboxId?: number;
  status?: string;
}

export interface ChatwootMessageInput {
  content: string;
  /** Defaults to 'outgoing' (an agent/bot reply) — Chatwoot's own default for this endpoint. */
  messageType?: "outgoing" | "incoming";
  private?: boolean;
}

export interface ChatwootMessage {
  id: number;
  content?: string;
  conversationId?: number;
}

export interface ChatwootHealthResult {
  status: "ok" | "unreachable" | "not_configured";
  detail?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * The reusable, testable core: a pure class built from explicit config, no
 * DB access and no env-var reads of its own (that lookup is
 * getChatwootClientForTenant's job, below). Every method makes a real HTTP
 * call via `fetch` (or an injected `fetchImpl` for tests) and maps
 * non-2xx/transport failures honestly rather than returning fabricated
 * data.
 */
export class ChatwootClient {
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly apiAccessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ChatwootClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.accountId = opts.accountId;
    this.apiAccessToken = opts.apiAccessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private accountPath(path: string): string {
    return joinUrl(this.baseUrl, `/api/v1/accounts/${this.accountId}${path}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.accountPath(path), {
        method,
        headers: {
          "Content-Type": "application/json",
          api_access_token: this.apiAccessToken,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ChatwootUnreachableError(this.baseUrl, err);
    }

    let parsed: unknown = undefined;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new ChatwootApiError(
        response.status,
        `Chatwoot API request failed: ${method} ${path} -> HTTP ${response.status} ${response.statusText}`,
        parsed,
      );
    }

    return parsed as T;
  }

  /** POST /api/v1/accounts/:account_id/contacts */
  async createContact(input: ChatwootContactInput): Promise<ChatwootContact> {
    const body = {
      name: input.name,
      email: input.email,
      phone_number: input.phoneNumber,
      identifier: input.identifier,
      custom_attributes: input.customAttributes,
    };
    const result = await this.request<{ payload?: { contact?: Record<string, unknown> }; id?: number } & Record<string, unknown>>(
      "POST",
      "/contacts",
      body,
    );
    // Chatwoot's contacts#create responds with { payload: { contact: {...} } }.
    const contact = (result.payload?.contact ?? result) as Record<string, unknown>;
    return {
      id: Number(contact.id),
      name: typeof contact.name === "string" ? contact.name : undefined,
      email: typeof contact.email === "string" ? contact.email : undefined,
      phoneNumber: typeof contact.phone_number === "string" ? contact.phone_number : undefined,
    };
  }

  /** POST /api/v1/accounts/:account_id/conversations */
  async createConversation(input: ChatwootConversationInput): Promise<ChatwootConversation> {
    const body = {
      contact_id: input.contactId,
      inbox_id: input.inboxId,
      source_id: input.sourceId,
      additional_attributes: input.additionalAttributes,
    };
    const result = await this.request<Record<string, unknown>>("POST", "/conversations", body);
    return {
      id: Number(result.id),
      inboxId: typeof result.inbox_id === "number" ? result.inbox_id : undefined,
      status: typeof result.status === "string" ? result.status : undefined,
    };
  }

  /** POST /api/v1/accounts/:account_id/conversations/:conversation_id/messages — reply to a conversation. */
  async sendMessage(conversationId: number | string, input: ChatwootMessageInput): Promise<ChatwootMessage> {
    const body = {
      content: input.content,
      message_type: input.messageType ?? "outgoing",
      private: input.private ?? false,
    };
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/conversations/${conversationId}/messages`,
      body,
    );
    return {
      id: Number(result.id),
      content: typeof result.content === "string" ? result.content : undefined,
      conversationId: typeof result.conversation_id === "number" ? result.conversation_id : Number(conversationId),
    };
  }

  /** GET /api/v1/accounts/:account_id/conversations */
  async listConversations(params: { assigneeType?: string; status?: string } = {}): Promise<ChatwootConversation[]> {
    const query = new URLSearchParams();
    if (params.assigneeType) query.set("assignee_type", params.assigneeType);
    if (params.status) query.set("status", params.status);
    const qs = query.toString();
    const result = await this.request<{ data?: { payload?: Record<string, unknown>[] } } & Record<string, unknown>>(
      "GET",
      `/conversations${qs ? `?${qs}` : ""}`,
    );
    const payload = result.data?.payload ?? [];
    return payload.map((row) => ({
      id: Number(row.id),
      inboxId: typeof row.inbox_id === "number" ? row.inbox_id : undefined,
      status: typeof row.status === "string" ? row.status : undefined,
    }));
  }

  /**
   * GET /api/v1/accounts/:account_id/contacts?per_page=1 — the cheapest
   * genuine authenticated round trip this API offers, used by the
   * module-level checkClientHealth() below.
   */
  async ping(): Promise<void> {
    await this.request<unknown>("GET", "/contacts?per_page=1");
  }

  /** GET /api/v1/accounts/:account_id/inboxes — used to populate an inbox picker in the dashboard. */
  async listInboxes(): Promise<Array<{ id: number; name?: string }>> {
    const result = await this.request<{ payload?: Record<string, unknown>[] } & Record<string, unknown>>(
      "GET",
      "/inboxes",
    );
    const payload = result.payload ?? [];
    return payload.map((row) => ({
      id: Number(row.id),
      name: typeof row.name === "string" ? row.name : undefined,
    }));
  }
}

/** Pure, explicit-config factory — the reusable/testable core described in this module's header. */
export function createChatwootClient(opts: ChatwootClientOptions): ChatwootClient {
  return new ChatwootClient(opts);
}

/**
 * Lightweight real health check against an already-built client: fetches
 * at most one contact (`per_page=1`) from the configured account. Cheaper
 * than hitting conversations, and still a genuine authenticated round trip
 * (an invalid api_access_token or account id fails this the same way it
 * would fail any other call), so a true "ok" actually means Chatwoot is
 * reachable and these credentials work — never fabricated.
 *
 * Named checkClientHealth (not checkHealth) to avoid colliding with this
 * module's checkHealth() export further below, which is the one
 * apps/api/src/routes/integrations.ts's generic
 * POST /integrations/:provider/health-check dynamically imports and calls
 * (loadProviderHealthCheck() in that file) — different signature (a raw
 * credential object, not a built client), so it needs its own name.
 */
export async function checkClientHealth(client: ChatwootClient): Promise<ChatwootHealthResult> {
  try {
    await client.ping();
    return { status: "ok" };
  } catch (err) {
    if (err instanceof ChatwootApiError) {
      return { status: "unreachable", detail: `HTTP ${err.status}: ${err.message}` };
    }
    if (err instanceof ChatwootUnreachableError) {
      return { status: "unreachable", detail: err.message };
    }
    return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export type ChatwootClientResolution = ChatwootClient | { status: "not_configured"; detail: string };

/**
 * Resolves a ChatwootClient for a given tenant/project.
 *
 * Resolution order (same two-step fallback contract as
 * getListmonkClientForTenant() in apps/api/src/lib/listmonkClient.ts —
 * mirrored here deliberately so both integrations behave identically
 * while apps/api/src/lib/integrationCredentials.ts is being built
 * concurrently by another change):
 *
 *   1. Per-tenant encrypted credentials, via
 *      integrationCredentials.ts's getIntegrationCredential(tenantDb,
 *      tenantId, projectId, "chatwoot"). That module did NOT exist yet
 *      when this was written (confirmed: `ls
 *      apps/api/src/lib/integrationCredentials.ts` -> ENOENT at the time
 *      of this change) — a dynamic `import(...).catch(() => null)` means
 *      a missing module, or one that exists but returns null / a
 *      non-"connected" status for this tenant, both fall through to step
 *      2 rather than throwing. This makes this resolver independently
 *      useful right now and automatically pick up real per-tenant
 *      credentials once that module lands, with no code change needed
 *      here. Expected credential shape once available: config.baseUrl +
 *      config.accountId (plaintext config), secret = the decrypted
 *      api_access_token.
 *   2. Global env vars CHATWOOT_BASE_URL / CHATWOOT_ACCOUNT_ID /
 *      CHATWOOT_API_ACCESS_TOKEN (apps/api/src/config/env.ts) — the same
 *      single-shared-instance convention CRAWL4AI_BASE_URL/
 *      CRAWL4AI_API_TOKEN use for crawl4ai.
 *   3. Neither configured -> { status: "not_configured" }, never a
 *      fabricated client.
 */
export async function getChatwootClientForTenant(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<ChatwootClientResolution> {
  // Step 1: per-tenant encrypted credential, if that module exists yet.
  try {
    const mod = (await import("./integrationCredentials.js").catch(() => null)) as {
      getIntegrationCredential?: (
        tenantDb: import("pg").PoolClient,
        tenantId: string,
        projectId: string,
        provider: string,
      ) => Promise<{ config: Record<string, unknown>; secret: string | null; status: string } | null>;
    } | null;

    if (mod && typeof mod.getIntegrationCredential === "function") {
      const credential = await mod.getIntegrationCredential(tenantDb, tenantId, projectId, "chatwoot");
      if (credential && credential.status === "connected" && credential.secret) {
        const baseUrl = credential.config?.baseUrl;
        const accountId = credential.config?.accountId;
        // parseChatwootSecret handles both the original bare-token secret
        // shape (every credential connected before the identity-verification
        // feature) and the newer JSON envelope
        // { apiAccessToken, widgetHmacToken } (see chatwootIdentity.ts) —
        // either way this resolves to the same real api_access_token for
        // actually talking to Chatwoot's REST API.
        const { apiAccessToken } = parseChatwootSecret(credential.secret);
        if (
          typeof baseUrl === "string" &&
          baseUrl &&
          (typeof accountId === "string" || typeof accountId === "number") &&
          accountId &&
          apiAccessToken
        ) {
          return createChatwootClient({ baseUrl, accountId: String(accountId), apiAccessToken });
        }
      }
    }
  } catch {
    // integrationCredentials.ts doesn't exist yet, or threw — fall back
    // to env vars below rather than failing the request.
  }

  // Step 2: global env-var fallback (see config/env.ts chatwootBaseUrl /
  // chatwootAccountId / chatwootApiAccessToken).
  const { env } = await import("../config/env.js");
  if (env.chatwootBaseUrl && env.chatwootAccountId && env.chatwootApiAccessToken) {
    return createChatwootClient({
      baseUrl: env.chatwootBaseUrl,
      accountId: env.chatwootAccountId,
      apiAccessToken: env.chatwootApiAccessToken,
    });
  }

  return {
    status: "not_configured",
    detail:
      "No per-tenant chatwoot credential is connected and CHATWOOT_BASE_URL/CHATWOOT_ACCOUNT_ID/CHATWOOT_API_ACCESS_TOKEN are not set.",
  };
}

/**
 * The exact contract apps/api/src/routes/integrations.ts's generic
 * POST /integrations/:provider/health-check expects from
 * apps/api/src/lib/<provider>Client.ts (see that route's
 * loadProviderHealthCheck doc comment):
 *
 *   export async function checkHealth(
 *     credential: { config: Record<string, unknown>; secret: string | null }
 *   ): Promise<{ status: "connected" | "error"; detail?: string }>
 *
 * Builds a client directly from the credential it's handed (NOT via
 * getChatwootClientForTenant above, which also consults the global
 * env-var fallback) — the generic health-check route is explicitly asking
 * "is THIS tenant's own stored row good", so a missing/incomplete
 * credential here is honestly reported as 'error', never silently
 * upgraded to 'connected' by a shared fallback instance.
 */
export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: "connected" | "error"; detail?: string }> {
  const baseUrl = credential.config?.baseUrl;
  const accountId = credential.config?.accountId;
  const { apiAccessToken } = parseChatwootSecret(credential.secret);
  if (typeof baseUrl !== "string" || !baseUrl || !accountId || !apiAccessToken) {
    return {
      status: "error",
      detail: "Missing baseUrl/accountId in config or no apiAccessToken secret stored yet — connect first.",
    };
  }

  const client = createChatwootClient({
    baseUrl,
    accountId: String(accountId),
    apiAccessToken,
  });
  const result = await checkClientHealth(client);
  return result.status === "ok" ? { status: "connected" } : { status: "error", detail: result.detail };
}

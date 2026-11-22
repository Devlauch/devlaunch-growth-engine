/**
 * listmonkClient: a real HTTP client against a separately-run, unmodified
 * listmonk instance's documented REST API
 * (https://listmonk.app/docs/developer/overview/ — endpoints and the auth
 * header format below were cross-checked directly against the source
 * clone at ~/project/Growth/listmonk, read-only, for reference only:
 * cmd/handlers.go's route table and internal/auth/auth.go's
 * parseAuthHeader).
 *
 * Auth: listmonk's API key scheme is `Authorization: token <api_user>:<api_key>`
 * (see internal/auth/auth.go:541 `parseAuthHeader` — "token" prefix, not
 * "Bearer"). This is NOT the same as HTTP Bearer auth.
 *
 * Per docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's listmonk section and
 * docs/INTEGRATION_STATUS.md's Agent B contract: listmonk is run as a
 * fully independent service (its own container + own Postgres database —
 * see docker-compose.listmonk.yml) and is called ONLY via this documented
 * REST API. Nothing here forks or modifies listmonk's source — this file
 * contains zero listmonk code, only a client for its API, which keeps
 * platform inside the AGPLv3-safe "unmodified service, arms-length API
 * caller" pattern the audit requires.
 *
 * Honest-failure convention (matches NotConfiguredPostizProvider in
 * channelProviders.ts and the rest of this codebase): when a project has
 * no connected listmonk integration/credential, getListmonkClient()
 * returns a NotConfiguredListmonkClient whose every method throws
 * NotConfiguredListmonkError — it NEVER fabricates a subscriber count, a
 * campaign id, or a "sent" delivery status.
 */
import type { PoolClient } from "pg";
import { getIntegrationCredential } from "./integrationCredentials.js";

export class NotConfiguredListmonkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredListmonkError";
  }
}

export class ListmonkApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ListmonkApiError";
    this.status = status;
  }
}

export interface ListmonkCredential {
  baseUrl: string;
  apiUser: string;
  apiKey: string;
  /**
   * Optional per-tenant bounce/complaint webhook verification material (see
   * listmonkWebhooks.ts). None of these are used by the listmonk API client
   * itself — they are stored alongside the API credential purely because
   * both are tenant-scoped secrets belonging to the same integration row,
   * so they share the same encrypted_credential_ref envelope rather than a
   * second plaintext-risk column.
   */
  webhookVerification?: {
    /** Base64 DER SendGrid Event Webhook verification public key (ECDSA P-256). */
    sendgridPublicKey?: string;
    /** Postmark has no cryptographic signature scheme — HTTP Basic Auth on the webhook URL is its documented mechanism. */
    postmarkBasicAuthUser?: string;
    postmarkBasicAuthPass?: string;
  };
}

export interface ListmonkList {
  id: number;
  uuid: string;
  name: string;
}

export interface ListmonkSubscriber {
  id: number;
  uuid: string;
  email: string;
  name: string;
  status: string;
}

export interface ListmonkCampaign {
  id: number;
  uuid: string;
  name: string;
  status: string;
}

export interface UpsertSubscriberInput {
  email: string;
  name: string;
  listIds: number[];
  attribs?: Record<string, unknown>;
}

export interface CreateCampaignInput {
  name: string;
  subject: string;
  listIds: number[];
  body: string;
  contentType?: "richtext" | "html" | "plain" | "markdown";
}

/** Pluggable interface so routes/sync code never depend on the concrete HTTP implementation directly (tests swap in a fake). */
export interface ListmonkClient {
  /** Real, lightweight reachability check — GET /api/health. Never a cached/assumed "ok". */
  health(): Promise<{ ok: true }>;
  getOrCreateList(name: string, tag: string): Promise<ListmonkList>;
  upsertSubscriber(input: UpsertSubscriberInput): Promise<ListmonkSubscriber>;
  createCampaign(input: CreateCampaignInput): Promise<ListmonkCampaign>;
  /** PUT /api/campaigns/:id/status — the ONLY call that actually triggers/stops a send. */
  updateCampaignStatus(campaignId: number, status: "draft" | "scheduled" | "running" | "paused" | "cancelled"): Promise<ListmonkCampaign>;
  getCampaign(campaignId: number): Promise<ListmonkCampaign>;
}

/**
 * Always throws — used whenever a project has no 'connected' listmonk
 * integration row or its credential can't be decrypted. Mirrors
 * NotConfiguredPostizProvider's doc-comment convention exactly.
 */
export class NotConfiguredListmonkClient implements ListmonkClient {
  constructor(private readonly reason: string) {}

  private fail(): never {
    throw new NotConfiguredListmonkError(
      `Listmonk is not configured for this project (${this.reason}). Connect a real listmonk instance via ` +
        "POST .../integrations/listmonk/connect before syncing subscribers or creating campaigns. Refusing to " +
        "fabricate a subscriber count, campaign id, or delivery status.",
    );
  }

  async health(): Promise<{ ok: true }> {
    return this.fail();
  }
  async getOrCreateList(): Promise<ListmonkList> {
    return this.fail();
  }
  async upsertSubscriber(): Promise<ListmonkSubscriber> {
    return this.fail();
  }
  async createCampaign(): Promise<ListmonkCampaign> {
    return this.fail();
  }
  async updateCampaignStatus(): Promise<ListmonkCampaign> {
    return this.fail();
  }
  async getCampaign(): Promise<ListmonkCampaign> {
    return this.fail();
  }
}

/** Real HTTP implementation. `fetchImpl` is injectable so tests never make a real network call. */
export class RealListmonkClient implements ListmonkClient {
  constructor(
    private readonly credential: ListmonkCredential,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private authHeader(): string {
    return `token ${this.credential.apiUser}:${this.credential.apiKey}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.credential.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // listmonk always returns JSON for /api/*; a non-JSON body means
        // something upstream (proxy, wrong base URL) is misconfigured.
        throw new ListmonkApiError(res.status, `Non-JSON response from listmonk at ${url}`);
      }
    }

    if (!res.ok) {
      const message =
        json && typeof json === "object" && "message" in (json as Record<string, unknown>)
          ? String((json as Record<string, unknown>).message)
          : `listmonk request failed (${res.status})`;
      throw new ListmonkApiError(res.status, message);
    }

    return ((json as { data?: T })?.data ?? (json as T)) as T;
  }

  async health(): Promise<{ ok: true }> {
    await this.request("GET", "/api/health");
    return { ok: true };
  }

  /**
   * Find-or-create semantics by name (listmonk has no upsert-by-name
   * endpoint): list the lists, match by exact name, create if absent. Safe
   * to call repeatedly — the real list id is always re-read, never cached
   * beyond the caller's own mapping row.
   */
  async getOrCreateList(name: string, tag: string): Promise<ListmonkList> {
    const existing = await this.request<{ results: ListmonkList[] }>("GET", `/api/lists?per_page=all`);
    const found = existing.results?.find((l) => l.name === name);
    if (found) return found;

    return this.request<ListmonkList>("POST", "/api/lists", {
      name,
      type: "private",
      optin: "single",
      tags: [tag],
    });
  }

  /**
   * Find-or-create by email (listmonk's POST /api/subscribers 409s on a
   * duplicate email rather than upserting) — real upsert semantics for
   * retry-safety per docs/INTEGRATION_STATUS.md's idempotency contract.
   */
  async upsertSubscriber(input: UpsertSubscriberInput): Promise<ListmonkSubscriber> {
    try {
      return await this.request<ListmonkSubscriber>("POST", "/api/subscribers", {
        email: input.email,
        name: input.name,
        status: "enabled",
        lists: input.listIds,
        attribs: input.attribs ?? {},
      });
    } catch (err) {
      if (err instanceof ListmonkApiError && err.status === 409) {
        const existing = await this.request<{ results: ListmonkSubscriber[] }>(
          "GET",
          `/api/subscribers?query=${encodeURIComponent(`subscribers.email='${input.email.replace(/'/g, "''")}'`)}`,
        );
        const found = existing.results?.[0];
        if (!found) throw err;
        // Keep list membership in sync on every re-sync.
        await this.request("PUT", `/api/subscribers/${found.id}`, {
          email: found.email,
          name: input.name,
          status: "enabled",
          lists: input.listIds,
          attribs: input.attribs ?? {},
        });
        return found;
      }
      throw err;
    }
  }

  async createCampaign(input: CreateCampaignInput): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>("POST", "/api/campaigns", {
      name: input.name,
      subject: input.subject,
      lists: input.listIds,
      type: "regular",
      content_type: input.contentType ?? "richtext",
      body: input.body,
    });
  }

  async updateCampaignStatus(
    campaignId: number,
    status: "draft" | "scheduled" | "running" | "paused" | "cancelled",
  ): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>("PUT", `/api/campaigns/${campaignId}/status`, { status });
  }

  async getCampaign(campaignId: number): Promise<ListmonkCampaign> {
    return this.request<ListmonkCampaign>("GET", `/api/campaigns/${campaignId}`);
  }
}

/**
 * Credential model (see docs/INTEGRATION_STATUS.md section 6, the
 * orchestrator's registry/route-layer upgrade): `integrations.config`
 * (plain jsonb) holds non-secret settings — `{ baseUrl, apiUser }` for
 * listmonk — and `integrations.encrypted_credential_ref` holds ONE
 * encrypted opaque `secret` string, resolved via
 * integrationCredentials.ts's getIntegrationCredential(). The generic
 * POST .../integrations/listmonk/connect route (apps/api/src/routes/
 * integrations.ts, not edited by this change) only accepts a single
 * `secret` string, so this parses it two ways: a bare string is treated
 * as the listmonk API key directly (the common case — a tenant just
 * pastes their API key), or a JSON object
 * `{ apiKey, webhookVerification? }` when the tenant also wants to supply
 * bounce/complaint webhook verification material (SendGrid's public key,
 * Postmark's Basic Auth pair — see listmonkWebhooks.ts) without a second
 * secret field existing in the shared schema.
 */
export function parseListmonkCredential(
  config: Record<string, unknown> | null | undefined,
  secret: string | null | undefined,
): ListmonkCredential | null {
  if (!secret) return null;
  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl : null;
  const apiUser = typeof config?.apiUser === "string" ? config.apiUser : null;
  if (!baseUrl || !apiUser) return null;

  let apiKey = secret;
  let webhookVerification: ListmonkCredential["webhookVerification"];
  try {
    const parsed: unknown = JSON.parse(secret);
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).apiKey === "string") {
      apiKey = (parsed as Record<string, unknown>).apiKey as string;
      const wv = (parsed as Record<string, unknown>).webhookVerification;
      if (wv && typeof wv === "object") webhookVerification = wv as ListmonkCredential["webhookVerification"];
    }
  } catch {
    // Not JSON — secret is just the bare API key. Expected common case.
  }

  return { baseUrl, apiUser, apiKey, webhookVerification };
}

/**
 * Loads this project's listmonk integration row + decrypted credential
 * (via the shared integrationCredentials.ts resolver) and returns a real
 * client, or a NotConfiguredListmonkClient with an honest reason when no
 * usable credential exists. This is the ONE place routes/sync code should
 * call to get a client — never construct RealListmonkClient directly
 * outside tests.
 */
export async function getListmonkClient(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<{ client: ListmonkClient; integrationId: string | null }> {
  const idResult = await tenantDb.query<{ id: string }>(
    `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'listmonk'`,
    [tenantId, projectId],
  );
  if (idResult.rowCount === 0) {
    return { client: new NotConfiguredListmonkClient("no listmonk integration row for this project"), integrationId: null };
  }
  const integrationId = idResult.rows[0].id;

  const resolved = await getIntegrationCredential(tenantDb, tenantId, projectId, "listmonk");
  if (!resolved) {
    return { client: new NotConfiguredListmonkClient("no listmonk integration row for this project"), integrationId };
  }

  const credential = parseListmonkCredential(resolved.config, resolved.secret);
  if (!credential) {
    return {
      client: new NotConfiguredListmonkClient(
        "integration is missing a usable credential (config.baseUrl/config.apiUser + an encrypted secret are all required)",
      ),
      integrationId,
    };
  }

  return { client: new RealListmonkClient(credential), integrationId };
}

/**
 * The `checkHealth` export apps/api/src/routes/integrations.ts's generic
 * POST .../integrations/listmonk/health-check route looks for (see that
 * file's `loadProviderHealthCheck` doc comment for the exact contract).
 * Never throws for an ordinary unreachable/unauthorized listmonk instance
 * — only for a genuine programmer bug.
 */
export async function checkHealth(credential: {
  config: Record<string, unknown>;
  secret: string | null;
}): Promise<{ status: "connected" | "error"; detail?: string }> {
  const parsed = parseListmonkCredential(credential.config, credential.secret);
  if (!parsed) {
    return { status: "error", detail: "Missing config.baseUrl/config.apiUser or no secret stored yet" };
  }
  try {
    await new RealListmonkClient(parsed).health();
    return { status: "connected" };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

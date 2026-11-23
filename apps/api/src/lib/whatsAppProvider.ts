import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from "./channelProviders.js";
import { NotConfiguredError } from "./channelProviders.js";

/**
 * Real WhatsApp Business Platform (Cloud API) client, upgrading
 * channelProviders.ts's NotConfiguredWhatsAppProvider stub (Milestone 6 /
 * P5). No real WhatsApp Business phone-number id / access token is
 * available in this environment — every request path below is real,
 * working HTTP client code, exercised only against mocked `fetch`
 * responses in tests, never against the live API. That gap is reported as
 * BLOCKED, not hidden.
 *
 * API shape verified against Meta's own published documentation
 * (https://developers.facebook.com/docs/whatsapp/cloud-api):
 *   - Sending a template message: POST
 *     https://graph.facebook.com/v19.0/{phone_number_id}/messages, header
 *     `Authorization: Bearer <access_token>`, body
 *     `{ messaging_product: "whatsapp", to, type: "template",
 *     template: { name, language: { code }, components: [{ type: "body",
 *     parameters: [{ type: "text", text }, ...] }] } }` (documented at
 *     https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates).
 *     A successful response is
 *     `{ messaging_product: "whatsapp", contacts: [{ input, wa_id }],
 *     messages: [{ id }] }` — `messages[0].id` is the real, provider-issued
 *     message id this client returns; never fabricated.
 *   - Delivery-status webhooks: Meta's Cloud API posts delivery-status
 *     updates to the webhook URL registered in the WhatsApp Business app's
 *     dashboard, with the SAME signature scheme every other Graph API
 *     webhook uses (documented at
 *     https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 *     and .../securing-requests): header `X-Hub-Signature-256:
 *     sha256=<hex of HMAC-SHA256(app_secret, raw_request_body)>` — verified
 *     here with the exact same createHmac/timingSafeEqual house style this
 *     codebase already uses for Chatwoot's webhook signature
 *     (routes/chatwootWebhooks.ts), substituting WhatsApp's documented
 *     header name/payload (no timestamp component, unlike Chatwoot's
 *     `${timestamp}.${body}` scheme — WhatsApp signs the raw body alone).
 *     The dashboard-configured webhook `GET` verification handshake
 *     (hub.mode/hub.verify_token/hub.challenge) is also implemented, since
 *     Meta requires it before it will ever POST events to a URL.
 *   - Errors: Graph API's standard error envelope,
 *     `{"error":{"message","type","code","error_data":{"details"}}}`.
 */

const WHATSAPP_GRAPH_API_VERSION = "v19.0";
const WHATSAPP_GRAPH_BASE_URL = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`;
const DEFAULT_TIMEOUT_MS = 15_000;

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WhatsAppApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export class WhatsAppTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`WhatsApp Cloud API request timed out after ${timeoutMs}ms`);
    this.name = "WhatsAppTimeoutError";
  }
}

export class WhatsAppNetworkError extends Error {
  constructor(cause: unknown) {
    super(`WhatsApp Cloud API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WhatsAppNetworkError";
  }
}

export interface WhatsAppFetcher {
  (url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): WhatsAppFetcher {
  return (url, init) => fetch(url, init);
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * WhatsApp Business is a per-tenant connection (each tenant sends from its
 * own WhatsApp Business phone number) — the access token is stored via the
 * EXISTING integrationCredentials.ts mechanism
 * (integrations.encrypted_credential_ref); phoneNumberId is non-secret
 * config on the same row. WHATSAPP_BUSINESS_PHONE_NUMBER_ID/
 * _ACCESS_TOKEN remain available as a dev-mode/single-tenant fallback, same
 * convention as every other provider's env fallback.
 */
export interface WhatsAppTenantCredential {
  phoneNumberId: string;
  accessToken: string;
}

export async function resolveWhatsAppCredential(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<WhatsAppTenantCredential | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "whatsapp_business");
  const accessToken = resolved?.secret ?? env.whatsappBusinessAccessToken ?? null;
  const phoneNumberId =
    (resolved?.config?.phoneNumberId as string | undefined) ?? env.whatsappBusinessPhoneNumberId ?? null;
  if (!accessToken || !phoneNumberId) return null;
  return { phoneNumberId, accessToken };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface RawWhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string };
}

export async function sendWhatsAppTemplate(
  credential: WhatsAppTenantCredential,
  message: WhatsAppMessage,
  options: { languageCode?: string; timeoutMs?: number; fetcher?: WhatsAppFetcher } = {},
): Promise<{ messageId: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    messaging_product: "whatsapp",
    to: message.to,
    type: "template",
    template: {
      name: message.templateName,
      language: { code: options.languageCode ?? "en_US" },
      ...(message.parameters && message.parameters.length > 0
        ? { components: [{ type: "body", parameters: message.parameters.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  };

  let response: Response;
  try {
    response = await fetcher(`${WHATSAPP_GRAPH_BASE_URL}/${credential.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.accessToken}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new WhatsAppTimeoutError(timeoutMs);
    throw new WhatsAppNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  let responseBody: RawWhatsAppSendResponse | null = null;
  try {
    responseBody = (await response.json()) as RawWhatsAppSendResponse;
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new WhatsAppApiError(responseBody?.error?.message ?? `WhatsApp Cloud API returned HTTP ${response.status}`, response.status);
  }

  const messageId = responseBody?.messages?.[0]?.id;
  if (!messageId) {
    throw new Error(
      "WhatsApp Cloud API accepted the message request but no message id was found in its response — refusing to " +
        "report a fabricated delivery result.",
    );
  }
  return { messageId };
}

// ---------------------------------------------------------------------------
// WhatsAppProvider adapter
// ---------------------------------------------------------------------------

export class WhatsAppCloudApiProvider implements WhatsAppProvider {
  readonly name = "whatsapp_business";

  constructor(private readonly credential: WhatsAppTenantCredential) {}

  async sendTemplateMessage(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    const { messageId } = await sendWhatsAppTemplate(this.credential, message);
    return { provider: this.name, messageId, sentAt: new Date().toISOString() };
  }
}

/** Honest stub mirroring NotConfiguredWhatsAppProvider's exact convention. */
export class NotConfiguredWhatsAppCloudApiProvider implements WhatsAppProvider {
  readonly name = "whatsapp_business (not configured)";

  async sendTemplateMessage(_message: WhatsAppMessage): Promise<never> {
    throw new NotConfiguredError(
      "WhatsApp Business is not configured for this tenant/project (no connected whatsapp_business integration and " +
        "no WHATSAPP_BUSINESS_PHONE_NUMBER_ID/WHATSAPP_BUSINESS_ACCESS_TOKEN available). Connect WhatsApp Business via " +
        "POST .../integrations/whatsapp_business/connect first. Refusing to fabricate a delivery result.",
    );
  }
}

/** Builds the real-or-stub WhatsApp provider for one tenant/project. */
export async function buildWhatsAppProviderForTenant(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<WhatsAppProvider> {
  const credential = await resolveWhatsAppCredential(tenantDb, tenantId, projectId);
  return credential ? new WhatsAppCloudApiProvider(credential) : new NotConfiguredWhatsAppCloudApiProvider();
}

// ---------------------------------------------------------------------------
// Inbound webhook verification (delivery-status callbacks)
// ---------------------------------------------------------------------------

/**
 * Verifies Meta's dashboard-configured webhook subscription handshake: a
 * GET request carrying hub.mode=subscribe, hub.verify_token, and
 * hub.challenge. Returns the challenge string to echo back (HTTP 200, text
 * body) when the verify token matches, or null when it doesn't (the route
 * should respond 403 in that case) — documented at
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests.
 */
export function verifyWhatsAppWebhookSubscription(
  query: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string },
  expectedVerifyToken: string,
): string | null {
  if (query["hub.mode"] !== "subscribe") return null;
  if (!query["hub.verify_token"] || query["hub.verify_token"] !== expectedVerifyToken) return null;
  return query["hub.challenge"] ?? null;
}

/**
 * Verifies the X-Hub-Signature-256 header Meta attaches to every inbound
 * webhook delivery (delivery-status updates, inbound messages) — HMAC-SHA256
 * of the RAW request body, keyed by the WhatsApp app's app secret. Same
 * createHmac/timingSafeEqual house style as
 * routes/chatwootWebhooks.ts#verifyChatwootSignature, with WhatsApp's own
 * header name and un-timestamped payload (WhatsApp signs the raw body
 * alone, unlike Chatwoot's `${timestamp}.${body}` scheme).
 */
export function verifyWhatsAppWebhookSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface WhatsAppDeliveryStatusEvent {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string | null;
  recipientId: string | null;
  errorMessage: string | null;
}

interface RawWhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          errors?: Array<{ message?: string }>;
        }>;
      };
    }>;
  }>;
}

const VALID_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Extracts every delivery-status update from one webhook delivery body —
 * a single POST can carry multiple status updates batched across entries/
 * changes, per Meta's documented payload shape. Never guesses a status;
 * entries with an unrecognized/missing `status` are skipped. */
export function parseWhatsAppDeliveryStatusEvents(body: RawWhatsAppWebhookPayload): WhatsAppDeliveryStatusEvent[] {
  const events: WhatsAppDeliveryStatusEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status || !VALID_STATUSES.has(status.status)) continue;
        events.push({
          messageId: status.id,
          status: status.status as WhatsAppDeliveryStatusEvent["status"],
          timestamp: status.timestamp ?? null,
          recipientId: status.recipient_id ?? null,
          errorMessage: status.errors?.[0]?.message ?? null,
        });
      }
    }
  }
  return events;
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { ingestLead } from "../lib/leadIngestion.js";

/**
 * Public (unauthenticated-by-necessity) inbound webhook receiver for
 * Chatwoot's **AgentBot** model — per docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's
 * "chatwoot" section and docs/INTEGRATION_STATUS.md's integration
 * contract: an AgentBot (app/models/agent_bot.rb in the reference clone,
 * ~/project/Growth/chatwoot, read-only) registers one `outgoing_url` +
 * `secret` per Chatwoot account and receives the SAME conversation/message/
 * contact events a webhook would, while also being able to reply via
 * Chatwoot's normal REST API (apps/api/src/lib/chatwootClient.ts) — this is
 * the free path to "platform's own bot answers in Chatwoot", with no paid
 * Captain feature required.
 *
 * Why AgentBot over a plain account-level Webhook: both deliver the same
 * payload shapes, but only AgentBot gives an external service a documented
 * way to ALSO post replies back into the conversation via the API using
 * its own identity (`sender.type == "AgentBot"` in Chatwoot's UI) instead
 * of posing as a human agent — exactly the shape the audit recommended.
 *
 * Signature verification (real, not skipped): Chatwoot signs every
 * webhook/agent_bot delivery that has a `secret` configured with
 * HMAC-SHA256, verified directly against lib/webhooks/trigger.rb#request_headers
 * in the reference clone:
 *   X-Chatwoot-Timestamp: <unix seconds>
 *   X-Chatwoot-Signature: sha256=<hex of HMAC-SHA256(secret, "<ts>.<raw body>")>
 *
 * Raw-body note: app.ts's global `express.json()` now has a `verify`
 * callback that captures the exact request bytes onto `req.rawBody`
 * (added alongside this route specifically so this signature check can be
 * byte-exact — see app.ts and src/types/express.d.ts). This route prefers
 * `req.rawBody` when present and falls back to `JSON.stringify(req.body)`
 * only as a defensive last resort (e.g. in a test harness that doesn't
 * wire the same `verify` callback), which matches Ruby's `body.to_json`
 * byte-for-byte in the common case but is not a byte-identical guarantee
 * for exotic payloads (non-ASCII escaping, float formatting, etc).
 *
 * Auth model (everything else matches listmonkWebhooks.ts's established
 * pattern): no session/JWT (Chatwoot itself is the caller), tenant/project
 * identified by the URL, secret is a single GLOBAL env var
 * (CHATWOOT_WEBHOOK_SECRET — see config/env.ts) rather than per-tenant,
 * matching LISTMONK_WEBHOOK_SECRET's existing convention in this codebase.
 * If unset, every request is rejected with 503 rather than silently
 * accepting unauthenticated events.
 */
export const chatwootWebhooksRouter = Router();

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid(),
});

// Chatwoot timestamps deliveries at send time; a generous but bounded
// window guards against a captured-and-replayed request being accepted
// long after the fact, without being so tight that ordinary network/queue
// delay causes false rejections.
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

function verifySignature(req: import("express").Request): boolean {
  if (!env.chatwootWebhookSecret) return false;

  const signatureHeader = req.header("X-Chatwoot-Signature");
  const timestampHeader = req.header("X-Chatwoot-Timestamp");
  if (!signatureHeader || !timestampHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > SIGNATURE_MAX_AGE_SECONDS) return false;

  const bodyString = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
  const expected =
    "sha256=" + createHmac("sha256", env.chatwootWebhookSecret).update(`${timestampHeader}.${bodyString}`).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function deriveExternalEventId(body: unknown): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const candidate = obj.id ?? (obj.message as Record<string, unknown> | undefined)?.id;
    if (typeof candidate === "string" && candidate) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

/**
 * Chatwoot's webhook/agent_bot payloads are a loosely-typed grab-bag that
 * varies per `event` (contact_created, conversation_created,
 * conversation_updated, message_created, ...). Only the fields this route
 * actually reads are modeled — a defensive subset, not a full schema (same
 * convention as chatwootClient.ts).
 */
interface ChatwootWebhookPayload {
  event?: string;
  id?: number | string;
  content?: string;
  message_type?: string;
  conversation?: { id?: number; contact_inbox?: { source_id?: string } };
  contact?: { id?: number | string; name?: string; email?: string; phone_number?: string };
  sender?: { id?: number | string; name?: string; email?: string; type?: string };
  meta?: { sender?: { id?: number | string; name?: string; email?: string } };
}

/** Pulls the visitor contact out of whichever shape this event actually carries one in. */
function extractContact(payload: ChatwootWebhookPayload): { id: string; name?: string; email?: string } | null {
  const candidate = payload.contact ?? payload.meta?.sender ?? (payload.sender?.type !== "AgentBot" && payload.sender?.type !== "User" ? payload.sender : undefined);
  if (!candidate || candidate.id === undefined || candidate.id === null) return null;
  return {
    id: String(candidate.id),
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    email: typeof (candidate as { email?: unknown }).email === "string" ? (candidate as { email?: string }).email : undefined,
  };
}

const SYNCABLE_EVENTS = new Set(["contact_created", "conversation_created", "message_created"]);

/**
 * POST /api/v1/webhooks/chatwoot/:tenantId/:projectId (see app.ts's
 * mounting line — this is NOT under /api/v1/public, it has its own
 * top-level mount since it's a provider webhook, not a browser-facing
 * public widget surface)
 *
 * Records every event into the shared `integration_webhook_events` table
 * first (idempotent — see 286/287's dedup contract), then — for the
 * events that carry a visitor contact (contact_created,
 * conversation_created, an incoming message_created) — syncs that contact
 * into platform's real `leads` table via the EXISTING ingestLead() path
 * (apps/api/src/lib/leadIngestion.ts), the same one publicLeads.ts and
 * publicChatbot.ts use. `chatwoot_contact_leads` (migration 295/296) makes
 * this upsert-safe: the same Chatwoot contact across many events maps to
 * at most one lead.
 *
 * source is tagged 'public_widget' (the closest existing value in
 * leads.source's CHECK constraint — see 015_create_leads.sql/
 * 030_add_discovery_lead_source.sql; this agent was told not to widen that
 * constraint). The real distinction (this came from the Chatwoot live-chat
 * widget, not platform's own embeddable lead form) is preserved honestly
 * in `customFields.channel = "chatwoot"` plus the Chatwoot contact/
 * conversation ids — same pattern the landing-page-builder agent used for
 * its own source disambiguation last round.
 *
 * Only ever inserts a `leads` row — never sends a reply, never
 * auto-approves outreach. A captured lead still goes through the existing
 * agent + approval flow before any outbound action.
 */
chatwootWebhooksRouter.post("/:tenantId/:projectId", async (req, res, next) => {
  if (!env.chatwootWebhookSecret) {
    res.status(503).json({
      error: "chatwoot_webhook_not_configured",
      message: "CHATWOOT_WEBHOOK_SECRET is not configured on this server — refusing to accept webhook events.",
    });
    return;
  }

  if (!verifySignature(req)) {
    logger.warn("chatwoot webhook rejected: missing, invalid, or stale HMAC signature");
    res.status(401).json({ error: "unauthorized", message: "Invalid, missing, or expired webhook signature" });
    return;
  }

  const client = await pool.connect();
  let settled = false;
  let began = false;
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    const payload = (req.body ?? {}) as ChatwootWebhookPayload;

    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const integrationResult = await client.query<{ id: string }>(
      `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'chatwoot'`,
      [tenantId, projectId],
    );
    if (integrationResult.rowCount === 0) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      next(Errors.notFound("No chatwoot integration is registered for this tenant/project"));
      return;
    }
    const integrationId = integrationResult.rows[0].id;

    const eventType = payload.event ?? "unknown";
    const externalEventId = deriveExternalEventId(payload);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_webhook_events
         (tenant_id, integration_id, provider, external_event_id, event_type, payload)
       VALUES ($1, $2, 'chatwoot', $3, $4, $5::jsonb)
       ON CONFLICT (integration_id, external_event_id) DO NOTHING
       RETURNING id`,
      [tenantId, integrationId, externalEventId, eventType, JSON.stringify(payload)],
    );

    // Already processed on a prior delivery of the same event — a no-op,
    // never re-ingested as a second lead.
    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      settled = true;
      client.release();
      res.status(200).json({ received: true, deduplicated: true });
      return;
    }
    const webhookEventId = inserted.rows[0].id;

    let leadId: string | null = null;
    let processingStatus: "processed" | "ignored" = "ignored";

    if (SYNCABLE_EVENTS.has(eventType)) {
      // For message_created, only an inbound visitor message carries a
      // real contact worth syncing — an outgoing agent/bot reply's
      // `sender` is the agent/bot itself, not a visitor, and must never be
      // mistaken for one.
      const isOutgoingMessage = eventType === "message_created" && payload.message_type === "outgoing";
      const contact = isOutgoingMessage ? null : extractContact(payload);

      if (contact && (contact.email || contact.name)) {
        const existingMapping = await client.query<{ lead_id: string }>(
          `SELECT lead_id FROM chatwoot_contact_leads WHERE integration_id = $1 AND chatwoot_contact_id = $2`,
          [integrationId, contact.id],
        );

        if (existingMapping.rowCount && existingMapping.rowCount > 0) {
          leadId = existingMapping.rows[0].lead_id;
          processingStatus = "processed";
        } else {
          const lead = await ingestLead({
            client,
            tenantId,
            projectId,
            input: {
              name: contact.name,
              email: contact.email,
              customFields: {
                channel: "chatwoot",
                chatwootContactId: contact.id,
                chatwootConversationId: payload.conversation?.id ?? null,
                chatwootEvent: eventType,
              },
            },
            source: "public_widget",
            origin: "chatwoot",
          });
          leadId = lead.id;

          await client.query(
            `INSERT INTO chatwoot_contact_leads (tenant_id, project_id, integration_id, chatwoot_contact_id, lead_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (integration_id, chatwoot_contact_id) DO NOTHING`,
            [tenantId, projectId, integrationId, contact.id, lead.id],
          );
          processingStatus = "processed";
        }
      }
    }

    await client.query(
      `UPDATE integration_webhook_events SET status = $2, processed_at = now() WHERE id = $1`,
      [webhookEventId, processingStatus],
    );

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(200).json({ received: true, deduplicated: false, leadId, status: processingStatus });
  } catch (err) {
    if (!settled) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

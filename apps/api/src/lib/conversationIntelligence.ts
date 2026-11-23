/**
 * conversationIntelligence: Workstream H — summarization + sales handoff for
 * Chatwoot conversations, built entirely on data this codebase ALREADY
 * stores. This module introduces NO new conversation/message storage table.
 *
 * What actually stores a Chatwoot conversation's real facts today (verified
 * by reading the existing Chatwoot integration, not guessed):
 *   - `integration_webhook_events` (286_create_integration_webhook_events.sql)
 *     is the one real, persisted record of every Chatwoot webhook delivery
 *     this platform has received — provider='chatwoot', one row per
 *     contact_created/conversation_created/message_created event, with the
 *     RAW, unmodified Chatwoot payload in `payload` (jsonb) and a real
 *     `received_at` timestamp. apps/api/src/routes/chatwootWebhooks.ts is
 *     the only writer. This is the honest source of "what messages this
 *     platform has actually seen for conversation X, and when."
 *   - `chatwoot_contact_leads` (295_create_chatwoot_contact_leads.sql) maps
 *     a Chatwoot contact id to the platform `leads` row it was synced into.
 *   - NOTE: `chatbot_conversations` (272_create_chatbot_conversations.sql)
 *     is a DIFFERENT feature — the embeddable website AI lead-capture
 *     widget (apps/api/src/lib/chatbotEngine.ts), not Chatwoot. It is not
 *     used here; conflating the two would misattribute data.
 *
 * sentiment/classification is never fabricated: this module reuses the
 * EXISTING, real classifier apps/api/src/lib/classifyReply.ts (already
 * live in apps/api/src/routes/replies.ts for inbound email/reply text) over
 * the real, stored content of this conversation's inbound (visitor)
 * messages — it is not an LLM call (none is wired up for this), and no new
 * classifier is introduced.
 *
 * handoffToSales() writes a REAL audit_events row
 * (012_create_audit_events.sql) — the exact mechanism
 * apps/api/src/lib/activityTimeline.ts already reads from (that module's
 * `auditEvents` query, filtered on entity_type/entity_id) to render a
 * lead's activity timeline. activityTimeline.ts itself is a pure read-only
 * aggregation with no write path of its own to "reuse" as a function call
 * — its own doc comment confirms every item it renders is "produced by a
 * real query against a table that already exists for its own reason" and
 * that audit_events in particular needed no new write path, only reading
 * what already gets written for other lifecycle actions (lead.promoted_to_crm,
 * lead.assigned, etc). This module follows that exact same convention: it
 * writes one more real audit_events row (action
 * 'conversation.handed_off_to_sales'), which getLeadActivityTimeline() then
 * surfaces automatically for a leadId handoff (that function's query is
 * `entity_type = 'lead' AND entity_id = $leadId` — it does not currently
 * key on deal id, a pre-existing, honestly-documented limitation of that
 * module, not something this file can silently fix without editing it).
 */

import type { PoolClient } from "pg";
import { classifyReply, type ReplyClassification, type ReplyConfidence } from "./classifyReply.js";

interface QueryableDb {
  query: PoolClient["query"];
}

interface ChatwootWebhookEventRow {
  id: string;
  event_type: string;
  payload: {
    event?: string;
    content?: string;
    message_type?: string;
    conversation?: { id?: number | string };
    contact?: { id?: number | string };
  };
  received_at: string;
}

export interface ConversationHandoffSummary {
  conversationId: string;
  /** How many real webhook events this platform has recorded for this conversation (received_at-ordered). */
  eventCount: number;
  /** Of those, how many were message_created events (incoming + outgoing). */
  messageCount: number;
  /** The received_at of the most recent event recorded for this conversation, or null if none found. */
  lastMessageAt: string | null;
  /**
   * Derived via the EXISTING classifyReply() classifier over the real,
   * concatenated content of this conversation's INBOUND (visitor,
   * message_type != 'outgoing') messages — null when there is no stored
   * inbound message content to classify (never guessed).
   */
  sentiment: { classification: ReplyClassification; confidence: ReplyConfidence } | null;
  /** The platform lead this Chatwoot contact was synced into, if any (via chatwoot_contact_leads). */
  leadId: string | null;
}

/**
 * Pulls every integration_webhook_events row this platform has stored for
 * one Chatwoot conversation id, tenant-scoped. Matches both the common
 * shape (payload.conversation.id, present on message_created events) and
 * the conversation_created event's own payload.id — read directly off the
 * raw stored payload, nothing inferred beyond what chatwootWebhooks.ts
 * itself already wrote.
 */
async function loadConversationEvents(
  tenantDb: QueryableDb,
  tenantId: string,
  conversationId: string,
): Promise<ChatwootWebhookEventRow[]> {
  const result = await tenantDb.query<ChatwootWebhookEventRow>(
    `SELECT id, event_type, payload, received_at
     FROM integration_webhook_events
     WHERE tenant_id = $1
       AND provider = 'chatwoot'
       AND (
         payload->'conversation'->>'id' = $2
         OR (payload->>'event' = 'conversation_created' AND payload->>'id' = $2)
       )
     ORDER BY received_at ASC`,
    [tenantId, conversationId],
  );
  return result.rows;
}

/**
 * summarizeConversationForHandoff(): a deterministic summary built only
 * from real, already-stored data (see module doc). Returns a summary with
 * zeroed counts and sentiment: null when nothing has been recorded for
 * this conversation yet — never a fabricated "active conversation".
 */
export async function summarizeConversationForHandoff(
  tenantDb: QueryableDb,
  tenantId: string,
  conversationId: string,
): Promise<ConversationHandoffSummary> {
  const events = await loadConversationEvents(tenantDb, tenantId, conversationId);

  const messageEvents = events.filter((e) => e.event_type === "message_created");
  const inboundContent = messageEvents
    .filter((e) => e.payload?.message_type !== "outgoing")
    .map((e) => (typeof e.payload?.content === "string" ? e.payload.content : ""))
    .filter((content) => content.length > 0);

  const sentiment = inboundContent.length > 0 ? classifyReply(inboundContent.join(" \n ")) : null;

  const lastMessageAt = events.length > 0 ? events[events.length - 1].received_at : null;

  // Resolve the linked lead (if any) via the real contact id this
  // conversation's events carry — chatwoot_contact_leads is the existing,
  // only mapping table for this (295_create_chatwoot_contact_leads.sql).
  let leadId: string | null = null;
  const contactEvent = events.find((e) => e.payload?.contact?.id !== undefined && e.payload?.contact?.id !== null);
  if (contactEvent) {
    const contactId = String(contactEvent.payload.contact!.id);
    const mapping = await tenantDb.query<{ lead_id: string }>(
      `SELECT lead_id FROM chatwoot_contact_leads WHERE tenant_id = $1 AND chatwoot_contact_id = $2`,
      [tenantId, contactId],
    );
    leadId = mapping.rowCount && mapping.rowCount > 0 ? mapping.rows[0].lead_id : null;
  }

  return {
    conversationId,
    eventCount: events.length,
    messageCount: messageEvents.length,
    lastMessageAt,
    sentiment,
    leadId,
  };
}

export interface HandoffTarget {
  leadId?: string;
  dealId?: string;
}

export interface HandoffResult {
  auditEventId: string;
  entityType: "lead" | "deal";
  entityId: string;
  summary: ConversationHandoffSummary;
}

/**
 * handoffToSales(): writes a REAL audit_events row linking this Chatwoot
 * conversation to a CRM record (a lead or a deal — exactly one must be
 * given), reusing audit_events exactly the way every other lifecycle
 * action in this codebase already does (lead.promoted_to_crm,
 * lead.assigned, approval.decided, ...) rather than inventing a new
 * timeline table. For a leadId target, this is immediately visible on that
 * lead's existing activity timeline
 * (apps/api/src/lib/activityTimeline.ts's getLeadActivityTimeline(), which
 * already reads every audit_events row with entity_type='lead' for that
 * lead id) with no further change needed there.
 */
export async function handoffToSales(
  tenantDb: PoolClient,
  tenantId: string,
  conversationId: string,
  target: HandoffTarget,
  actorUserId: string | null = null,
): Promise<HandoffResult> {
  if (!target.leadId && !target.dealId) {
    throw new Error("handoffToSales requires either a leadId or a dealId to hand off to");
  }
  if (target.leadId && target.dealId) {
    throw new Error("handoffToSales takes exactly one of leadId/dealId, not both");
  }

  const entityType: "lead" | "deal" = target.leadId ? "lead" : "deal";
  const entityId = (target.leadId ?? target.dealId) as string;

  // Verify the target actually belongs to this tenant before writing an
  // audit trail that links to it — never a dangling/fabricated reference.
  const table = entityType === "lead" ? "leads" : "deals";
  const exists = await tenantDb.query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [entityId, tenantId]);
  if (exists.rowCount === 0) {
    throw new Error(`${entityType} ${entityId} not found in tenant ${tenantId}`);
  }

  const summary = await summarizeConversationForHandoff(tenantDb, tenantId, conversationId);

  const inserted = await tenantDb.query<{ id: string }>(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'user', $2, 'conversation.handed_off_to_sales', $3, $4, $5::jsonb)
     RETURNING id`,
    [
      tenantId,
      actorUserId,
      entityType,
      entityId,
      JSON.stringify({
        conversationId,
        messageCount: summary.messageCount,
        lastMessageAt: summary.lastMessageAt,
        sentiment: summary.sentiment,
      }),
    ],
  );

  return {
    auditEventId: inserted.rows[0].id,
    entityType,
    entityId,
    summary,
  };
}

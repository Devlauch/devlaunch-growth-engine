import type { PoolClient } from "pg";
import { getLeadActivityTimeline, type ActivityItem } from "./activityTimeline.js";

/**
 * multiTouchEngagement.ts: Workstream G2 — a single, per-lead, multi-touch
 * engagement history across EVERY real outbound+inbound touch this
 * codebase actually records.
 *
 * IMPORTANT, honestly-documented scope limitation: this codebase has NO
 * per-send email/message event table (no `sequence_sends`, `email_events`,
 * `message_sends`, or any row with an `opened_at`/`clicked_at` column —
 * confirmed by grepping every migration under packages/db/migrations
 * before writing this file). There is therefore no real "email opened" or
 * "link clicked" signal anywhere to surface here, and this file never
 * fabricates one. What DOES exist, and what this file aggregates instead,
 * is every real outbound/inbound event this codebase actually persists:
 *
 *   - activityTimeline.ts's getLeadActivityTimeline() — REUSED DIRECTLY,
 *     not reimplemented (per this codebase's anti-duplication convention,
 *     the same one meetingPrep.ts already follows): lead assignment,
 *     deal stage changes, meetings, crm_tasks, notes, lead_replies, and
 *     audit_events all come from that single shared aggregation.
 *   - sequence_enrollments (046/047/048_create_sequence*.sql): a lead
 *     being enrolled into (and, if applicable, stopped out of) an outbound
 *     sequence is itself a real, timestamped outbound touch, and is NOT
 *     covered by activityTimeline.ts.
 *   - message_drafts + message_draft_variants (052/053_create_message_
 *     draft*.sql): a drafted (and, once approved, approved) outbound
 *     message per channel — the closest real "outbound touch" proxy this
 *     codebase has, given there is no send-tracking table. Honestly
 *     labeled "drafted"/"approved", never "sent".
 *   - chatbot_conversations (272_create_chatbot_conversations.sql): when a
 *     conversation resolved to this lead (chatbot_conversations.lead_id),
 *     the visitor's own inbound engagement with the embedded chatbot.
 *   - site_events (503_create_site_events.sql), correlated via
 *     leads.session_id (505_add_visitor_session_to_leads.sql) — the same
 *     best-effort, nullable, looked-up-at-query-time correlation
 *     visitorLeadCorrelation.ts documents, never a hard FK.
 *
 * Every one of the queries below is scoped to tenant_id (+ project_id
 * where the table has one) — the same defense-in-depth posture as
 * activityTimeline.ts, on top of RLS.
 */

export type TouchpointDirection = "outbound" | "inbound";

export type TouchpointChannel =
  | "email"
  | "whatsapp"
  | "linkedin"
  | "phone"
  | "call_script"
  | "call"
  | "demo"
  | "chatbot"
  | "site"
  | "internal";

export interface Touchpoint {
  /** Stable, human-auditable event kind — never invented beyond what the source row actually represents. */
  type:
    | "assignment"
    | "stage_change"
    | "meeting"
    | "task"
    | "note"
    | "reply"
    | "audit_event"
    | "sequence_enrolled"
    | "sequence_stopped"
    | "message_drafted"
    | "message_approved"
    | "chatbot_conversation"
    | "site_visit";
  direction: TouchpointDirection;
  channel: TouchpointChannel;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
}

interface QueryableDb {
  query: PoolClient["query"];
}

function activityItemToTouchpoint(item: ActivityItem): Touchpoint {
  switch (item.type) {
    case "meeting":
      return {
        type: "meeting",
        direction: "outbound",
        channel: item.summary.startsWith("Demo") ? "demo" : "call",
        timestamp: item.timestamp,
        summary: item.summary,
        detail: item.detail,
        sourceId: item.sourceId,
      };
    case "reply":
      return {
        type: "reply",
        direction: "inbound",
        channel: inferReplyChannel(item.summary),
        timestamp: item.timestamp,
        summary: item.summary,
        detail: item.detail,
        sourceId: item.sourceId,
      };
    case "assignment":
    case "stage_change":
    case "task":
    case "note":
    case "audit_event":
      return {
        type: item.type,
        direction: "outbound",
        channel: "internal",
        timestamp: item.timestamp,
        summary: item.summary,
        detail: item.detail,
        sourceId: item.sourceId,
      };
    default:
      return {
        type: "audit_event",
        direction: "outbound",
        channel: "internal",
        timestamp: item.timestamp,
        summary: item.summary,
        detail: item.detail,
        sourceId: item.sourceId,
      };
  }
}

/** "Reply received via whatsapp — classified ..." -> "whatsapp". Reads the real channel
 * word activityTimeline.ts already put in the summary rather than re-querying lead_replies. */
function inferReplyChannel(summary: string): TouchpointChannel {
  const match = /via (\w+)/.exec(summary);
  const channel = match?.[1]?.toLowerCase();
  if (channel === "email" || channel === "whatsapp" || channel === "linkedin" || channel === "phone") {
    return channel;
  }
  return "internal";
}

function draftVariantChannel(channel: string): TouchpointChannel {
  if (channel === "email" || channel === "whatsapp" || channel === "linkedin") return channel;
  if (channel === "call_script") return "call_script";
  return "internal";
}

/**
 * Real site_events correlated to one lead via leads.session_id — the same
 * best-effort, nullable, looked-up-at-query-time join visitorLeadCorrelation.ts
 * documents. Exported so leadIntentScoring.ts's caller (the route layer)
 * can pass the SAME real rows into computeIntentScore()'s optional
 * `siteEvents` parameter without a second, divergent query — this is the
 * one query getTouchpointHistory() below also uses for its site_visit
 * touchpoints.
 */
export async function getCorrelatedSiteEvents(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<Array<{ id: string; event_name: string; occurred_at: string }>> {
  const result = await tenantDb.query<{ id: string; event_name: string; occurred_at: string }>(
    `SELECT se.id, se.event_name, se.occurred_at
     FROM site_events se
     JOIN leads l ON l.tenant_id = se.tenant_id AND l.project_id = se.project_id AND l.session_id = se.session_id
     WHERE se.tenant_id = $1 AND se.project_id = $2 AND l.id = $3 AND l.session_id IS NOT NULL`,
    [tenantId, projectId, leadId],
  );
  return result.rows;
}

/**
 * Returns the complete multi-touch engagement history for one lead, newest
 * first. A UNION of every real event source documented above — nothing
 * here is written or cached; every call recomputes from live tables, same
 * on-demand convention as dealHealth.ts / meetingPrep.ts.
 */
export async function getTouchpointHistory(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<Touchpoint[]> {
  const [activityItems, enrollments, drafts, chatbotConversations, siteEvents] = await Promise.all([
    getLeadActivityTimeline(tenantDb, tenantId, projectId, leadId),
    tenantDb.query<{
      id: string;
      sequence_name: string;
      status: string;
      enrolled_at: string;
      stopped_at: string | null;
    }>(
      `SELECT se.id, s.name AS sequence_name, se.status, se.enrolled_at, se.stopped_at
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.tenant_id = $1 AND s.project_id = $2 AND se.lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query<{
      id: string;
      status: string;
      created_at: string;
      updated_at: string;
      variant_channel: string | null;
    }>(
      `SELECT md.id, md.status, md.created_at, md.updated_at,
              (SELECT mdv.channel FROM message_draft_variants mdv
               WHERE mdv.message_draft_id = md.id ORDER BY mdv.created_at ASC LIMIT 1) AS variant_channel
       FROM message_drafts md
       WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query<{
      id: string;
      status: string;
      visitor_exchange_count: number;
      started_at: string;
      last_message_at: string;
    }>(
      `SELECT id, status, visitor_exchange_count, started_at, last_message_at
       FROM chatbot_conversations
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
    // Best-effort, nullable correlation via leads.session_id — reuses
    // getCorrelatedSiteEvents() above rather than a second copy of the
    // same join (leadIntentScoring.ts's route-layer caller uses the same
    // helper for its `siteEvents` parameter, so both see identical rows).
    getCorrelatedSiteEvents(tenantDb, tenantId, projectId, leadId),
  ]);

  const touchpoints: Touchpoint[] = activityItems.map(activityItemToTouchpoint);

  for (const row of enrollments.rows) {
    touchpoints.push({
      type: "sequence_enrolled",
      direction: "outbound",
      channel: "internal",
      timestamp: row.enrolled_at,
      summary: `Enrolled in sequence "${row.sequence_name}"`,
      detail: `Status: ${row.status}`,
      sourceId: row.id,
    });
    if (row.stopped_at) {
      touchpoints.push({
        type: "sequence_stopped",
        direction: "outbound",
        channel: "internal",
        timestamp: row.stopped_at,
        summary: `Sequence "${row.sequence_name}" stopped (${row.status})`,
        detail: null,
        sourceId: row.id,
      });
    }
  }

  for (const row of drafts.rows) {
    const channel = draftVariantChannel(row.variant_channel ?? "email");
    touchpoints.push({
      type: "message_drafted",
      direction: "outbound",
      channel,
      timestamp: row.created_at,
      summary: `Message draft created (${row.variant_channel ?? "channel unspecified"})`,
      detail: null,
      sourceId: row.id,
    });
    if (row.status === "approved") {
      touchpoints.push({
        type: "message_approved",
        direction: "outbound",
        channel,
        timestamp: row.updated_at,
        summary: `Message draft approved (${row.variant_channel ?? "channel unspecified"})`,
        detail: "Approved for sending — this codebase has no send-confirmation event to report beyond this.",
        sourceId: row.id,
      });
    }
  }

  for (const row of chatbotConversations.rows) {
    touchpoints.push({
      type: "chatbot_conversation",
      direction: "inbound",
      channel: "chatbot",
      timestamp: row.last_message_at,
      summary: `Chatbot conversation (${row.status}) — ${row.visitor_exchange_count} exchange(s)`,
      detail: `Started ${row.started_at}`,
      sourceId: row.id,
    });
  }

  for (const row of siteEvents) {
    touchpoints.push({
      type: "site_visit",
      direction: "inbound",
      channel: "site",
      timestamp: row.occurred_at,
      summary: `Site event: ${row.event_name}`,
      detail: null,
      sourceId: row.id,
    });
  }

  touchpoints.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return touchpoints;
}

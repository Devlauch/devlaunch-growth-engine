import type { PoolClient } from "pg";
import { getLeadActivityTimeline } from "./activityTimeline.js";

/**
 * Workstream F ("Unified customer profile"): a single READ-AGGREGATING view
 * over data that already exists in three separate places —
 *   1. The native CRM activity timeline (activityTimeline.ts's
 *      getLeadActivityTimeline — assignments/deals/meetings/tasks/notes/
 *      replies/audit events, unmodified, imported and reused as-is).
 *   2. Real website analytics (site_sessions/site_pageviews/site_events,
 *      packages/db/migrations 500-503), correlated to this lead via
 *      leads.visitor_id (505_add_visitor_session_to_leads.sql / see
 *      visitorLeadCorrelation.ts for how that column gets populated).
 *   3. Conversation history: the native embeddable chatbot
 *      (chatbot_conversations/chatbot_messages, 272/273 — these carry a
 *      direct lead_id FK) and Chatwoot (integration_webhook_events,
 *      286 — every inbound Chatwoot webhook delivery this platform
 *      received is already stored verbatim there; chatwoot_contact_leads,
 *      295, maps this lead back to the Chatwoot contact id that
 *      routes/chatwootWebhooks.ts's extractContact() resolved it from).
 *
 * This module does NOT create a new event-log table, does NOT duplicate any
 * of the three sources above, and does NOT call an LLM anywhere in it —
 * every exported function here is a deterministic merge/aggregate/rule over
 * rows a real feature already wrote for its own reason. Same honesty
 * convention as activityTimeline.ts/growthAdvisor.ts/nextBestAction.ts:
 * every signal traces back to a real row, and a channel with no data for
 * this lead (e.g. no visitor_id ever correlated, no Chatwoot integration
 * configured) is honestly absent from the result, never fabricated.
 *
 * Chatwoot caveat, stated plainly rather than glossed over: Chatwoot's own
 * conversation transcript storage is NOT duplicated here (that would be a
 * second source of truth for the same data). What this module reads is the
 * raw webhook deliveries this platform already stores for its own
 * AgentBot integration — real content (message text, event type, received
 * time), just not guaranteed to be the FULL transcript if, e.g., the
 * AgentBot was connected after a conversation started.
 */

export type TimelineChannel = "crm" | "site" | "conversation";

export interface TimelineEvent {
  channel: TimelineChannel;
  type: string;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
  /** Extra real, typed fields a specific detector/scorer needs (e.g. a
   * meeting's status, a reply's classification, a pageview's path) — never
   * fabricated, always sourced from the same real row `summary`/`detail`
   * were built from. */
  metadata: Record<string, unknown>;
}

interface QueryableDb {
  query: PoolClient["query"];
}

const MAX_SITE_ROWS_PER_QUERY = 200;
const MAX_CHATWOOT_EVENTS_PER_LEAD = 50;

/**
 * Returns the full merged timeline for one lead across all three channels,
 * newest first — the same newest-first convention
 * getLeadActivityTimeline() already established for the CRM channel alone;
 * this just extends that same convention across the other two channels
 * rather than inventing a different ordering.
 */
export async function getUnifiedTimeline(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<TimelineEvent[]> {
  const crmEvents = await buildCrmEvents(tenantDb, tenantId, projectId, leadId);
  const siteEvents = await buildSiteEvents(tenantDb, tenantId, projectId, leadId);
  const conversationEvents = await buildConversationEvents(tenantDb, tenantId, projectId, leadId);

  const merged = [...crmEvents, ...siteEvents, ...conversationEvents];
  merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return merged;
}

/**
 * Wraps activityTimeline.ts's existing ActivityItem[] as TimelineEvents, and
 * enriches a 'meeting'/'reply' item with the one real typed field
 * (meetings.status + meetings.scheduled_at, lead_replies.classification)
 * that activityTimeline.ts's own ActivityItem shape summarizes into a
 * string but doesn't expose structured — needed by detectIntentSignals
 * below. These two small queries read the SAME rows
 * getLeadActivityTimeline() already read for its meetings/replies arrays;
 * nothing new is stored, this is strictly an additional projection of
 * existing columns.
 */
async function buildCrmEvents(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<TimelineEvent[]> {
  const [activityItems, meetingMeta, replyMeta] = await Promise.all([
    getLeadActivityTimeline(tenantDb, tenantId, projectId, leadId),
    tenantDb.query<{ id: string; status: string; scheduled_at: string }>(
      `SELECT id, status, scheduled_at FROM meetings WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
    tenantDb.query<{ id: string; classification: string }>(
      `SELECT id, classification FROM lead_replies WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
      [tenantId, projectId, leadId],
    ),
  ]);

  const meetingMetaById = new Map(
    meetingMeta.rows.map((row) => [row.id, { status: row.status, scheduledAt: row.scheduled_at }]),
  );
  const replyClassificationById = new Map(replyMeta.rows.map((row) => [row.id, row.classification]));

  return activityItems.map((item) => {
    const metadata: Record<string, unknown> = {};
    if (item.type === "meeting" && meetingMetaById.has(item.sourceId)) {
      const meeting = meetingMetaById.get(item.sourceId)!;
      metadata.meetingStatus = meeting.status;
      metadata.scheduledAt = meeting.scheduledAt;
    }
    if (item.type === "reply" && replyClassificationById.has(item.sourceId)) {
      metadata.classification = replyClassificationById.get(item.sourceId);
    }
    return {
      channel: "crm",
      type: item.type,
      timestamp: item.timestamp,
      summary: item.summary,
      detail: item.detail,
      sourceId: item.sourceId,
      metadata,
    };
  });
}

/**
 * Website visitor/session/event history, correlated via leads.visitor_id
 * (populated by visitorLeadCorrelation.ts's recordLeadVisitorCorrelation,
 * best-effort/nullable by design — see that file's own doc comment). If
 * this lead was never correlated to a visitor (no visitor_id), this is
 * honestly an empty array, not a fabricated "no activity" placeholder.
 */
async function buildSiteEvents(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<TimelineEvent[]> {
  const leadRow = await tenantDb.query<{ visitor_id: string | null }>(
    `SELECT visitor_id FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  const visitorId = leadRow.rows[0]?.visitor_id ?? null;
  if (!visitorId) return [];

  const [sessions, pageviews, events] = await Promise.all([
    tenantDb.query<{ session_id: string; started_at: string; referrer: string | null; landing_url: string | null }>(
      `SELECT session_id, started_at, referrer, landing_url
       FROM site_sessions
       WHERE tenant_id = $1 AND project_id = $2 AND visitor_id = $3 AND is_bot = false
       ORDER BY started_at DESC LIMIT ${MAX_SITE_ROWS_PER_QUERY}`,
      [tenantId, projectId, visitorId],
    ),
    tenantDb.query<{ session_id: string; path: string; url: string; viewed_at: string }>(
      `SELECT p.session_id, p.path, p.url, p.viewed_at
       FROM site_pageviews p
       JOIN site_sessions s ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id AND s.session_id = p.session_id
       WHERE p.tenant_id = $1 AND p.project_id = $2 AND s.visitor_id = $3 AND s.is_bot = false
       ORDER BY p.viewed_at DESC LIMIT ${MAX_SITE_ROWS_PER_QUERY}`,
      [tenantId, projectId, visitorId],
    ),
    tenantDb.query<{ event_name: string; properties: Record<string, unknown> | null; occurred_at: string }>(
      `SELECT e.event_name, e.properties, e.occurred_at
       FROM site_events e
       JOIN site_sessions s ON s.tenant_id = e.tenant_id AND s.project_id = e.project_id AND s.session_id = e.session_id
       WHERE e.tenant_id = $1 AND e.project_id = $2 AND s.visitor_id = $3 AND s.is_bot = false
       ORDER BY e.occurred_at DESC LIMIT ${MAX_SITE_ROWS_PER_QUERY}`,
      [tenantId, projectId, visitorId],
    ),
  ]);

  const siteEvents: TimelineEvent[] = [];

  for (const row of sessions.rows) {
    siteEvents.push({
      channel: "site",
      type: "session_start",
      timestamp: row.started_at,
      summary: `Website session started${row.referrer ? ` via ${row.referrer}` : ""}`,
      detail: row.landing_url ? `Landing page: ${row.landing_url}` : null,
      sourceId: row.session_id,
      metadata: { sessionId: row.session_id },
    });
  }

  for (const row of pageviews.rows) {
    siteEvents.push({
      channel: "site",
      type: "pageview",
      timestamp: row.viewed_at,
      summary: `Visited ${row.path}`,
      detail: row.url,
      sourceId: `pageview:${row.session_id}:${row.viewed_at}`,
      metadata: { sessionId: row.session_id, path: row.path },
    });
  }

  for (const row of events.rows) {
    const properties = row.properties ?? {};
    siteEvents.push({
      channel: "site",
      type: "custom_event",
      timestamp: row.occurred_at,
      summary: `Triggered event "${row.event_name}"`,
      detail: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
      sourceId: `event:${row.event_name}:${row.occurred_at}`,
      metadata: { eventName: row.event_name },
    });
  }

  return siteEvents;
}

/**
 * Conversation summaries from the native chatbot (direct lead_id FK — a
 * precise join) and from Chatwoot (correlated via chatwoot_contact_leads,
 * see this file's header comment on why that's "real stored webhook
 * deliveries," not a duplicated transcript store).
 */
async function buildConversationEvents(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<TimelineEvent[]> {
  const conversationEvents: TimelineEvent[] = [];

  const chatbotConversations = await tenantDb.query<{
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
  );
  for (const row of chatbotConversations.rows) {
    conversationEvents.push({
      channel: "conversation",
      type: "chatbot_conversation",
      timestamp: row.last_message_at,
      summary: `Chatbot conversation (${row.status}) — ${row.visitor_exchange_count} exchange(s)`,
      detail: `Started ${row.started_at}`,
      sourceId: row.id,
      metadata: { status: row.status, startedAt: row.started_at },
    });
  }

  const chatwootMapping = await tenantDb.query<{ chatwoot_contact_id: string }>(
    `SELECT chatwoot_contact_id FROM chatwoot_contact_leads WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
    [tenantId, projectId, leadId],
  );
  if (chatwootMapping.rowCount && chatwootMapping.rowCount > 0) {
    const contactId = chatwootMapping.rows[0].chatwoot_contact_id;
    // COALESCE across the same three payload shapes routes/chatwootWebhooks.ts's
    // extractContact() checks, in the same order, so this matches the exact
    // contact id that route resolved — not a guessed/looser match.
    const chatwootMessages = await tenantDb.query<{
      id: string;
      event_type: string;
      payload: { message_type?: string; content?: string } | null;
      received_at: string;
    }>(
      `SELECT id, event_type, payload, received_at
       FROM integration_webhook_events
       WHERE tenant_id = $1 AND provider = 'chatwoot'
         AND COALESCE(payload->'contact'->>'id', payload->'meta'->'sender'->>'id', payload->'sender'->>'id') = $2
       ORDER BY received_at DESC LIMIT ${MAX_CHATWOOT_EVENTS_PER_LEAD}`,
      [tenantId, contactId],
    );
    for (const row of chatwootMessages.rows) {
      const payload = row.payload ?? {};
      conversationEvents.push({
        channel: "conversation",
        type: `chatwoot_${row.event_type}`,
        timestamp: row.received_at,
        summary: `Chatwoot ${row.event_type.replace(/_/g, " ")}${payload.message_type ? ` (${payload.message_type})` : ""}`,
        detail: payload.content ?? null,
        sourceId: row.id,
        metadata: { eventType: row.event_type },
      });
    }
  }

  return conversationEvents;
}

// ---------------------------------------------------------------------------
// computeEngagementScore
// ---------------------------------------------------------------------------

export interface EngagementScoreResult {
  score: number;
  signals: string[];
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Recency decay: an event this many days old contributes half the weight
 * of a fresh one, decaying exponentially (0.5 ^ (ageDays / halfLifeDays)). */
const ENGAGEMENT_RECENCY_HALF_LIFE_DAYS = 14;
/** Each fully-fresh (age ~0) event contributes this many raw points before
 * the recency decay and the activity-component cap are applied. */
const ENGAGEMENT_POINTS_PER_FRESH_EVENT = 8;
/** The recency-weighted activity sum alone can never push the score above
 * this many points — the remaining headroom up to 100 is reserved for the
 * channel-diversity component below, so breadth across channels always
 * matters, not just raw event volume on one channel. */
const ENGAGEMENT_ACTIVITY_COMPONENT_CAP = 70;
/** Each distinct channel (crm/site/conversation) the lead has at least one
 * event on contributes this many points. */
const ENGAGEMENT_POINTS_PER_DISTINCT_CHANNEL = 10;
const ENGAGEMENT_MAX_SCORE = 100;

function recencyWeight(timestamp: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(timestamp).getTime()) / MILLISECONDS_PER_DAY);
  return Math.pow(0.5, ageDays / ENGAGEMENT_RECENCY_HALF_LIFE_DAYS);
}

/**
 * Deterministic engagement score (0-100), no LLM involved:
 *
 *   activityComponent  = min(ENGAGEMENT_ACTIVITY_COMPONENT_CAP,
 *                             sum(recencyWeight(event) for event in timeline) * ENGAGEMENT_POINTS_PER_FRESH_EVENT)
 *   diversityComponent = distinctChannelCount * ENGAGEMENT_POINTS_PER_DISTINCT_CHANNEL
 *   score              = round(min(ENGAGEMENT_MAX_SCORE, activityComponent + diversityComponent))
 *
 * recencyWeight halves every ENGAGEMENT_RECENCY_HALF_LIFE_DAYS days of age,
 * so ten events from a year ago score far lower than two events from
 * yesterday — "recency-weighted event count across distinct channels," not
 * a flat count. `signals` lists the real counts/sums that produced the
 * score, so the number is always auditable back to real timeline rows.
 */
export function computeEngagementScore(timeline: TimelineEvent[], now: Date = new Date()): EngagementScoreResult {
  const channelsPresent = new Set<TimelineChannel>();
  const eventCountByChannel = new Map<TimelineChannel, number>();
  let weightedActivitySum = 0;

  for (const event of timeline) {
    weightedActivitySum += recencyWeight(event.timestamp, now);
    channelsPresent.add(event.channel);
    eventCountByChannel.set(event.channel, (eventCountByChannel.get(event.channel) ?? 0) + 1);
  }

  const activityComponent = Math.min(
    ENGAGEMENT_ACTIVITY_COMPONENT_CAP,
    weightedActivitySum * ENGAGEMENT_POINTS_PER_FRESH_EVENT,
  );
  const diversityComponent = channelsPresent.size * ENGAGEMENT_POINTS_PER_DISTINCT_CHANNEL;
  const score = Math.round(Math.min(ENGAGEMENT_MAX_SCORE, activityComponent + diversityComponent));

  const signals: string[] = [];
  for (const [channel, count] of eventCountByChannel) {
    signals.push(`${count} ${channel} event(s) in the timeline`);
  }
  signals.push(
    `Engaged across ${channelsPresent.size} distinct channel(s)` +
      (channelsPresent.size > 0 ? `: ${[...channelsPresent].join(", ")}` : ""),
  );
  signals.push(
    `Recency-weighted activity sum: ${weightedActivitySum.toFixed(2)} (half-life ${ENGAGEMENT_RECENCY_HALF_LIFE_DAYS} days)`,
  );

  return { score, signals };
}

// ---------------------------------------------------------------------------
// detectIntentSignals
// ---------------------------------------------------------------------------

const PRICING_PATH_KEYWORDS = ["pricing", "/plans", "/buy"];
const PRICING_VISIT_THRESHOLD = 3;
const PRICING_VISIT_WINDOW_DAYS = 7;
const RETURNING_VISITOR_SESSION_THRESHOLD = 3;
const RETURNING_VISITOR_WINDOW_DAYS = 7;
// lead_replies.classification's real CHECK-constraint values
// (058_create_lead_replies.sql): 'interested' is the only positive one.
const POSITIVE_REPLY_CLASSIFICATION = "interested";
// chatbot_conversations.status's real CHECK-constraint values
// (272_create_chatbot_conversations.sql) that mean "still ongoing."
const OPEN_CHATBOT_STATUSES = new Set(["active", "awaiting_consent", "qualifying", "awaiting_contact"]);

function isWithinWindow(timestamp: string, now: Date, windowDays: number): boolean {
  const ageDays = (now.getTime() - new Date(timestamp).getTime()) / MILLISECONDS_PER_DAY;
  return ageDays >= 0 && ageDays <= windowDays;
}

/**
 * Simple, deterministic rules over real timeline data — no fabrication, no
 * LLM. Assumes `timeline` is sorted newest-first (as getUnifiedTimeline
 * returns it), since "most recent reply"/"next scheduled meeting" below
 * rely on that ordering to pick the right event via Array#find.
 */
export function detectIntentSignals(timeline: TimelineEvent[], now: Date = new Date()): string[] {
  const signals: string[] = [];

  const recentPricingVisits = timeline.filter((event) => {
    if (event.channel !== "site" || event.type !== "pageview") return false;
    const path = event.metadata.path;
    if (typeof path !== "string") return false;
    const lowerPath = path.toLowerCase();
    return PRICING_PATH_KEYWORDS.some((keyword) => lowerPath.includes(keyword)) && isWithinWindow(event.timestamp, now, PRICING_VISIT_WINDOW_DAYS);
  });
  if (recentPricingVisits.length >= PRICING_VISIT_THRESHOLD) {
    signals.push(
      `Visited a pricing-related page ${recentPricingVisits.length} time(s) in the last ${PRICING_VISIT_WINDOW_DAYS} days`,
    );
  }

  const recentSessionIds = new Set(
    timeline
      .filter(
        (event) => event.channel === "site" && event.type === "session_start" && isWithinWindow(event.timestamp, now, RETURNING_VISITOR_WINDOW_DAYS),
      )
      .map((event) => event.sourceId),
  );
  if (recentSessionIds.size >= RETURNING_VISITOR_SESSION_THRESHOLD) {
    signals.push(`Returning visitor: ${recentSessionIds.size} distinct sessions in the last ${RETURNING_VISITOR_WINDOW_DAYS} days`);
  }

  const mostRecentReply = timeline.find((event) => event.channel === "crm" && event.type === "reply");
  if (mostRecentReply && mostRecentReply.metadata.classification === POSITIVE_REPLY_CLASSIFICATION) {
    signals.push(`Most recent reply was classified "${POSITIVE_REPLY_CLASSIFICATION}"`);
  }

  const upcomingMeeting = timeline.find(
    (event) =>
      event.channel === "crm" &&
      event.type === "meeting" &&
      event.metadata.meetingStatus === "scheduled" &&
      typeof event.metadata.scheduledAt === "string" &&
      new Date(event.metadata.scheduledAt as string).getTime() > now.getTime(),
  );
  if (upcomingMeeting) {
    signals.push(`Has an upcoming meeting scheduled for ${upcomingMeeting.metadata.scheduledAt as string}`);
  }

  const openConversation = timeline.find(
    (event) =>
      event.channel === "conversation" &&
      event.type === "chatbot_conversation" &&
      typeof event.metadata.status === "string" &&
      OPEN_CHATBOT_STATUSES.has(event.metadata.status as string),
  );
  if (openConversation) {
    signals.push(`Has an in-progress chatbot conversation (status: ${openConversation.metadata.status as string})`);
  }

  return signals;
}

// ---------------------------------------------------------------------------
// getLifecycleStage
// ---------------------------------------------------------------------------

export type LifecycleStage = "visitor" | "lead" | "mql" | "sql" | "opportunity" | "customer";

/** The exact subset of leads.status (015_create_leads.sql's CHECK
 * constraint) this mapping depends on. */
export interface LifecycleLeadInput {
  status: string;
}

/** The exact subset of deals.stage (278_create_deals.sql's CHECK
 * constraint / salesPipeline.ts's DealStage) this mapping depends on. */
export interface LifecycleDealInput {
  stage: string;
}

/**
 * Deterministic mapping onto visitor/lead/mql/sql/opportunity/customer,
 * reusing the two enums that already exist (leads.status, deals.stage) —
 * no parallel lifecycle-stage column or table is introduced.
 */
export function getLifecycleStage(lead: LifecycleLeadInput | null, deals: LifecycleDealInput[]): LifecycleStage {
  // No leads row at all for this visitor yet — tracked only via
  // site_visitors/site_sessions, never submitted a lead form.
  if (!lead) return "visitor";

  // Mirrors 278_create_deals.sql's own `customers` VIEW definition exactly:
  // a lead becomes a customer the instant one of its deals reaches 'won'.
  if (deals.some((deal) => deal.stage === "won")) return "customer";

  // A deals row exists at all — salesPipeline.ts/the Sales Conversion Agent
  // only ever creates one once a lead has actually entered the real sales
  // pipeline, regardless of which non-terminal stage it currently sits in.
  if (deals.length > 0) return "opportunity";

  // No deal yet; fall back to the lead's own status.
  if (lead.status === "approved_for_outreach") return "sql"; // a human explicitly cleared this lead for sales outreach
  if (lead.status === "qualified") return "mql"; // passed marketing qualification, not yet cleared for outreach
  return "lead"; // "new", "rejected", or "archived" — captured, not yet mql/sql
}

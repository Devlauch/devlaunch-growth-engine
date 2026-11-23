import type { PoolClient } from "pg";
import { getLeadActivityTimeline } from "./activityTimeline.js";

/**
 * Workstream C1: chronological, cross-session reconstruction of a single
 * visitor's behavior — site_sessions + site_pageviews + site_events, all
 * scoped to one (tenant, project, visitor_id) — plus, when that visitor
 * correlates to a CRM lead (leads.visitor_id, see
 * packages/db/migrations/505_add_visitor_session_to_leads.sql and
 * apps/api/src/lib/visitorLeadCorrelation.ts), that lead's own CRM activity
 * timeline merged in. Read-only: this reuses
 * apps/api/src/lib/activityTimeline.ts's getLeadActivityTimeline() rather
 * than re-implementing lead-activity SQL (same "don't duplicate a read
 * query that already exists" precedent funnelDropoff.ts's own header
 * documents for the opposite case, where no library existed to import).
 */

export type JourneyStepType = "session_start" | "pageview" | "event" | "crm_activity";

export interface JourneyStep {
  type: JourneyStepType;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
}

interface QueryableDb {
  query: PoolClient["query"];
}

/**
 * Returns one visitor's full cross-session journey, oldest first. A visitor
 * with no site_sessions rows at all (never actually tracked) returns an
 * empty array rather than a fabricated placeholder entry.
 */
export async function getVisitorJourney(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  visitorId: string,
): Promise<JourneyStep[]> {
  const [sessions, pageviews, events, leads] = await Promise.all([
    tenantDb.query(
      `SELECT session_id, started_at, referrer, landing_url, utm_source, utm_medium, utm_campaign, is_bot
       FROM site_sessions
       WHERE tenant_id = $1 AND project_id = $2 AND visitor_id = $3
       ORDER BY started_at ASC`,
      [tenantId, projectId, visitorId],
    ),
    tenantDb.query(
      `SELECT p.path, p.url, p.viewed_at, p.session_id
       FROM site_pageviews p
       JOIN site_sessions s ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id AND s.session_id = p.session_id
       WHERE p.tenant_id = $1 AND p.project_id = $2 AND s.visitor_id = $3
       ORDER BY p.viewed_at ASC`,
      [tenantId, projectId, visitorId],
    ),
    tenantDb.query(
      `SELECT e.event_name, e.properties, e.occurred_at, e.session_id
       FROM site_events e
       JOIN site_sessions s ON s.tenant_id = e.tenant_id AND s.project_id = e.project_id AND s.session_id = e.session_id
       WHERE e.tenant_id = $1 AND e.project_id = $2 AND s.visitor_id = $3
       ORDER BY e.occurred_at ASC`,
      [tenantId, projectId, visitorId],
    ),
    tenantDb.query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND project_id = $2 AND visitor_id = $3`,
      [tenantId, projectId, visitorId],
    ),
  ]);

  const steps: JourneyStep[] = [];

  for (const row of sessions.rows as Array<{
    session_id: string;
    started_at: string;
    referrer: string | null;
    landing_url: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    is_bot: boolean;
  }>) {
    const utmParts = [row.utm_source, row.utm_medium, row.utm_campaign].filter(Boolean);
    steps.push({
      type: "session_start",
      timestamp: row.started_at,
      summary: row.is_bot ? "Session started (flagged as bot traffic)" : "Session started",
      detail:
        [row.referrer ? `Referrer: ${row.referrer}` : null, row.landing_url ? `Landing: ${row.landing_url}` : null, utmParts.length > 0 ? `UTM: ${utmParts.join(" / ")}` : null]
          .filter(Boolean)
          .join(" | ") || null,
      sourceId: row.session_id,
    });
  }

  for (const row of pageviews.rows as Array<{ path: string; url: string; viewed_at: string; session_id: string }>) {
    steps.push({
      type: "pageview",
      timestamp: row.viewed_at,
      summary: `Viewed ${row.path}`,
      detail: row.url !== row.path ? row.url : null,
      sourceId: row.session_id,
    });
  }

  for (const row of events.rows as Array<{
    event_name: string;
    properties: Record<string, unknown> | null;
    occurred_at: string;
    session_id: string;
  }>) {
    const properties = row.properties ?? {};
    steps.push({
      type: "event",
      timestamp: row.occurred_at,
      summary: `Event: ${row.event_name}`,
      detail: Object.keys(properties).length > 0 ? JSON.stringify(properties) : null,
      sourceId: row.session_id,
    });
  }

  // If this visitor correlates to one or more CRM leads, merge in each
  // lead's own activity timeline (assignments, deals, meetings, tasks,
  // notes, replies, audit events) — reusing the existing function rather
  // than duplicating its SQL.
  for (const leadRow of leads.rows as Array<{ id: string }>) {
    const leadActivity = await getLeadActivityTimeline(tenantDb, tenantId, projectId, leadRow.id);
    for (const item of leadActivity) {
      steps.push({
        type: "crm_activity",
        timestamp: item.timestamp,
        summary: `[CRM] ${item.summary}`,
        detail: item.detail,
        sourceId: item.sourceId,
      });
    }
  }

  steps.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return steps;
}

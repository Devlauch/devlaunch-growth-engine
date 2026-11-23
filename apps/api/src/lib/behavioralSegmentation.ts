import type { PoolClient } from "pg";

/**
 * Workstream C1: simple behavioral segmentation over existing
 * site_visitors/site_sessions/site_events — "visitors who fired event X at
 * least N times AND visited page Y AND came from utm_source Z". Inspired by
 * (not copied from) PostHog's cohort/persons-filter model (dynamic
 * behavioral cohorts defined by a rule list), reimplemented here as a small,
 * fixed set of rule types matched with plain SQL against our own tables —
 * no new rule-definition table, no saved/persisted segments (that would be
 * a real additive feature; this module computes a segment result on demand
 * from the rules the caller passes in, nothing more).
 */

export type SegmentRule =
  | { type: "event_count_at_least"; eventName: string; minCount: number }
  | { type: "page_visited"; path: string }
  | { type: "utm_source"; value: string };

export interface SegmentResult {
  totalVisitors: number;
  matchedVisitors: number;
  /** matchedVisitors / totalVisitors, or 0 when there are no visitors at all (never fabricated). */
  matchRate: number;
  /** A bounded sample of matching visitor ids, for drill-down — never the full set unbounded. */
  sampleVisitorIds: string[];
}

const SAMPLE_LIMIT = 100;

async function visitorsMatchingRule(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  rule: SegmentRule,
): Promise<Set<string>> {
  if (rule.type === "event_count_at_least") {
    const result = await tenantDb.query<{ visitor_id: string }>(
      `SELECT s.visitor_id
       FROM site_sessions s
       JOIN site_events e ON e.tenant_id = s.tenant_id AND e.project_id = s.project_id AND e.session_id = s.session_id
       WHERE s.tenant_id = $1 AND s.project_id = $2 AND e.event_name = $3
       GROUP BY s.visitor_id
       HAVING count(*) >= $4`,
      [tenantId, projectId, rule.eventName, rule.minCount],
    );
    return new Set(result.rows.map((r) => r.visitor_id));
  }

  if (rule.type === "page_visited") {
    const result = await tenantDb.query<{ visitor_id: string }>(
      `SELECT DISTINCT s.visitor_id
       FROM site_sessions s
       JOIN site_pageviews p ON p.tenant_id = s.tenant_id AND p.project_id = s.project_id AND p.session_id = s.session_id
       WHERE s.tenant_id = $1 AND s.project_id = $2 AND p.path = $3`,
      [tenantId, projectId, rule.path],
    );
    return new Set(result.rows.map((r) => r.visitor_id));
  }

  // rule.type === "utm_source"
  const result = await tenantDb.query<{ visitor_id: string }>(
    `SELECT DISTINCT visitor_id
     FROM site_sessions
     WHERE tenant_id = $1 AND project_id = $2 AND utm_source = $3`,
    [tenantId, projectId, rule.value],
  );
  return new Set(result.rows.map((r) => r.visitor_id));
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  let acc = sets[0];
  for (let i = 1; i < sets.length; i++) {
    const next = new Set<string>();
    for (const id of acc) {
      if (sets[i].has(id)) next.add(id);
    }
    acc = next;
  }
  return acc;
}

/**
 * Evaluates `rules` (AND-combined) against one tenant+project's visitors,
 * using real SQL per rule type then intersecting the resulting visitor-id
 * sets in-process (simpler and safer than one giant dynamically-combined
 * query, and each rule's query is still itself real SQL against
 * site_visitors/site_sessions/site_events). An empty rules array matches
 * every visitor in the project (no filtering applied).
 */
export async function segmentVisitors(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  rules: SegmentRule[],
): Promise<SegmentResult> {
  const totalResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM site_visitors WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const totalVisitors = totalResult.rows[0]?.count ?? 0;

  let matchedSet: Set<string>;
  if (rules.length === 0) {
    const allResult = await tenantDb.query<{ visitor_id: string }>(
      `SELECT visitor_id FROM site_visitors WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    );
    matchedSet = new Set(allResult.rows.map((r) => r.visitor_id));
  } else {
    const ruleSets = await Promise.all(rules.map((rule) => visitorsMatchingRule(tenantDb, tenantId, projectId, rule)));
    matchedSet = intersect(ruleSets);
  }

  const matchedVisitors = matchedSet.size;
  return {
    totalVisitors,
    matchedVisitors,
    matchRate: totalVisitors > 0 ? matchedVisitors / totalVisitors : 0,
    sampleVisitorIds: Array.from(matchedSet).slice(0, SAMPLE_LIMIT),
  };
}

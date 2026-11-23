import type { PoolClient } from "pg";

/**
 * prospectToMeetingAnalytics.ts: Workstream G2 — real, aggregated
 * prospect -> reply -> meeting conversion funnel stats for a project over
 * a date range. Same "every number is a real query, or an honest null,
 * never a guess" convention as growthRevenueAnalytics.ts /
 * pipelineForecast.ts. No new table — pure aggregation over
 * sequence_enrollments, message_drafts, lead_replies, and meetings, all of
 * which already exist.
 *
 * Definitions (documented explicitly so the numbers are never ambiguous):
 *   - prospectsContacted: distinct leads in this project with at least one
 *     real outbound touch in range — enrolled in a sequence
 *     (sequence_enrollments.enrolled_at) OR had a message drafted
 *     (message_drafts.created_at). This is the same honest "closest real
 *     outbound-touch proxy" multiTouchEngagement.ts documents (no
 *     send-tracking table exists in this codebase).
 *   - repliesReceived: count of lead_replies rows received in range
 *     (raw event count, i.e. a lead who replied twice counts twice here).
 *   - leadsWhoReplied: distinct leads who replied in range — used for the
 *     funnel ratios below instead of the raw count, since a ratio needs
 *     one row per lead on both sides.
 *   - meetingsBooked: count of meetings CREATED (meetings.created_at) in
 *     range, i.e. "booked during this window", regardless of when the
 *     meeting is scheduled FOR.
 *   - leadsWithMeetingBooked: distinct leads with at least one meeting
 *     created in range.
 *   - meetingsCompleted: count of meetings with status = 'completed' whose
 *     scheduled_at falls in range.
 */

export interface ConversionFunnelDateRange {
  from: string;
  to: string;
}

export interface ConversionFunnelStats {
  dateRange: ConversionFunnelDateRange;
  prospectsContacted: number;
  repliesReceived: number;
  leadsWhoReplied: number;
  meetingsBooked: number;
  leadsWithMeetingBooked: number;
  meetingsCompleted: number;
  conversionRates: {
    /** leadsWhoReplied / prospectsContacted, or null if prospectsContacted is 0 (never a fabricated 0% or divide-by-zero). */
    contactToReply: number | null;
    /** leadsWithMeetingBooked / leadsWhoReplied, or null if leadsWhoReplied is 0. */
    replyToMeeting: number | null;
    /** leadsWithMeetingBooked / prospectsContacted, or null if prospectsContacted is 0. */
    contactToMeeting: number | null;
    /** meetingsCompleted / meetingsBooked, or null if meetingsBooked is 0. */
    meetingToCompleted: number | null;
  };
}

interface QueryableDb {
  query: PoolClient["query"];
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export async function computeConversionFunnelStats(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  dateRange: ConversionFunnelDateRange,
): Promise<ConversionFunnelStats> {
  const [contactedResult, repliesResult, leadsRepliedResult, meetingsBookedResult, leadsWithMeetingResult, meetingsCompletedResult] =
    await Promise.all([
      tenantDb.query<{ count: string }>(
        `SELECT count(DISTINCT lead_id)::int AS count FROM (
           SELECT se.lead_id FROM sequence_enrollments se
           JOIN sequences s ON s.id = se.sequence_id
           WHERE se.tenant_id = $1 AND s.project_id = $2 AND se.enrolled_at BETWEEN $3 AND $4
           UNION
           SELECT md.lead_id FROM message_drafts md
           WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.created_at BETWEEN $3 AND $4
         ) contacted`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
      tenantDb.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM lead_replies
         WHERE tenant_id = $1 AND project_id = $2 AND received_at BETWEEN $3 AND $4`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
      tenantDb.query<{ count: string }>(
        `SELECT count(DISTINCT lead_id)::int AS count FROM lead_replies
         WHERE tenant_id = $1 AND project_id = $2 AND received_at BETWEEN $3 AND $4`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
      tenantDb.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM meetings
         WHERE tenant_id = $1 AND project_id = $2 AND created_at BETWEEN $3 AND $4`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
      tenantDb.query<{ count: string }>(
        `SELECT count(DISTINCT lead_id)::int AS count FROM meetings
         WHERE tenant_id = $1 AND project_id = $2 AND created_at BETWEEN $3 AND $4`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
      tenantDb.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM meetings
         WHERE tenant_id = $1 AND project_id = $2 AND status = 'completed' AND scheduled_at BETWEEN $3 AND $4`,
        [tenantId, projectId, dateRange.from, dateRange.to],
      ),
    ]);

  const prospectsContacted = Number(contactedResult.rows[0]?.count ?? 0);
  const repliesReceived = Number(repliesResult.rows[0]?.count ?? 0);
  const leadsWhoReplied = Number(leadsRepliedResult.rows[0]?.count ?? 0);
  const meetingsBooked = Number(meetingsBookedResult.rows[0]?.count ?? 0);
  const leadsWithMeetingBooked = Number(leadsWithMeetingResult.rows[0]?.count ?? 0);
  const meetingsCompleted = Number(meetingsCompletedResult.rows[0]?.count ?? 0);

  return {
    dateRange,
    prospectsContacted,
    repliesReceived,
    leadsWhoReplied,
    meetingsBooked,
    leadsWithMeetingBooked,
    meetingsCompleted,
    conversionRates: {
      contactToReply: ratio(leadsWhoReplied, prospectsContacted),
      replyToMeeting: ratio(leadsWithMeetingBooked, leadsWhoReplied),
      contactToMeeting: ratio(leadsWithMeetingBooked, prospectsContacted),
      meetingToCompleted: ratio(meetingsCompleted, meetingsBooked),
    },
  };
}

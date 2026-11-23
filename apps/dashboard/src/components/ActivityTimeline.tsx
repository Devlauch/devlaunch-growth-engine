import { ErrorBanner } from "./ErrorBanner";
import { EmptyState } from "./EmptyState";
import { IconInbox } from "./Icons";
import { useLeadActivity, type ActivityItem, type ActivityItemType } from "../hooks/useLeadActivity";

// Unified, chronological activity timeline for a lead (CRM module
// "Activity timeline"). Self-contained: fetches its own data via
// useLeadActivity, which calls the real
// GET .../leads/:leadId/activity endpoint
// (apps/api/src/routes/leadActivity.ts -> apps/api/src/lib/
// activityTimeline.ts). Nothing here is fabricated client-side — every
// item rendered came straight from that one real query.
//
// Intended drop-in spot: a lead-detail page (not built as part of this
// change — see handback notes). Usage:
//   <ActivityTimeline tenantId={tenantId} projectId={projectId} leadId={leadId} />

const TYPE_LABELS: Record<ActivityItemType, string> = {
  assignment: "Assignment",
  stage_change: "Stage change",
  meeting: "Meeting",
  task: "Task",
  note: "Note",
  // "reply" existed on ActivityItemType before this pass but was missing
  // here — a pre-existing gap, fixed in passing since every other label is
  // being touched anyway for the Phase 2 reconciliation additions below.
  reply: "Reply",
  // Ported from Phase 2 (Agent C2) — see apps/api/src/lib/
  // activityTimeline.ts's header comment for exactly which columns back
  // each of these.
  lead_created: "Lead created",
  discovery_sourced: "Discovery",
  lead_scored: "Scored",
  deal_created: "Deal created",
  crm_task_created: "Task created",
};

// Reuses the existing tone-based badge classes (badge-neutral/info/
// success/warn/danger, see styles.css) instead of inventing a second,
// parallel per-type color scheme — the badge className below was
// previously `badge-${item.type}`, for which no CSS rule has ever existed
// on this tree (so every item rendered an uncolored, unstyled badge).
const TYPE_TONE: Record<ActivityItemType, "neutral" | "info" | "success" | "warn" | "danger"> = {
  assignment: "info",
  stage_change: "warn",
  meeting: "neutral",
  task: "neutral",
  note: "neutral",
  reply: "info",
  lead_created: "neutral",
  discovery_sourced: "info",
  lead_scored: "success",
  deal_created: "warn",
  crm_task_created: "neutral",
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function ActivityTimeline({
  tenantId,
  projectId,
  leadId,
}: {
  tenantId: string | undefined;
  projectId: string | undefined;
  leadId: string | undefined;
}) {
  const { activity, error, loading } = useLeadActivity(tenantId, projectId, leadId);

  return (
    <section className="panel">
      <h2>Activity</h2>
      <p className="muted">
        Every assignment, stage change, meeting, task, note and reply for this lead, newest first — plus (where
        applicable) its creation, discovery provenance, score and deal/task creation events. Deal stage changes show
        only the most recent transition — there is no stage-history table, so earlier transitions aren't retained.
      </p>
      <ErrorBanner message={error} />

      {loading && activity === null ? (
        <p className="muted">Loading...</p>
      ) : activity === null || activity.length === 0 ? (
        <EmptyState icon={<IconInbox width={22} height={22} />} title="No activity yet" hint="Nothing has happened on this lead yet." />
      ) : (
        <ul className="activity-timeline">
          {activity.map((item: ActivityItem) => (
            <li key={`${item.type}-${item.sourceId}`} className={`activity-item activity-item-${item.type}`}>
              <div className="activity-item-header">
                <span className={`badge badge-${TYPE_TONE[item.type]}`}>{TYPE_LABELS[item.type]}</span>
                <time dateTime={item.timestamp}>{formatTimestamp(item.timestamp)}</time>
              </div>
              <p className="activity-item-summary">{item.summary}</p>
              {item.detail ? <p className="muted activity-item-detail">{item.detail}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

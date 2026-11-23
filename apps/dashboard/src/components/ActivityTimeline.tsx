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
        Every assignment, stage change, meeting, task and note for this lead, newest first. Deal stage changes show
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
                <span className={`badge badge-${item.type}`}>{TYPE_LABELS[item.type]}</span>
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

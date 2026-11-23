import { ErrorBanner } from "./ErrorBanner";
import { EmptyState } from "./EmptyState";
import { Badge } from "./Badge";
import { IconInbox } from "./Icons";
import {
  useUnifiedCustomerProfile,
  type LifecycleStage,
  type TimelineChannel,
  type UnifiedTimelineEvent,
} from "../hooks/useUnifiedCustomerProfile";

// Workstream F ("Unified customer profile"): a self-contained panel showing
// the merged CRM + website-analytics + conversation timeline, engagement
// score, intent signals, and lifecycle stage for one lead. Fetches its own
// data via useUnifiedCustomerProfile, which calls the real
// GET .../leads/:leadId/unified-profile endpoint
// (apps/api/src/routes/customerIntelligence.ts -> apps/api/src/lib/
// unifiedCustomerProfile.ts). Nothing here is fabricated client-side —
// every number/signal rendered came straight from that one real
// read-aggregating query.
//
// Built as a separate sibling component (not inlined into LeadDetailPage.tsx)
// because that page is a hot/concurrently-edited file this round — see this
// feature's handback for the exact 2-line integration point to drop this
// into LeadDetailPage.tsx once it's free to edit again.
//
// Usage:
//   <UnifiedCustomerProfilePanel tenantId={tenantId} projectId={projectId} leadId={leadId} />

const LIFECYCLE_STAGE_LABELS: Record<LifecycleStage, string> = {
  visitor: "Visitor",
  lead: "Lead",
  mql: "Marketing qualified (MQL)",
  sql: "Sales qualified (SQL)",
  opportunity: "Opportunity",
  customer: "Customer",
};

function lifecycleStageTone(stage: LifecycleStage): "neutral" | "info" | "success" | "warn" | "danger" {
  switch (stage) {
    case "customer":
      return "success";
    case "opportunity":
      return "warn";
    case "sql":
      return "info";
    case "mql":
      return "info";
    default:
      return "neutral";
  }
}

function engagementScoreTone(score: number): "neutral" | "info" | "success" | "warn" | "danger" {
  if (score >= 60) return "success";
  if (score >= 20) return "warn";
  return "neutral";
}

const CHANNEL_LABELS: Record<TimelineChannel, string> = {
  crm: "CRM",
  site: "Website",
  conversation: "Conversation",
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function TimelineEventRow({ event }: { event: UnifiedTimelineEvent }) {
  return (
    <li className={`activity-item activity-item-${event.channel}`}>
      <div className="activity-item-header">
        <Badge tone="neutral">{CHANNEL_LABELS[event.channel]}</Badge>
        <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
      </div>
      <p className="activity-item-summary">{event.summary}</p>
      {event.detail ? <p className="muted activity-item-detail">{event.detail}</p> : null}
    </li>
  );
}

export function UnifiedCustomerProfilePanel({
  tenantId,
  projectId,
  leadId,
}: {
  tenantId: string | undefined;
  projectId: string | undefined;
  leadId: string | undefined;
}) {
  const { profile, error, loading } = useUnifiedCustomerProfile(tenantId, projectId, leadId);

  return (
    <section className="panel">
      <h2>Unified customer profile</h2>
      <p className="muted">
        A merged view of this lead's CRM activity, website visits, and chatbot/Chatwoot conversations, plus a
        computed engagement score, detected intent signals, lifecycle stage, and next-best-action.
      </p>
      <ErrorBanner message={error} />

      {loading && profile === null ? (
        <p className="muted">Loading...</p>
      ) : profile === null ? null : (
        <>
          <div className="stat-top-row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
            <Badge tone={lifecycleStageTone(profile.lifecycleStage)}>{LIFECYCLE_STAGE_LABELS[profile.lifecycleStage]}</Badge>
            <Badge tone={engagementScoreTone(profile.engagementScore)}>Engagement score: {profile.engagementScore}</Badge>
          </div>

          <div className="panel-subsection">
            <h3>Next best action</h3>
            <p className="activity-item-summary">{profile.nextBestAction.action}</p>
            <p className="muted">{profile.nextBestAction.reason}</p>
          </div>

          <div className="panel-subsection">
            <h3>Intent signals</h3>
            {profile.intentSignals.length === 0 ? (
              <p className="muted">No intent signals detected yet.</p>
            ) : (
              <ul>
                {profile.intentSignals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel-subsection">
            <h3>Engagement score breakdown</h3>
            <ul>
              {profile.engagementSignals.map((signal) => (
                <li key={signal} className="muted">
                  {signal}
                </li>
              ))}
            </ul>
          </div>

          <div className="panel-subsection">
            <h3>Merged timeline</h3>
            {profile.timeline.length === 0 ? (
              <EmptyState
                icon={<IconInbox width={22} height={22} />}
                title="No timeline events yet"
                hint="No CRM activity, website visits, or conversations have been recorded for this lead yet."
              />
            ) : (
              <ul className="activity-timeline">
                {profile.timeline.map((event) => (
                  <TimelineEventRow key={`${event.channel}-${event.type}-${event.sourceId}`} event={event} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

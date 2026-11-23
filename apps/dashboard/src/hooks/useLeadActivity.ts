import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

// Data hook backing <ActivityTimeline /> (apps/dashboard/src/components/
// ActivityTimeline.tsx). Calls the real
// GET .../leads/:leadId/activity endpoint (apps/api/src/routes/
// leadActivity.ts -> apps/api/src/lib/activityTimeline.ts) — this file was
// referenced by ActivityTimeline.tsx but did not exist on disk yet in this
// tree's snapshot; added here as part of the Phase 2 activity-timeline
// reconciliation (Agent C2) so the component it already backs actually
// compiles and runs. The type union below must stay in sync with
// apps/api/src/lib/activityTimeline.ts's ActivityItemType.

export type ActivityItemType =
  | "assignment"
  | "stage_change"
  | "meeting"
  | "task"
  | "note"
  | "reply"
  | "lead_created"
  | "discovery_sourced"
  | "lead_scored"
  | "deal_created"
  | "crm_task_created";

export interface ActivityItem {
  type: ActivityItemType;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
}

export function useLeadActivity(tenantId: string | undefined, projectId: string | undefined, leadId: string | undefined) {
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !projectId || !leadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ activity: ActivityItem[] }>(
        `/tenants/${tenantId}/projects/${projectId}/leads/${leadId}/activity`,
      );
      setActivity(res.activity);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load activity for this lead.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, projectId, leadId]);

  useEffect(() => {
    load();
  }, [load]);

  return { activity, error, loading, reload: load };
}

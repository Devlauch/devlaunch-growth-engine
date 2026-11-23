import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

// Shape mirrors apps/api/src/lib/activityTimeline.ts's ActivityItem —
// kept as a plain local type rather than a shared import since the
// dashboard and api packages don't share types across the build boundary
// (same pattern as the Deal/Meeting interfaces hand-declared in
// SalesPipelinePage.tsx).
export type ActivityItemType = "assignment" | "stage_change" | "meeting" | "task" | "note";

export interface ActivityItem {
  type: ActivityItemType;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
}

/**
 * Loads the unified activity timeline for one lead from
 * GET .../leads/:leadId/activity (apps/api/src/routes/leadActivity.ts).
 * Self-contained: a lead-detail page can drop in <ActivityTimeline /> with
 * just a tenantId/projectId/leadId and this hook handles the fetch.
 */
export function useLeadActivity(tenantId: string | undefined, projectId: string | undefined, leadId: string | undefined) {
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!tenantId || !projectId || !leadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ activity: ActivityItem[] }>(
        `/tenants/${tenantId}/projects/${projectId}/leads/${leadId}/activity`,
      );
      setActivity(res.activity);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the activity timeline for this lead.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, projectId, leadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { activity, error, loading, reload };
}

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

// Shapes mirror apps/api/src/lib/unifiedCustomerProfile.ts's exported types
// — kept as plain local types rather than a shared import, same pattern as
// useLeadActivity.ts's ActivityItem (the dashboard and api packages don't
// share types across the build boundary).
export type TimelineChannel = "crm" | "site" | "conversation";

export interface UnifiedTimelineEvent {
  channel: TimelineChannel;
  type: string;
  timestamp: string;
  summary: string;
  detail: string | null;
  sourceId: string;
  metadata: Record<string, unknown>;
}

export type LifecycleStage = "visitor" | "lead" | "mql" | "sql" | "opportunity" | "customer";

export interface NextBestAction {
  action: string;
  reason: string;
}

export interface UnifiedCustomerProfile {
  timeline: UnifiedTimelineEvent[];
  engagementScore: number;
  engagementSignals: string[];
  intentSignals: string[];
  lifecycleStage: LifecycleStage;
  nextBestAction: NextBestAction;
}

/**
 * Loads the unified customer profile (merged CRM + site-analytics +
 * conversation timeline, engagement score, intent signals, lifecycle stage,
 * next-best-action) for one lead from
 * GET .../leads/:leadId/unified-profile (apps/api/src/routes/
 * customerIntelligence.ts -> apps/api/src/lib/unifiedCustomerProfile.ts).
 * Self-contained, same convention as useLeadActivity.ts.
 */
export function useUnifiedCustomerProfile(
  tenantId: string | undefined,
  projectId: string | undefined,
  leadId: string | undefined,
) {
  const [profile, setProfile] = useState<UnifiedCustomerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!tenantId || !projectId || !leadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<UnifiedCustomerProfile>(
        `/tenants/${tenantId}/projects/${projectId}/leads/${leadId}/unified-profile`,
      );
      setProfile(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the unified customer profile for this lead.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, projectId, leadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { profile, error, loading, reload };
}

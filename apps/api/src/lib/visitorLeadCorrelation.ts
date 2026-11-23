import type { PoolClient } from "pg";
import { z } from "zod";

/**
 * Milestone 2 (P1): visitor -> lead correlation.
 *
 * apps/api/src/lib/leadIngestion.ts (the single shared `ingestLead()` path)
 * is a concurrently-edited/hot file this round (confirmed via `git status`
 * before touching anything), so it is deliberately left untouched. Instead,
 * this is a small, additive, OPTIONAL post-insert step called from the
 * public route layer (routes/publicLeads.ts, routes/publicLandingPages.ts —
 * both safe to edit, neither is hot) in the SAME transaction as the
 * ingestLead() call that just created the lead: an UPDATE that fills in
 * `leads.visitor_id`/`leads.session_id` (505_add_visitor_session_to_leads.sql)
 * only when the submitting page sent them.
 *
 * This is the "graceful if-present" pattern the task calls for: the
 * tracking snippet (packages/embed-widget/analytics.js) exposes
 * `window.devlaunchAnalytics.getVisitorId()`/`getSessionId()`, and the
 * EXISTING lead-capture widget (packages/embed-widget/embed.js) picks them
 * up if that global happens to exist on the page — never required, never
 * breaking a form that doesn't carry the analytics snippet.
 *
 * If/when leadIngestion.ts is free to edit again, the one-line wiring this
 * replaces is documented in this feature's handback: call
 * `recordLeadVisitorCorrelation(client, tenantId, projectId, row.id,
 * input.visitorId, input.sessionId)` right after the `leads` INSERT
 * returns `row`, instead of doing it as a second UPDATE from the route
 * layer.
 */
export const visitorCorrelationSchema = z.object({
  visitorId: z.string().trim().min(8).max(100).optional(),
  sessionId: z.string().trim().min(8).max(100).optional(),
});
export type VisitorCorrelationInput = z.infer<typeof visitorCorrelationSchema>;

export async function recordLeadVisitorCorrelation(
  client: PoolClient,
  tenantId: string,
  leadId: string,
  visitorId: string | null | undefined,
  sessionId: string | null | undefined,
): Promise<void> {
  if (!visitorId && !sessionId) return;
  await client.query(
    `UPDATE leads SET visitor_id = COALESCE($1, visitor_id), session_id = COALESCE($2, session_id)
     WHERE id = $3 AND tenant_id = $4`,
    [visitorId ?? null, sessionId ?? null, leadId, tenantId],
  );
}

import type pg from "pg";
import { Errors } from "./httpError.js";
import type { PlanName } from "../config/planLimits.js";

/**
 * Single shared place that actually writes `tenants.plan` + its audit
 * trail. Extracted ADDITIVELY out of the exact inline logic that already
 * lived in routes/planUsage.ts's PATCH handler (the manual/admin-only
 * plan-change path, unchanged in behavior/shape — see that route, now
 * just calling this) so that routes/billingWebhooks.ts's real,
 * webhook-driven plan change (Milestone 4) reuses the EXACT SAME
 * plan-application code path instead of a second, drifting copy of the
 * same UPDATE/INSERT pair.
 *
 * Two actor shapes, matching the two real callers:
 *   - { type: "user", userId }: the existing manual/admin PATCH path.
 *     Produces the IDENTICAL SQL/params the inline version always did
 *     (actor_type literal 'user' in the query text, 3 positional params),
 *     so routes/planUsage.ts's existing tests keep passing unchanged.
 *   - { type: "system", note }: a real billing-provider webhook applying a
 *     plan change with no human actor — actor_type 'system',
 *     actor_user_id NULL (both valid per audit_events' own CHECK
 *     constraint, migration 012_create_audit_events.sql), with `note`
 *     (e.g. "razorpay_webhook"/"stripe_webhook") folded into the audit
 *     metadata so it's visible which provider/event drove the change.
 */
export async function applyPlanChange(
  client: Pick<pg.PoolClient, "query">,
  tenantId: string,
  newPlan: PlanName,
  actor: { type: "user"; userId: string } | { type: "system"; note: string },
): Promise<{ id: string; slug: string; name: string; plan: string }> {
  const result = await client.query(`UPDATE tenants SET plan = $2 WHERE id = $1 RETURNING id, slug, name, plan`, [
    tenantId,
    newPlan,
  ]);
  if (result.rowCount === 0) throw Errors.notFound("Tenant not found");

  if (actor.type === "user") {
    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'tenant.plan_changed', 'tenant', $1, $3::jsonb)`,
      [tenantId, actor.userId, JSON.stringify({ newPlan })],
    );
  } else {
    await client.query(
      `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, entity_id, metadata)
       VALUES ($1, 'system', 'tenant.plan_changed', 'tenant', $1, $2::jsonb)`,
      [tenantId, JSON.stringify({ newPlan, source: actor.note })],
    );
  }

  return result.rows[0];
}

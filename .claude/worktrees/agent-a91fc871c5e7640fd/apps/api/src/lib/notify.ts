import type { PoolClient } from "pg";

/**
 * Real in-app notifications only. There is no email-provider or WhatsApp
 * Business API credential configured anywhere in this environment, and
 * none is invented here — this module ONLY ever writes a row to the
 * `notifications` table (packages/db/migrations/250_create_notifications.sql)
 * that the dashboard's notification bell reads via
 * GET /api/v1/tenants/:tenantId/notifications. Nothing here sends an email
 * or a WhatsApp message.
 */

export type NotificationType =
  | "lead.captured"
  | "campaign.submitted_for_approval"
  | "approval.decided";

export interface NotifyParams {
  client: PoolClient;
  tenantId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  linkUrl?: string | null;
}

/**
 * Writes one notification row for one recipient. Callers must already be
 * inside the tenant-scoped transaction (req.tenantDb, with
 * app.current_tenant_id set by requireTenantMembership) — the notifications
 * table's INSERT RLS policy only checks tenant_id, so the recipient
 * (userId) can be any member of that tenant, not just the acting user (see
 * packages/db/migrations/251_enable_rls_notifications.sql for why).
 */
export async function notify(params: NotifyParams): Promise<void> {
  const { client, tenantId, userId, type, title, body, linkUrl } = params;
  await client.query(
    `INSERT INTO notifications (tenant_id, user_id, type, title, body, link_url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, userId, type, title, body, linkUrl ?? null],
  );
}

/**
 * Notifies every active owner/admin of a tenant (used e.g. for a newly
 * captured lead, or a campaign submitted for approval — anything that
 * needs attention from whoever can act on it, not a single fixed person).
 * Looks up real membership rows; never a fabricated recipient list.
 *
 * `excludeUserId` optionally skips notifying the actor who caused the
 * event (e.g. don't notify an admin of their own submission) — callers
 * pass it when that distinction matters; omitted, everyone qualifying is
 * notified.
 */
export async function notifyTenantOwnersAndAdmins(
  params: Omit<NotifyParams, "userId"> & { excludeUserId?: string | null },
): Promise<void> {
  const { client, tenantId, type, title, body, linkUrl, excludeUserId } = params;

  const result = await client.query<{ user_id: string }>(
    `SELECT user_id FROM memberships
     WHERE tenant_id = $1 AND status = 'active' AND role IN ('owner', 'admin')
       AND ($2::uuid IS NULL OR user_id != $2)`,
    [tenantId, excludeUserId ?? null],
  );

  for (const row of result.rows) {
    await notify({ client, tenantId, userId: row.user_id, type, title, body, linkUrl });
  }
}

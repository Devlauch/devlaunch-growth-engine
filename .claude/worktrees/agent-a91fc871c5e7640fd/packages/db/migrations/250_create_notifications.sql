-- Up Migration
--
-- notifications: real, in-app notification rows for a single user within a
-- single tenant (e.g. "a lead came in", "your campaign needs approval",
-- "your approval was decided"). This is in-app ONLY — there is no email or
-- WhatsApp provider wired up anywhere in this environment, and nothing here
-- sends either. See 252_add_notification_email_preference_to_users.sql for
-- the (currently inert) user preference flag.
--
-- user_id is intentionally NOT nullable: a notification always belongs to
-- exactly one recipient. Unlike every other tenant-owned table so far
-- (which RLS-scopes by tenant_id alone), this one must ALSO be scoped to
-- the specific recipient — see 251_enable_rls_notifications.sql, modeled on
-- the user-scoped-within-tenant policy added in
-- 018_extend_memberships_rls_self_lookup.sql.
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  link_url   text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- notifications is written once and then only ever gets read_at set — no
-- updated_at / generic update trigger needed.

CREATE INDEX idx_notifications_tenant_user ON notifications (tenant_id, user_id);
-- Primary list-view access pattern: a user's own notifications, unread
-- first, newest first (see GET /api/v1/tenants/:tenantId/notifications).
CREATE INDEX idx_notifications_tenant_user_unread_created
  ON notifications (tenant_id, user_id, (read_at IS NULL) DESC, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS notifications;

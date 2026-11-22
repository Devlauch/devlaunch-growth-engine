-- Up Migration
--
-- notifications RLS is narrower than the usual tenant-wide pattern
-- (compare packages/db/migrations/013_enable_rls_policies.sql), but it is
-- NOT simply "tenant_id AND user_id must both match" for every operation:
-- a notification is routinely written by the system/another actor FOR a
-- different user (e.g. a lead-capture notifies the tenant's owners/admins,
-- not the actor who triggered ingestion; an approval decision notifies the
-- original requester, not the reviewer who decided it). If INSERT required
-- user_id = app.current_user_id, none of those real notifications could
-- ever be written.
--
-- So INSERT is scoped by tenant only (any tenant member may be notified,
-- same as every other tenant-owned table) while SELECT/UPDATE are scoped
-- by BOTH tenant_id AND user_id — a user can only ever read or mark-as-read
-- their OWN notification rows, never another member's, even within a
-- tenant they share. This mirrors the user-scoped-within-tenant pattern
-- added in 018_extend_memberships_rls_self_lookup.sql, just split across
-- commands by what each operation legitimately needs.
--
-- This depends on app.current_user_id being set for every tenant-scoped
-- request. apps/api/src/middleware/tenant.ts (requireTenantMembership) now
-- sets both app.current_tenant_id and app.current_user_id together, in the
-- same set_config call, for the authenticated caller of that request. That
-- session variable was previously only ever set by the separate
-- withUserContext() path; it is now also set on the main tenant-scoped
-- request path, specifically so this policy has something real to compare
-- against for SELECT/UPDATE. It can only ever be the server's own
-- req.userId — never a client-supplied value — so this can only narrow
-- access, never widen it.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_insert ON notifications
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY notifications_select ON notifications
  FOR SELECT
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

CREATE POLICY notifications_update ON notifications
  FOR UPDATE
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

-- Down Migration

DROP POLICY IF EXISTS notifications_update ON notifications;
DROP POLICY IF EXISTS notifications_select ON notifications;
DROP POLICY IF EXISTS notifications_insert ON notifications;
ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;

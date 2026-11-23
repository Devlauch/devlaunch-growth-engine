-- Up Migration
--
-- campaign_attribution: a real rollup view linking campaign_id -> enrolled
-- leads -> their outcomes, computed ENTIRELY from existing tables
-- (campaigns, campaign_members, sequence_enrollments, lead_replies) — no
-- new fact table, no duplicated data, no fabricated ad-spend/impression
-- numbers (this is organic/outbound attribution only; real paid-channel
-- metrics require the Google Ads/Meta Ads integrations, which are honest
-- NotConfigured stubs in this environment — see
-- apps/api/src/lib/channelProviders.ts).
--
-- A plain (non-materialized) VIEW, not a table, so it is always fresh and
-- never needs a refresh job. It deliberately carries NO explicit RLS of
-- its own (Postgres does not support ALTER TABLE ... ENABLE ROW LEVEL
-- SECURITY on a view) — tenant isolation instead comes for free from the
-- underlying tables' own FORCE ROW LEVEL SECURITY policies
-- (022_enable_rls_campaigns.sql, 059_enable_rls_lead_replies.sql,
-- 051_enable_rls_sequences.sql), which still apply to every row this view
-- reads as long as the querying session has app.current_tenant_id set
-- (exactly as every other tenantDb query in this codebase already
-- requires). See 277_enable_rls_channel_execution.sql for a worked-out note
-- on why this is safe.
--
-- A lead is attributed to a campaign via campaign_members (021_create_
-- campaign_members.sql) — there is no direct campaign_id column on
-- sequences/sequence_enrollments in this schema, so outcomes are joined to
-- a campaign through the shared lead_id, which is the real, existing
-- relationship (not an invented one).
CREATE VIEW campaign_attribution AS
SELECT
  c.tenant_id,
  c.project_id,
  c.id                                                                       AS campaign_id,
  c.name                                                                     AS campaign_name,
  c.status                                                                   AS campaign_status,
  c.channel                                                                  AS campaign_channel,
  COUNT(DISTINCT cm.lead_id)                                                 AS member_count,
  COUNT(DISTINCT cm.lead_id) FILTER (WHERE cm.status = 'active')             AS active_member_count,
  COUNT(DISTINCT se.id)                                                      AS sequence_enrollment_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'active')                 AS sequence_active_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'completed')               AS sequence_completed_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped_meeting_booked')  AS conversion_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped_unsubscribed')    AS unsubscribed_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped_bounced')         AS bounced_count,
  COUNT(DISTINCT se.id) FILTER (WHERE se.status = 'stopped_replied')         AS stopped_for_reply_count,
  COUNT(DISTINCT lr.id)                                                      AS reply_count,
  COUNT(DISTINCT lr.id) FILTER (WHERE lr.classification = 'interested')      AS interested_reply_count,
  COUNT(DISTINCT lr.id) FILTER (WHERE lr.classification = 'unsubscribe')     AS unsubscribe_reply_count,
  COUNT(DISTINCT lr.id) FILTER (WHERE lr.classification = 'not_now')         AS not_now_reply_count,
  COUNT(DISTINCT lr.id) FILTER (WHERE lr.classification = 'wrong_person')    AS wrong_person_reply_count
FROM campaigns c
LEFT JOIN campaign_members cm
  ON cm.tenant_id = c.tenant_id AND cm.campaign_id = c.id
LEFT JOIN sequence_enrollments se
  ON se.tenant_id = cm.tenant_id AND se.lead_id = cm.lead_id
LEFT JOIN lead_replies lr
  ON lr.tenant_id = cm.tenant_id AND lr.lead_id = cm.lead_id
GROUP BY c.tenant_id, c.project_id, c.id, c.name, c.status, c.channel;

-- Down Migration

DROP VIEW IF EXISTS campaign_attribution;

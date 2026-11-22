-- Up Migration
--
-- email_notifications_opt_in: a user PREFERENCE flag only.
--
-- IMPORTANT: this column is NOT wired to any real email sender. There is no
-- email-provider (or WhatsApp Business API) credential configured anywhere
-- in this environment, and none is invented here. Nothing in apps/api or
-- apps/worker reads this column to actually send an email today — it only
-- records what the user asked for, so that a real sender can honor it once
-- one is ever wired up. Today, every real notification this platform sends
-- is the in-app notifications row written to the `notifications` table
-- (see 250_create_notifications.sql).
ALTER TABLE users
  ADD COLUMN email_notifications_opt_in boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE users
  DROP COLUMN IF EXISTS email_notifications_opt_in;

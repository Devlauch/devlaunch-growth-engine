-- Up Migration
--
-- notes.company_id / notes.contact_id FKs, split out from
-- 312_create_notes.sql on purpose: `companies`/`contacts` (302-308) are
-- created earlier in this same migration range, but this ALTER is kept
-- last and separate so the notes table/RLS/API (312-313) never hard-depend
-- on companies/contacts existing and can run/be tested independently.
-- If this migration ever runs before 302-308 exist, it fails in isolation
-- (not taking the rest of the notes feature down with it) and can be
-- retried after the companies/contacts migrations have landed.
--
-- Both FKs are ON DELETE CASCADE, consistent with notes.lead_id/deal_id
-- above (312_create_notes.sql) — deleting a company/contact should not
-- leave orphaned notes pointing at nothing.
ALTER TABLE notes
  ADD CONSTRAINT notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE;

ALTER TABLE notes
  ADD CONSTRAINT notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE;

-- Down Migration

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_contact_id_fkey;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_company_id_fkey;

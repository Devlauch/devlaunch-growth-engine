-- Up Migration
--
-- lead_assignments: real assignment of a lead to a tenant member (a sales
-- rep). This is a history table, not a single mutable "assigned to" column
-- on leads — every assignment (including reassignment) inserts a new row,
-- so "who is this lead currently assigned to" is always "the latest row for
-- this lead_id" (see apps/api/src/lib/salesPipeline.ts's
-- getCurrentAssignment), and the full reassignment history stays auditable.
--
-- assigned_user_id must be a real, currently-active member of the tenant —
-- validated at the API layer against `memberships` (see apps/api/src/
-- routes/memberships.ts for that shape), the exact same "is this a real
-- user we can act on behalf of" check every other assignable-to-a-user
-- column in this schema uses (crm_tasks.assigned_user_id, deals.owner_user_id
-- above). No separate CHECK is possible for "is an active member of this
-- tenant" in plain SQL without a cross-table trigger, so this is
-- intentionally an API-layer invariant, consistent with how deals.stage
-- transitions are validated above.
CREATE TABLE lead_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  assigned_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  assigned_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_assignments_tenant_id ON lead_assignments (tenant_id);
CREATE INDEX idx_lead_assignments_project_id ON lead_assignments (project_id);
-- Primary access pattern: "who is this lead currently assigned to" — the
-- most recent row for a given lead_id.
CREATE INDEX idx_lead_assignments_lead_assigned_at ON lead_assignments (lead_id, assigned_at DESC);
CREATE INDEX idx_lead_assignments_assigned_user_id ON lead_assignments (assigned_user_id);

-- Down Migration

DROP TABLE IF EXISTS lead_assignments;

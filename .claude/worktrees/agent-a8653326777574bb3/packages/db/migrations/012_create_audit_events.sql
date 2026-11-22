-- Up Migration

-- audit_events is an append-only log of notable actions across the
-- platform (who/what agent did what, to which entity, when). Tenant-owned.
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_agent_instance_id uuid REFERENCES agent_instances (id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- audit_events is append-only (no updated_at / update trigger by design).

CREATE INDEX idx_audit_events_tenant_id ON audit_events (tenant_id);
CREATE INDEX idx_audit_events_tenant_created_at ON audit_events (tenant_id, created_at);
CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);

-- Down Migration

DROP TABLE IF EXISTS audit_events;

-- Up Migration
--
-- postiz_social_posts: the real, tenant-scoped record of a social post this
-- platform asked Postiz to schedule/publish, plus its honestly-synced real
-- status/engagement. This is the subject a real `approvals` row gates
-- before Postiz's publish endpoint is ever called (see approval_id below
-- and 319_add_social_post_id_to_approvals.sql) — same bidirectional
-- approval-linkage pattern as message_drafts.approval_id /
-- approvals.message_draft_id (052_create_message_drafts.sql,
-- 056_add_message_draft_id_to_approvals.sql), not a new mechanism.
--
-- No column here is ever written with a fabricated value: `status` only
-- ever reaches 'scheduled'/'published' after a real 2xx response from
-- Postiz's POST /public/v1/posts, `postiz_post_id`/`postiz_post_group` are
-- copied verbatim from that response, and `engagement` is the raw,
-- unmodified passthrough of GET /public/v1/analytics/post/:id (or null
-- until a sync call actually returns data) — see
-- apps/api/src/lib/postizClient.ts and apps/api/src/routes/postizIntegration.ts.
CREATE TABLE postiz_social_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  integration_id     uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  -- Set once a human requests approval (see postizIntegration.ts); nullable
  -- until then. ON DELETE SET NULL (not CASCADE) so deleting an approval
  -- record never silently deletes the post it was gating.
  approval_id       uuid REFERENCES approvals (id) ON DELETE SET NULL,
  content           text NOT NULL,
  -- Postiz integration ids (its own per-connected-account identifiers,
  -- from GET /public/v1/integrations) this post targets.
  platforms         text[] NOT NULL DEFAULT '{}',
  scheduled_at      timestamptz,
  status            text NOT NULL DEFAULT 'draft' CHECK (
                       status IN ('draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'published', 'failed')
                     ),
  -- Postiz's own post id / group id, only ever populated from a real API
  -- response (never guessed) — see postizClient.ts's createPost().
  postiz_post_id    text,
  postiz_post_group text,
  published_at      timestamptz,
  last_synced_at    timestamptz,
  last_error        text,
  -- Raw, unmodified passthrough of Postiz's analytics response. Null until
  -- a real sync call returns data; never fabricated.
  engagement        jsonb,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_postiz_social_posts_set_updated_at
  BEFORE UPDATE ON postiz_social_posts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_postiz_social_posts_tenant_id ON postiz_social_posts (tenant_id);
CREATE INDEX idx_postiz_social_posts_project_id ON postiz_social_posts (project_id);
CREATE INDEX idx_postiz_social_posts_tenant_status ON postiz_social_posts (tenant_id, status);
CREATE INDEX idx_postiz_social_posts_approval_id ON postiz_social_posts (approval_id);

-- Down Migration

DROP TABLE IF EXISTS postiz_social_posts;

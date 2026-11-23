import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import { encryptCredential } from "../lib/credentialEncryption.js";
import {
  createPostizClient,
  getPostizClientForTenant,
  PostizApiError,
  PostizUnreachableError,
} from "../lib/postizClient.js";
import { getSocialPostProvider, NotConfiguredError } from "../lib/channelProviders.js";

/**
 * Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/integrations/postiz
 *
 * Milestone 2, Agent D: the real, working upgrade of the honest Postiz
 * stub (apps/api/src/lib/channelProviders.ts's NotConfiguredPostizProvider,
 * now joined by a real PostizSocialPostProvider — see that file). Reuses
 * the existing `integrations` registry table (024_create_integrations.sql
 * / 315_add_config_to_integrations.sql) rather than a parallel one, and
 * adds `postiz_organization_links` / `postiz_social_posts` (migrations
 * 317-320) for the facts that table can't itself represent: a hard 1:1
 * tenant<->Postiz Organization binding, and the real
 * scheduled/approved/published social-post lifecycle.
 *
 * Every write here is behind requireAuth + requireTenantMembership (same
 * chain as every other tenant-scoped router) — this is distinct from
 * integrations.ts's generic GET/:provider/connect placeholder route, which
 * is intentionally left untouched (it still only records a placeholder
 * label for providers with no real integration yet). This router is what
 * actually talks to Postiz.
 */
export const postizIntegrationRouter = Router({ mergeParams: true });
postizIntegrationRouter.use(requireAuth, requireTenantMembership);

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid(),
});

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

function describePostizError(err: unknown): string {
  if (err instanceof PostizApiError) return `Postiz API error (${err.status}): ${err.message}`;
  if (err instanceof PostizUnreachableError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 1. Connect: tenant pastes the API key of a Postiz Organization they
//    already created in their own Postiz instance (Postiz's org/API-key
//    creation itself happens entirely on Postiz's side — this platform
//    never fabricates or provisions a Postiz Organization). We confirm the
//    key is real via GET /public/v1/me BEFORE ever storing it, so a
//    connected row always reflects a verified identity, never a guess.
// ---------------------------------------------------------------------------

const connectSchema = z.object({
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1).max(500),
});

postizIntegrationRouter.post("/connect", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const body = connectSchema.parse(req.body);

    // Enforce "one Postiz Organization per platform tenant" (audit
    // recommendation) BEFORE calling out to Postiz: if this tenant is
    // already bound to an organization, require an explicit disconnect
    // first rather than silently rebinding to a second one.
    const existingLink = await req.tenantDb!.query<{ postiz_organization_id: string }>(
      `SELECT postiz_organization_id FROM postiz_organization_links WHERE tenant_id = $1`,
      [tenantId],
    );
    if ((existingLink.rowCount ?? 0) > 0) {
      throw Errors.conflict(
        `This tenant is already bound to Postiz Organization ${existingLink.rows[0].postiz_organization_id}. ` +
          `POST .../integrations/postiz/disconnect first to rebind.`,
      );
    }

    const client = createPostizClient({ baseUrl: body.baseUrl, apiKey: body.apiKey });
    let identity;
    try {
      identity = await client.getIdentity();
    } catch (err) {
      throw Errors.badGateway(`Could not verify this Postiz API key: ${describePostizError(err)}`);
    }

    const encrypted = encryptCredential(body.apiKey);

    const integrationResult = await req.tenantDb!.query<{ id: string }>(
      `INSERT INTO integrations (tenant_id, project_id, provider, status, encrypted_credential_ref, config, created_by)
       VALUES ($1, $2, 'postiz', 'connected', $3, $4::jsonb, $5)
       ON CONFLICT (project_id, provider)
       DO UPDATE SET status = 'connected', encrypted_credential_ref = $3, config = $4::jsonb, updated_at = now()
       RETURNING id`,
      [tenantId, projectId, encrypted, JSON.stringify({ baseUrl: body.baseUrl }), req.userId],
    );
    const integrationId = integrationResult.rows[0].id;

    await req.tenantDb!.query(
      `INSERT INTO postiz_organization_links (tenant_id, integration_id, postiz_organization_id, postiz_organization_name, connected_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE
         SET integration_id = $2, postiz_organization_id = $3, postiz_organization_name = $4, connected_by = $5, updated_at = now()`,
      [tenantId, integrationId, identity.organization.id, identity.organization.name, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'integration.connected', 'integration', $3, $4::jsonb)`,
      [tenantId, req.userId, integrationId, JSON.stringify({ provider: "postiz", organizationId: identity.organization.id })],
    );

    res.status(201).json({
      integration: { id: integrationId, provider: "postiz", status: "connected" },
      organization: identity.organization,
    });
  } catch (err) {
    next(err);
  }
});

postizIntegrationRouter.post("/disconnect", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);

    await req.tenantDb!.query(`DELETE FROM postiz_organization_links WHERE tenant_id = $1`, [tenantId]);
    const updated = await req.tenantDb!.query(
      `UPDATE integrations SET status = 'not_connected', encrypted_credential_ref = NULL, config = '{}'::jsonb
       WHERE tenant_id = $1 AND project_id = $2 AND provider = 'postiz'
       RETURNING id`,
      [tenantId, projectId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'integration.disconnected', 'integration', $3, $4::jsonb)`,
      [tenantId, req.userId, updated.rows[0]?.id ?? null, JSON.stringify({ provider: "postiz" })],
    );

    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2. Status / health / connected social accounts
// ---------------------------------------------------------------------------

postizIntegrationRouter.get("/", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);

    const integration = await req.tenantDb!.query(
      `SELECT i.id, i.status, i.config, i.updated_at, l.postiz_organization_id, l.postiz_organization_name
       FROM integrations i
       LEFT JOIN postiz_organization_links l ON l.integration_id = i.id
       WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.provider = 'postiz'`,
      [tenantId, projectId],
    );

    if (integration.rowCount === 0) {
      res.json({ provider: "postiz", status: "not_connected", organization: null });
      return;
    }

    const row = integration.rows[0];
    res.json({
      provider: "postiz",
      status: row.status,
      baseUrl: row.config?.baseUrl ?? null,
      organization: row.postiz_organization_id
        ? { id: row.postiz_organization_id, name: row.postiz_organization_name }
        : null,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET .../integrations/postiz/health
 *
 * A real lightweight call (GET /public/v1/me), never just "is the row
 * connected" — and updates integrations.status to 'error' on failure so a
 * stale 'connected' status is never left behind when Postiz is actually
 * unreachable or the stored key has been revoked.
 */
postizIntegrationRouter.get("/health", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);

    const resolution = await getPostizClientForTenant(req.tenantDb!, tenantId, projectId);
    if ("status" in resolution) {
      res.json({ status: "not_configured", detail: resolution.detail });
      return;
    }

    const health = await resolution.checkHealth();
    await req.tenantDb!.query(
      `UPDATE integrations SET status = $3
       WHERE tenant_id = $1 AND project_id = $2 AND provider = 'postiz' AND status <> 'not_connected'`,
      [tenantId, projectId, health.status === "ok" ? "connected" : "error"],
    );

    res.json(health);
  } catch (err) {
    next(err);
  }
});

/** GET .../integrations/postiz/social-accounts — the org's real connected social accounts (never fabricated). */
postizIntegrationRouter.get("/social-accounts", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);

    const resolution = await getPostizClientForTenant(req.tenantDb!, tenantId, projectId);
    if ("status" in resolution) {
      res.json({ status: "not_configured", accounts: [] });
      return;
    }

    try {
      const accounts = await resolution.listIntegrations();
      res.json({ status: "ok", accounts });
    } catch (err) {
      res.status(502).json({ status: "error", accounts: [], detail: describePostizError(err) });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST .../integrations/postiz/connect-social
 *
 * Kicks off Postiz's OWN OAuth connect flow for one more social network —
 * Postiz handles the entire per-network OAuth dance (it owns 37 provider
 * integrations already; this platform re-implements none of them). Returns
 * the URL to redirect the tenant's browser to.
 */
const connectSocialSchema = z.object({
  integration: z.string().trim().min(1).max(100),
  redirectUrl: z.string().trim().url().optional(),
});

postizIntegrationRouter.post("/connect-social", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const body = connectSocialSchema.parse(req.body);

    const resolution = await getPostizClientForTenant(req.tenantDb!, tenantId, projectId);
    if ("status" in resolution) {
      throw Errors.conflict("Connect Postiz first (POST .../integrations/postiz/connect) before connecting a social account.");
    }

    try {
      const link = await resolution.createConnectLink(body.integration, body.redirectUrl);
      res.json(link);
    } catch (err) {
      throw Errors.badGateway(describePostizError(err));
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Social posts: draft -> request approval -> (human decides via the
//    EXISTING approvals.ts route) -> publish, only once approved. A post
//    is NEVER published without a real `approvals` row in 'approved'
//    status — the same discipline advanceSequences.ts uses for the
//    email-send approval gate (message_drafts.status = 'approved').
// ---------------------------------------------------------------------------

const createPostSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  platforms: z.array(z.string().trim().min(1)).min(1),
  scheduledAt: z.string().datetime().optional(),
});

postizIntegrationRouter.post("/posts", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const body = createPostSchema.parse(req.body);

    const integration = await req.tenantDb!.query<{ id: string }>(
      `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'postiz' AND status = 'connected'`,
      [tenantId, projectId],
    );
    if (integration.rowCount === 0) {
      throw Errors.conflict("Postiz is not connected for this project — connect it first.");
    }

    const inserted = await req.tenantDb!.query(
      `INSERT INTO postiz_social_posts (tenant_id, project_id, integration_id, content, platforms, scheduled_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
       RETURNING id, status, content, platforms, scheduled_at, created_at`,
      [tenantId, projectId, integration.rows[0].id, body.content, body.platforms, body.scheduledAt ?? null, req.userId],
    );

    res.status(201).json({ post: inserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

postizIntegrationRouter.get("/posts", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);

    const result = await req.tenantDb!.query(
      `SELECT id, approval_id, content, platforms, scheduled_at, status, postiz_post_id, published_at, last_synced_at, last_error, engagement, created_at
       FROM postiz_social_posts
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [tenantId, projectId],
    );
    res.json({ posts: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST .../posts/:postId/request-approval
 *
 * Inserts a REAL row into the existing `approvals` table (status
 * 'pending') and links it via postiz_social_posts.approval_id /
 * approvals.social_post_id (319_add_social_post_id_to_approvals.sql) —
 * same bidirectional linkage as message_drafts.approval_id. A human then
 * decides it through the UNTOUCHED, existing POST
 * .../approvals/:approvalId/decision route (routes/approvals.ts) — this
 * file never flips an approval to 'approved' itself.
 */
postizIntegrationRouter.post("/posts/:postId/request-approval", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const postId = z.string().uuid().parse(req.params.postId);

    const post = await req.tenantDb!.query<{ id: string; status: string }>(
      `SELECT id, status FROM postiz_social_posts WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [postId, tenantId, projectId],
    );
    if (post.rowCount === 0) throw Errors.notFound("Social post not found");
    if (post.rows[0].status !== "draft") {
      throw Errors.conflict(`Only a 'draft' post can be submitted for approval (current status: ${post.rows[0].status})`);
    }

    const approval = await req.tenantDb!.query<{ id: string }>(
      `INSERT INTO approvals (tenant_id, social_post_id, requested_by, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [tenantId, postId, req.userId, `Postiz social post ${postId} submitted for approval`],
    );

    await req.tenantDb!.query(
      `UPDATE postiz_social_posts SET status = 'pending_approval', approval_id = $3 WHERE id = $1 AND tenant_id = $2`,
      [postId, tenantId, approval.rows[0].id],
    );

    res.status(201).json({ approvalId: approval.rows[0].id, status: "pending_approval" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST .../posts/:postId/publish
 *
 * THE non-negotiable gate: refuses to call Postiz's real publish/schedule
 * endpoint unless a REAL `approvals` row linked to this post has
 * status = 'approved'. Mirrors advanceSequences.ts's email-send gate
 * exactly (`AND md.status = 'approved'`).
 */
postizIntegrationRouter.post("/posts/:postId/publish", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const postId = z.string().uuid().parse(req.params.postId);

    const result = await req.tenantDb!.query<{
      id: string;
      status: string;
      content: string;
      platforms: string[];
      scheduled_at: string | null;
      approval_status: string | null;
    }>(
      `SELECT sp.id, sp.status, sp.content, sp.platforms, sp.scheduled_at, a.status AS approval_status
       FROM postiz_social_posts sp
       LEFT JOIN approvals a ON a.id = sp.approval_id AND a.tenant_id = sp.tenant_id
       WHERE sp.id = $1 AND sp.tenant_id = $2 AND sp.project_id = $3`,
      [postId, tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Social post not found");
    const post = result.rows[0];

    if (post.status === "published") {
      res.json({ post: { id: post.id, status: "published" }, alreadyPublished: true });
      return;
    }

    // THE GATE: no approval row, or not 'approved' -> refuse, exactly like
    // advanceSequences.ts's "no_matching_draft_variant"/non-'approved'
    // skip. Never bypassed, never auto-approved here.
    if (post.approval_status !== "approved") {
      throw Errors.forbidden(
        `This post has not passed a real human approval (current approval status: ${post.approval_status ?? "none requested"}). ` +
          `Request approval via POST .../posts/${postId}/request-approval, then have it approved via ` +
          `POST .../approvals/:approvalId/decision, before publishing.`,
      );
    }

    await req.tenantDb!.query(`UPDATE postiz_social_posts SET status = 'approved' WHERE id = $1 AND tenant_id = $2`, [
      postId,
      tenantId,
    ]);

    const provider = await getSocialPostProvider(req.tenantDb!, tenantId, projectId);
    try {
      const published = await provider.publish({
        content: post.content,
        platforms: post.platforms,
        scheduledAt: post.scheduled_at,
      });

      const updated = await req.tenantDb!.query(
        `UPDATE postiz_social_posts
         SET status = $3, postiz_post_id = $4, published_at = $5, last_error = NULL, last_synced_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, status, postiz_post_id, published_at`,
        [postId, tenantId, post.scheduled_at ? "scheduled" : "published", published.postId, published.publishedAt],
      );

      await req.tenantDb!.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'user', $2, 'postiz_post.published', 'postiz_social_post', $3, $4::jsonb)`,
        [tenantId, req.userId, postId, JSON.stringify({ postizPostId: published.postId })],
      );

      res.json({ post: updated.rows[0] });
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        res.status(409).json({
          error: "postiz_not_configured",
          message: err.message,
        });
        return;
      }
      const message = describePostizError(err);
      await req.tenantDb!.query(
        `UPDATE postiz_social_posts SET status = 'failed', last_error = $3, last_synced_at = now() WHERE id = $1 AND tenant_id = $2`,
        [postId, tenantId, message],
      );
      throw Errors.badGateway(`Postiz publish failed: ${message}`);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST .../posts/:postId/sync
 *
 * Real status + (if the provider supports it) engagement-metrics sync,
 * via polling (GET /public/v1/analytics/post/:id) — see
 * apps/api/src/routes/postizWebhooks.ts's doc comment for why polling,
 * not webhooks, is the authoritative mechanism for this integration.
 * Never fabricates a published status or a metric: a failed/unreachable
 * call here reports the real error and leaves the row's last-known state
 * untouched, it never advances status optimistically.
 */
postizIntegrationRouter.post("/posts/:postId/sync", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const postId = z.string().uuid().parse(req.params.postId);

    const post = await req.tenantDb!.query<{ id: string; postiz_post_id: string | null; status: string }>(
      `SELECT id, postiz_post_id, status FROM postiz_social_posts WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [postId, tenantId, projectId],
    );
    if (post.rowCount === 0) throw Errors.notFound("Social post not found");
    if (!post.rows[0].postiz_post_id) {
      res.json({ post: post.rows[0], note: "Not yet published to Postiz — nothing to sync." });
      return;
    }

    const resolution = await getPostizClientForTenant(req.tenantDb!, tenantId, projectId);
    if ("status" in resolution) {
      res.status(409).json({ error: "postiz_not_configured", detail: resolution.detail });
      return;
    }

    try {
      const analytics = await resolution.getPostAnalytics(post.rows[0].postiz_post_id);
      const updated = await req.tenantDb!.query(
        `UPDATE postiz_social_posts SET engagement = $3::jsonb, last_synced_at = now(), last_error = NULL
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, status, postiz_post_id, published_at, engagement, last_synced_at`,
        [postId, tenantId, JSON.stringify(analytics)],
      );
      res.json({ post: updated.rows[0] });
    } catch (err) {
      const message = describePostizError(err);
      await req.tenantDb!.query(
        `UPDATE postiz_social_posts SET last_error = $3, last_synced_at = now() WHERE id = $1 AND tenant_id = $2`,
        [postId, tenantId, message],
      );
      res.status(502).json({ error: "postiz_sync_failed", detail: message });
    }
  } catch (err) {
    next(err);
  }
});

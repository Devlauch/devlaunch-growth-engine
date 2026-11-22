import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/integrations
 *
 * THIS IS A REGISTRY, NOT A WORKING CONNECTION. There is no real
 * OAuth/API integration with any of these providers implemented in this
 * phase (see docs/PHASE1_REPORT.md's provider cost table and
 * docs/DECISIONS.md, which confirms twenty/mautic/postiz/listmonk/
 * posthog/formbricks are out of scope for Phase 1 beyond this
 * registry). The "connect" route below never talks to a real provider,
 * never stores a real secret, and never claims a connection exists —
 * it only accepts a manually-entered placeholder label and sets the row
 * to 'pending_setup', which both the API response and this comment call
 * out explicitly as non-functional.
 */
export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.use(requireAuth, requireTenantMembership);

// The exact provider list from the product spec / docs/PHASE1_REPORT.md.
const PROVIDERS = [
  { key: "twenty", label: "Twenty", category: "crm" },
  { key: "mautic", label: "Mautic", category: "email_marketing" },
  { key: "postiz", label: "Postiz", category: "social" },
  { key: "listmonk", label: "Listmonk", category: "newsletter" },
  { key: "posthog", label: "PostHog", category: "analytics" },
  { key: "formbricks", label: "Formbricks", category: "feedback" },
] as const;

type ProviderKey = (typeof PROVIDERS)[number]["key"];
const PROVIDER_KEYS = PROVIDERS.map((p) => p.key) as [ProviderKey, ...ProviderKey[]];

const connectSchema = z.object({
  // A manually-entered label only (e.g. "acme-mautic-instance") — never a
  // real API key/secret. This route stores it as-is in
  // encrypted_credential_ref purely as a placeholder reference string; it
  // is not encrypted and not a real credential, by design, because there
  // is nothing real to connect to yet.
  placeholderLabel: z.string().trim().min(1).max(200),
});

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/integrations
 *
 * Returns every provider from the static list above, merged with this
 * project's real `integrations` row for it when one exists (defaulting to
 * 'not_connected' when it doesn't) — never a fabricated "connected" state.
 */
integrationsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const existing = await req.tenantDb!.query(
      `SELECT id, provider, status, scopes, created_at, updated_at
       FROM integrations
       WHERE tenant_id = $1 AND project_id = $2`,
      [req.tenantId, projectId],
    );
    const byProvider = new Map<string, (typeof existing.rows)[number]>();
    for (const row of existing.rows) byProvider.set(row.provider, row);

    const integrations = PROVIDERS.map((p) => {
      const row = byProvider.get(p.key);
      return {
        provider: p.key,
        label: p.label,
        category: p.category,
        status: row?.status ?? "not_connected",
        scopes: row?.scopes ?? [],
        updatedAt: row?.updated_at ?? null,
      };
    });

    res.json({
      integrations,
      note: "Registry only — no provider is actually connected in this phase. 'pending_setup' records a placeholder label, not a real credential.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/integrations/:provider/connect
 *
 * NON-FUNCTIONAL PLACEHOLDER: does not contact the provider, does not
 * validate the label against anything real, and never sets status to
 * 'connected' — only 'pending_setup'. This exists so the registry can
 * show real (if limited) state instead of hiding the feature entirely,
 * while being explicit in the response that nothing real happened.
 */
integrationsRouter.post("/:provider/connect", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const provider = z.enum(PROVIDER_KEYS).parse(req.params.provider);
    const body = connectSchema.parse(req.body);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await req.tenantDb!.query(
      `INSERT INTO integrations (tenant_id, project_id, provider, status, encrypted_credential_ref, created_by)
       VALUES ($1, $2, $3, 'pending_setup', $4, $5)
       ON CONFLICT (project_id, provider)
       DO UPDATE SET status = 'pending_setup', encrypted_credential_ref = $4, updated_at = now()
       RETURNING id, provider, status, scopes, created_at, updated_at`,
      [req.tenantId, projectId, provider, body.placeholderLabel, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'integration.pending_setup', 'integration', $3, $4::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id, JSON.stringify({ provider })],
    );

    res.status(201).json({
      integration: result.rows[0],
      note: "Real provider connection is not implemented yet in this phase — this only records a placeholder label and marks the integration 'pending_setup'. No request was made to the provider, and no credential was stored.",
    });
  } catch (err) {
    next(err);
  }
});

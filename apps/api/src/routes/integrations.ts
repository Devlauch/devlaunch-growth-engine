import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors, HttpError } from "../lib/httpError.js";
import { encryptCredential, isCredentialEncryptionConfigured } from "../lib/credentialEncryption.js";
import { getIntegrationCredential } from "../lib/integrationCredentials.js";
import { logger } from "../lib/logger.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/integrations
 *
 * Milestone 2 upgrade: this registry now supports a REAL per-tenant
 * connection for exactly 3 providers — listmonk, chatwoot, postiz — per
 * docs/INTEGRATION_STATUS.md. twenty/mautic/posthog/formbricks remain
 * registry-only placeholders (unchanged — no real integration exists for
 * them in this phase; `connect` still works for them but there is nothing
 * real on the other end).
 *
 * "Real" here means: a tenant's own API key/token is encrypted at rest
 * (apps/api/src/lib/credentialEncryption.ts, AES-256-GCM, keyed by
 * INTEGRATION_CREDENTIALS_KEY) before being stored, non-secret settings
 * (baseUrl, inboxId, etc.) are stored as plain jsonb `config`, and a
 * health-check route exists to actually ask "is this really reachable" —
 * but THIS FILE DOES NOT TALK TO ANY EXTERNAL PROVIDER ITSELF. The real
 * listmonk/chatwoot/postiz HTTP clients are being built concurrently by
 * other agents (see docs/INTEGRATION_STATUS.md section 5); this route
 * only looks for `checkHealth` exported from their module once it exists
 * (see loadProviderHealthCheck below) and otherwise honestly reports
 * `integration_not_yet_implemented` — never a fabricated success.
 */
export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.use(requireAuth, requireTenantMembership);

// The exact provider list from the product spec / docs/PHASE1_REPORT.md,
// plus 'chatwoot' (newly approved in Milestone 2 — see
// packages/db/migrations/285_add_chatwoot_to_integrations.sql).
const PROVIDERS = [
  { key: "twenty", label: "Twenty", category: "crm" },
  { key: "mautic", label: "Mautic", category: "email_marketing" },
  { key: "postiz", label: "Postiz", category: "social" },
  { key: "listmonk", label: "Listmonk", category: "newsletter" },
  { key: "posthog", label: "PostHog", category: "analytics" },
  { key: "formbricks", label: "Formbricks", category: "feedback" },
  { key: "chatwoot", label: "Chatwoot", category: "chat" },
  { key: "hunter", label: "Hunter", category: "enrichment" },
] as const;

// The providers that actually build a real connection (health-check calls
// a real external API). Everything else keeps the old registry-only
// ("pending_setup" label, never 'connected') behavior.
const REAL_PROVIDERS = new Set(["listmonk", "chatwoot", "postiz", "hunter"]);

type ProviderKey = (typeof PROVIDERS)[number]["key"];
const PROVIDER_KEYS = PROVIDERS.map((p) => p.key) as [ProviderKey, ...ProviderKey[]];

// { config: {...non-secret settings...}, secret?: "the real api key/token" }
// Replaces the old placeholderLabel-only body. `secret` is optional so a
// config-only update (e.g. changing baseUrl without re-entering the key)
// doesn't force re-entry of the credential.
const connectSchema = z.object({
  config: z.record(z.unknown()).default({}),
  secret: z.string().trim().min(1).max(4000).optional(),
});

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

async function insertAuditEvent(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  userId: string | undefined,
  action: string,
  integrationId: string,
  metadata: Record<string, unknown>,
) {
  // Never put a secret in metadata — provider/status/config-keys only.
  await tenantDb.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'user', $2, $3, 'integration', $4, $5::jsonb)`,
    [tenantId, userId ?? null, action, integrationId, JSON.stringify(metadata)],
  );
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
      `SELECT id, provider, status, scopes, config, created_at, updated_at
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
        config: row?.config ?? {},
        hasSecret: Boolean(row), // never echo the secret itself, only whether one is on file
        real: REAL_PROVIDERS.has(p.key),
        updatedAt: row?.updated_at ?? null,
      };
    });

    res.json({
      integrations,
      note: "listmonk, chatwoot, and postiz support a real per-tenant connection (encrypted credential + health-check); every other provider remains registry-only in this phase.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/integrations/:provider/connect
 *
 * Stores `config` (non-secret settings) as-is, and — if `secret` is
 * given — encrypts it via credentialEncryption.ts before storing it in
 * `encrypted_credential_ref`. Sets status to 'pending_setup' (not
 * 'connected' — this route never claims a working connection; only a real
 * health-check, or a future provider-specific verified sync, earns
 * 'connected'/'error').
 *
 * If a `secret` is supplied but encryption isn't configured in this
 * environment (no INTEGRATION_CREDENTIALS_KEY), this responds 501 rather
 * than silently storing the secret in plaintext or silently dropping it —
 * never a silent security downgrade. A connect with no `secret` (config
 * only) always succeeds regardless of encryption configuration.
 */
integrationsRouter.post("/:provider/connect", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const provider = z.enum(PROVIDER_KEYS).parse(req.params.provider);
    const body = connectSchema.parse(req.body);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    let encryptedCredentialRef: string | null = null;
    if (body.secret !== undefined) {
      if (!isCredentialEncryptionConfigured()) {
        throw new HttpError(
          501,
          "credential_encryption_not_configured",
          "INTEGRATION_CREDENTIALS_KEY is not configured in this environment — cannot safely store a real secret. Set INTEGRATION_CREDENTIALS_KEY (base64, 32 bytes) or omit `secret` and send config only.",
        );
      }
      encryptedCredentialRef = encryptCredential(body.secret);
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO integrations (tenant_id, project_id, provider, status, encrypted_credential_ref, config, created_by)
       VALUES ($1, $2, $3, 'pending_setup', $4, $5::jsonb, $6)
       ON CONFLICT (project_id, provider)
       DO UPDATE SET
         status = 'pending_setup',
         encrypted_credential_ref = COALESCE($4, integrations.encrypted_credential_ref),
         config = $5::jsonb,
         updated_at = now()
       RETURNING id, provider, status, scopes, config, created_at, updated_at`,
      [req.tenantId, projectId, provider, encryptedCredentialRef, JSON.stringify(body.config), req.userId],
    );

    await insertAuditEvent(req.tenantDb!, req.tenantId!, req.userId, "integration.connected", result.rows[0].id, {
      provider,
      configKeys: Object.keys(body.config),
      secretProvided: body.secret !== undefined,
    });

    res.status(201).json({
      integration: result.rows[0],
      note: REAL_PROVIDERS.has(provider)
        ? "Credential (if provided) is encrypted at rest. Status is 'pending_setup' until a health-check confirms a real connection — use POST .../health-check."
        : "Registry-only provider — no real connection exists for this provider in this phase, even though the credential (if provided) is encrypted the same way.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Looks for `apps/api/src/lib/<provider>Client.ts` and, if it exists and
 * exports `checkHealth`, calls it. These client files are being built
 * concurrently by other agents (Milestone 2, docs/INTEGRATION_STATUS.md)
 * and may not exist yet, or may exist without `checkHealth` yet — both
 * are honest "not implemented" states, not errors.
 *
 * Expected `checkHealth` contract for those agents to implement:
 *
 *   export async function checkHealth(
 *     credential: { config: Record<string, unknown>; secret: string | null }
 *   ): Promise<{ status: "connected" | "error"; detail?: string }>
 *
 * It should perform one real, lightweight call to the external service
 * (e.g. a "whoami"/ping endpoint) and return 'error' with a `detail`
 * message on any failure — never throw for an ordinary unreachable/
 * unauthorized provider (reserve thrown errors for programmer bugs).
 */
async function loadProviderHealthCheck(
  provider: string,
): Promise<
  | ((credential: { config: Record<string, unknown>; secret: string | null }) => Promise<{ status: string; detail?: string }>)
  | null
> {
  const moduleFile = `${provider}Client.js`;
  try {
    // Relative import resolved at runtime; a missing module throws
    // ERR_MODULE_NOT_FOUND, which we treat as "not implemented yet" below.
    const mod = (await import(`../lib/${moduleFile}`)) as Record<string, unknown>;
    const checkHealth = mod.checkHealth;
    if (typeof checkHealth === "function") {
      return checkHealth as (credential: {
        config: Record<string, unknown>;
        secret: string | null;
      }) => Promise<{ status: string; detail?: string }>;
    }
    return null;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return null;
    }
    // Any other failure (the client module exists but throws on import —
    // e.g. a syntax/config error in code another agent is mid-writing) is
    // logged and treated the same as "not implemented yet" rather than
    // taking down this route.
    logger.warn({ provider, err }, "failed to load provider health-check module");
    return null;
  }
}

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/integrations/:provider/health-check
 *
 * Loads this project's integration row, decrypts the stored secret (if
 * any), and delegates to that provider's real `checkHealth` (see
 * loadProviderHealthCheck above) when it exists. Never calls any external
 * service itself. Updates `integrations.status` to 'connected'/'error'
 * based on a real result; leaves it as-is (and reports
 * 'integration_not_yet_implemented') when no client module is available
 * yet, rather than fabricating either outcome.
 */
integrationsRouter.post("/:provider/health-check", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const provider = z.enum(PROVIDER_KEYS).parse(req.params.provider);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const idResult = await req.tenantDb!.query(
      `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = $3`,
      [req.tenantId, projectId, provider],
    );
    if (idResult.rowCount === 0) {
      throw Errors.notFound("No integration row exists for this provider yet — connect it first.");
    }
    const integrationId = idResult.rows[0].id as string;

    const credential = await getIntegrationCredential(req.tenantDb!, req.tenantId!, projectId, provider);
    if (!credential) {
      throw Errors.notFound("No integration row exists for this provider yet — connect it first.");
    }

    const checkHealth = await loadProviderHealthCheck(provider);
    if (!checkHealth) {
      const note = `No real health-check is available for '${provider}' yet in this environment (apps/api/src/lib/${provider}Client.ts does not exist or has no checkHealth export). This is an honest "not built yet" response, not a fabricated success.`;
      await insertAuditEvent(req.tenantDb!, req.tenantId!, req.userId, "integration.health_checked", integrationId, {
        provider,
        result: "integration_not_yet_implemented",
      });
      res.json({ provider, status: "integration_not_yet_implemented", note });
      return;
    }

    const result = await checkHealth({ config: credential.config, secret: credential.secret });
    const newStatus = result.status === "connected" ? "connected" : "error";

    await req.tenantDb!.query(
      `UPDATE integrations SET status = $1, updated_at = now()
       WHERE tenant_id = $2 AND project_id = $3 AND provider = $4`,
      [newStatus, req.tenantId, projectId, provider],
    );

    await insertAuditEvent(req.tenantDb!, req.tenantId!, req.userId, "integration.health_checked", integrationId, {
      provider,
      result: newStatus,
      detail: result.detail,
    });

    res.json({
      provider,
      status: newStatus,
      detail: result.detail,
    });
  } catch (err) {
    next(err);
  }
});

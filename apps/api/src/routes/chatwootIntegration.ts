import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getChatwootClientForTenant } from "../lib/chatwootClient.js";
import { getIntegrationCredential } from "../lib/integrationCredentials.js";
import {
  buildChatwootIdentity,
  ChatwootIdentityNotConfiguredError,
  parseChatwootSecret,
} from "../lib/chatwootIdentity.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot
 *
 * Deliberately additive to, not a replacement for,
 * apps/api/src/routes/integrations.ts's generic provider-agnostic
 * POST .../integrations/:provider/connect and
 * POST .../integrations/:provider/health-check (already built by a
 * concurrent change — see docs/INTEGRATION_STATUS.md section 5 and that
 * file's own doc comment). This router only adds endpoints that route has
 * no equivalent for:
 *
 *   GET  .../conversations   — a real, live list of this project's
 *                              Chatwoot conversations (for a simple
 *                              "recent conversations" dashboard widget).
 *   GET  .../embed-snippet   — the ready-to-paste <script> tag for
 *                              packages/embed-widget/chatwootWidget.js,
 *                              built server-side from this project's
 *                              stored (non-secret) config.baseUrl/
 *                              config.websiteToken, so the frontend never
 *                              has to duplicate that template.
 *
 * Mounting this at a sub-path of the same prefix the generic
 * integrationsRouter already owns (`/integrations`) is safe: that router
 * only defines GET "/", POST "/:provider/connect", and
 * POST "/:provider/health-check" — none of which match "/conversations" or
 * "/embed-snippet" under "/chatwoot", so there is no route collision
 * regardless of mount order (see this feature's handback for the exact
 * one-line app.ts snippet).
 */
export const chatwootIntegrationRouter = Router({ mergeParams: true });
chatwootIntegrationRouter.use(requireAuth, requireTenantMembership);

function parseProjectId(req: import("express").Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

async function assertProjectInTenant(req: import("express").Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot/conversations
 *
 * A real, live call to Chatwoot's own API (apps/api/src/lib/chatwootClient.ts)
 * — never a cached/fabricated list. Honestly reports `not_configured` (200,
 * not an error) when this project hasn't connected Chatwoot yet, and maps
 * a real unreachable/unauthorized failure to 502 with the provider's own
 * detail message rather than swallowing it.
 */
chatwootIntegrationRouter.get("/conversations", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);

    const resolution = await getChatwootClientForTenant(req.tenantDb!, req.tenantId!, projectId);
    if (!("listConversations" in resolution)) {
      res.json({ status: "not_configured", detail: resolution.detail, conversations: [] });
      return;
    }

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    try {
      const conversations = await resolution.listConversations({ status });
      res.json({ status: "ok", conversations });
    } catch (chatwootErr) {
      const message = chatwootErr instanceof Error ? chatwootErr.message : String(chatwootErr);
      next(Errors.badGateway(`Chatwoot request failed: ${message}`));
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot/embed-snippet
 *
 * Builds Chatwoot's own documented website-widget embed snippet
 * (https://www.chatwoot.com/docs — SDK: `<script>` that loads
 * `{baseUrl}/packs/js/sdk.js` then calls
 * `window.chatwootSDK.run({ websiteToken, baseUrl })`) from this project's
 * stored, non-secret config (config.baseUrl / config.websiteToken — set
 * via the generic POST .../integrations/chatwoot/connect). Never includes
 * the apiAccessToken or any encrypted credential — a website token is the
 * PUBLIC half of Chatwoot's widget identity, meant to be visible in page
 * source, same trust model as this platform's own
 * packages/embed-widget/embed.js public project key.
 *
 * 404s (not a fabricated empty snippet) when websiteToken/baseUrl aren't
 * configured yet.
 */
chatwootIntegrationRouter.get("/embed-snippet", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query<{ config: Record<string, unknown> | null }>(
      `SELECT config FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'chatwoot'`,
      [req.tenantId, projectId],
    );
    const config = result.rows[0]?.config ?? {};
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : null;
    const websiteToken = typeof config.websiteToken === "string" ? config.websiteToken : null;

    if (!baseUrl || !websiteToken) {
      throw Errors.notFound(
        "No Chatwoot websiteToken/baseUrl configured for this project yet — set them via POST .../integrations/chatwoot/connect's config, or paste Chatwoot's own snippet directly (see docs/INTEGRATION_STATUS.md).",
      );
    }

    const snippet =
      `<script>\n` +
      `  (function (d, t) {\n` +
      `    var BASE_URL = ${JSON.stringify(baseUrl)};\n` +
      `    var g = d.createElement(t), s = d.getElementsByTagName(t)[0];\n` +
      `    g.src = BASE_URL + "/packs/js/sdk.js";\n` +
      `    g.defer = true;\n` +
      `    g.async = true;\n` +
      `    s.parentNode.insertBefore(g, s);\n` +
      `    g.onload = function () {\n` +
      `      window.chatwootSDK.run({ websiteToken: ${JSON.stringify(websiteToken)}, baseUrl: BASE_URL });\n` +
      `    };\n` +
      `  })(document, "script");\n` +
      `</script>`;

    res.json({ baseUrl, websiteToken, snippet });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tenants/:tenantId/projects/:projectId/integrations/chatwoot/identity-hash
 *
 * Milestone 3, Phase 1 identity-verification feature — see
 * apps/api/src/lib/chatwootIdentity.ts's doc comment for the full design
 * rationale and the exact HMAC scheme (confirmed against the reference
 * Chatwoot clone). ADDITIVE ONLY: the anonymous-visitor widget embed
 * (/embed-snippet above, packages/embed-widget/chatwootWidget.js) is
 * completely unaffected — this is a second, authenticated-only surface for
 * when a platform user is ALREADY signed in (e.g. an in-app support chat
 * embed), so their Chatwoot session can assert a real, cryptographically
 * verifiable identity instead of (or alongside) an anonymous visitor
 * contact.
 *
 * Requires requireAuth + requireTenantMembership (already applied to this
 * whole router above) — req.userId is the platform's own authenticated
 * user id, never a client-supplied value, so there is no way for a caller
 * to request a hash for an identity that is not their own.
 *
 * Honestly reports 501 chatwoot_identity_not_configured (never a fabricated
 * hash) when this tenant/project hasn't opted in yet — i.e. hasn't
 * connected Chatwoot with secret = JSON.stringify({ apiAccessToken,
 * widgetHmacToken }). An integration connected with a bare apiAccessToken
 * string (every tenant before this feature existed) falls into this same
 * honest "not configured" path rather than ever being treated as
 * configured by accident.
 */
chatwootIntegrationRouter.get("/identity-hash", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);

    const credential = await getIntegrationCredential(req.tenantDb!, req.tenantId!, projectId, "chatwoot");
    if (!credential || credential.status !== "connected") {
      res.status(404).json({
        status: "not_connected",
        detail: "No connected chatwoot integration for this tenant/project yet.",
      });
      return;
    }

    const { widgetHmacToken } = parseChatwootSecret(credential.secret);
    const baseUrl = typeof credential.config.baseUrl === "string" ? credential.config.baseUrl : null;
    const websiteToken = typeof credential.config.websiteToken === "string" ? credential.config.websiteToken : null;

    if (!widgetHmacToken) {
      res.status(501).json({
        status: "chatwoot_identity_not_configured",
        detail:
          "This tenant's chatwoot integration has no widgetHmacToken configured — identity verification is opt-in. " +
          "Reconnect with secret = JSON.stringify({ apiAccessToken, widgetHmacToken }) to enable it (widgetHmacToken " +
          "comes from Chatwoot's Inbox Settings > Configuration > 'Enable Identity Validation').",
      });
      return;
    }

    const userId = req.userId;
    if (!userId) {
      next(Errors.unauthorized("No authenticated user id on this request"));
      return;
    }

    const { identifier, identifierHash } = buildChatwootIdentity(widgetHmacToken, req.tenantId!, projectId, userId);

    res.json({
      status: "ok",
      identifier,
      identifierHash,
      baseUrl,
      websiteToken,
      email: req.userEmail ?? undefined,
    });
  } catch (err) {
    if (err instanceof ChatwootIdentityNotConfiguredError) {
      res.status(501).json({ status: "chatwoot_identity_not_configured", detail: err.message });
      return;
    }
    next(err);
  }
});

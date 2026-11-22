import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";

/**
 * Public (unauthenticated-by-necessity) inbound webhook receiver for
 * Postiz, following the identical structure/mounting convention as
 * apps/api/src/routes/listmonkWebhooks.ts (same shared
 * `integration_webhook_events` landing table, same per-tenant/project URL
 * shape). Mounted at /api/v1/webhooks/postiz/:tenantId/:projectId — see
 * this module's companion comment in the handback for the exact app.ts
 * wiring line (not added here, per instructions: app.ts is not edited by
 * this change).
 *
 * IMPORTANT, DOCUMENTED LIMITATION (per docs/INTEGRATION_STATUS.md's rule
 * "if a provider has no documented signature scheme, that must be called
 * out explicitly as a known limitation, not silently skipped"):
 *
 * Postiz's public API (`/public/v1`) documents NO signature/HMAC scheme
 * for its outbound webhook deliveries. Verified against a read-only clone
 * of gitroomhq/postiz-app
 * (apps/backend/src/api/routes/webhooks.controller.ts +
 * libraries/nestjs-libraries/src/dtos/webhooks/webhooks.dto.ts): a webhook
 * is registered as a bare {name, url, integrations[]} under Postiz's own
 * dashboard-authenticated `/webhooks` controller (NOT under `/public/v1`,
 * so it is not reachable with just a Postiz API key — a human must
 * register it from the Postiz dashboard), and delivery is a plain
 * `fetch(url, { method: 'POST', body: JSON.stringify(body) })` with no
 * signing secret, no HMAC header, nothing this endpoint could verify a
 * request actually came from Postiz.
 *
 * Consequence (the explicit, documented choice this task calls for):
 * this endpoint is BEST-EFFORT ONLY. It still requires a shared secret
 * (POSTIZ_WEBHOOK_SECRET) as a query param / header this platform itself
 * controls (the same pattern listmonkWebhooks.ts uses for its own
 * platform-side secret), but that secret is this platform's own addition
 * baked into the URL registered in Postiz's dashboard — it is NOT a
 * Postiz-verified signature, and a sufficiently motivated attacker who
 * learned that URL could still forge a payload. Every event recorded here
 * is status='pending' and MUST be treated as advisory, never as the sole
 * trigger for anything irreversible.
 *
 * THE AUTHORITATIVE status/analytics sync path is the real polling job in
 * apps/api/src/routes/postizIntegration.ts's POST
 * .../posts/:postId/sync (GET /public/v1/analytics/post/:id), which this
 * endpoint's events can only ever prompt an EARLIER-than-the-next-poll
 * sync of, never substitute for.
 */
export const postizWebhooksRouter = Router();

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid(),
});

// Same abuse profile as listmonkWebhooks.ts — a public, server-to-server
// endpoint with no CORS relevance but a real rate limit regardless.
const perTenantLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: 120,
  name: "postiz-webhook",
  keyFn: (req) => `${req.params.tenantId}:${req.params.projectId}`,
});

function extractSecret(req: import("express").Request): string | undefined {
  const header = req.header("X-Postiz-Webhook-Secret");
  if (header) return header;
  const query = req.query.secret;
  if (typeof query === "string") return query;
  return undefined;
}

function deriveEventType(body: unknown): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.type === "string") return obj.type;
    if (typeof obj.event === "string") return obj.event;
  }
  return "unknown";
}

/** Same fallback convention as listmonkWebhooks.ts's deriveExternalEventId(): a stable id if the payload has one, else a hash of the raw payload. */
function deriveExternalEventId(body: unknown): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const candidate = obj.id ?? obj.postId ?? obj.post_id;
    if (typeof candidate === "string" && candidate) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

/**
 * POST /api/v1/webhooks/postiz/:tenantId/:projectId
 *
 * Records a best-effort Postiz post-status event into
 * `integration_webhook_events` (status='pending') for this tenant/
 * project's postiz integration. See this module's doc comment for why
 * this is advisory-only and never the sole source of truth.
 */
postizWebhooksRouter.post("/:tenantId/:projectId", perTenantLimiter, async (req, res, next) => {
  if (!env.postizWebhookSecret) {
    res.status(503).json({
      error: "postiz_webhook_not_configured",
      message: "POSTIZ_WEBHOOK_SECRET is not configured on this server — refusing to accept webhook events.",
    });
    return;
  }

  const providedSecret = extractSecret(req);
  if (!providedSecret || providedSecret !== env.postizWebhookSecret) {
    logger.warn("postiz webhook rejected: missing or invalid shared secret");
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing webhook secret" });
    return;
  }

  const client = await pool.connect();
  let settled = false;
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const integration = await client.query<{ id: string }>(
      `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'postiz'`,
      [tenantId, projectId],
    );
    if (integration.rowCount === 0) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      next(Errors.notFound("No postiz integration is registered for this tenant/project"));
      return;
    }
    const integrationId = integration.rows[0].id;

    const eventType = deriveEventType(req.body);
    const externalEventId = deriveExternalEventId(req.body);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_webhook_events
         (tenant_id, integration_id, provider, external_event_id, event_type, payload)
       VALUES ($1, $2, 'postiz', $3, $4, $5::jsonb)
       ON CONFLICT (integration_id, external_event_id) DO NOTHING
       RETURNING id`,
      [tenantId, integrationId, externalEventId, eventType, JSON.stringify(req.body ?? {})],
    );

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(200).json({
      received: true,
      deduplicated: inserted.rowCount === 0,
      eventId: inserted.rows[0]?.id ?? null,
      note: "Best-effort only — Postiz's public API has no verified webhook signature scheme. See this route's doc comment.",
    });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

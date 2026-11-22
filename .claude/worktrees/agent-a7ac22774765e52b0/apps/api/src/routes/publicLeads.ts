import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { leadInputSchema, ingestLead } from "../lib/leadIngestion.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const publicLeadsRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

// Per-IP limit: protects any single client from hammering this endpoint,
// regardless of which (valid or guessed) project key it uses.
const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerIpPerMin,
  name: "public-leads-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

// Per-key limit: protects a single project's widget from being hammered
// from many different IPs using the same (possibly leaked) public key.
const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerKeyPerMin,
  name: "public-leads-key",
  keyFn: (req) => req.params.projectPublicKey,
});

const publicKeyParamSchema = z.string().trim().min(8).max(200);

// Config fetch is cheap (single read) but still unauthenticated-by-design,
// so it shares the exact same per-IP/per-key rate limiters as the lead
// submission endpoint below.
const configPerIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerIpPerMin,
  name: "public-widget-config-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const configPerKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicLeadsRateLimitPerKeyPerMin,
  name: "public-widget-config-key",
  keyFn: (req) => req.params.projectPublicKey,
});

/**
 * GET /api/v1/public/projects/:projectPublicKey/config
 *
 * Roadmap item 6 ("Inbound lead capture"): lets the embeddable widget
 * (packages/embed-widget/embed.js) fetch a project's public-safe widget
 * config — the qualifying question to render, the post-submit booking
 * link, and the thank-you copy — before rendering, WITHOUT exposing
 * anything sensitive (no public_api_key, no allowed_origins, no tenant
 * id). Protected the exact same way as the POST endpoint below: an
 * unknown/disabled key is a 404, and the request must come from an
 * allowlisted Origin, enforced via the same
 * 019_public_project_lookup_rls.sql RLS policy (app.lookup_public_api_key).
 */
publicLeadsRouter.get(
  "/projects/:projectPublicKey/config",
  configPerIpLimiter,
  configPerKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const origin = req.header("origin") ?? null;

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

      const projectResult = await client.query(
        `SELECT allowed_origins, public_widget_enabled,
                widget_qualifying_question, widget_booking_link_url, widget_thank_you_message
         FROM projects
         WHERE public_api_key = $1`,
        [projectPublicKey],
      );

      if (projectResult.rowCount === 0 || !projectResult.rows[0].public_widget_enabled) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Unknown or disabled project key"));
        return;
      }

      const project = projectResult.rows[0];
      const allowedOrigins: string[] = project.allowed_origins ?? [];

      if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.forbidden("Origin not allowed for this project"));
        return;
      }

      await client.query("COMMIT");
      settled = true;
      client.release();

      res.json({
        config: {
          widgetQualifyingQuestion: project.widget_qualifying_question ?? null,
          widgetBookingLinkUrl: project.widget_booking_link_url ?? null,
          widgetThankYouMessage: project.widget_thank_you_message ?? null,
        },
      });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

/**
 * POST /api/v1/public/projects/:projectPublicKey/leads
 *
 * Unauthenticated-by-design (no user session / JWT / X-Dev-User-Id
 * required) so ANY external website can embed the widget
 * (packages/embed-widget) and submit leads. Protected instead by:
 *
 *   1. The project's own public_api_key (random token, NOT a tenant id or
 *      DB credential — see packages/db migration 016) in the URL.
 *   2. An Origin allowlist checked against the project's allowed_origins.
 *   3. Rate limiting, per IP and per key (above).
 *   4. Input validation (packages/api/src/lib/leadIngestion.ts).
 *
 * Every submission is written through ingestLead() — the exact same
 * tenant-isolated path used for any other lead — and tagged
 * source=public_widget on both the leads row and its audit_events row.
 * This endpoint ONLY ever inserts a `leads` row: it never sends email, never
 * triggers outreach, and never auto-approves anything. A captured lead must
 * still go through the existing agent + approval flow
 * (GET/POST /api/v1/tenants/:tenantId/approvals) before any outbound action.
 */
publicLeadsRouter.post("/projects/:projectPublicKey/leads", perIpLimiter, perKeyLimiter, async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
    const body = leadInputSchema.parse(req.body);
    const origin = req.header("origin") ?? null;

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

    const projectResult = await client.query(
      `SELECT id, tenant_id, allowed_origins, public_widget_enabled
       FROM projects
       WHERE public_api_key = $1`,
      [projectPublicKey],
    );

    if (projectResult.rowCount === 0 || !projectResult.rows[0].public_widget_enabled) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      logger.warn({ projectPublicKey }, "public lead submission rejected: unknown/disabled project public key");
      next(Errors.notFound("Unknown or disabled project key"));
      return;
    }

    const project = projectResult.rows[0];
    const allowedOrigins: string[] = project.allowed_origins ?? [];

    if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      logger.warn({ projectPublicKey, origin }, "public lead submission rejected: origin not allowlisted");
      next(Errors.forbidden("Origin not allowed for this project"));
      return;
    }

    // Switch the session into this project's tenant context so the actual
    // insert goes through the normal tenant-isolated leads/audit_events RLS
    // policies, exactly like any internal lead write.
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [project.tenant_id]);

    const lead = await ingestLead({
      client,
      tenantId: project.tenant_id,
      projectId: project.id,
      input: body,
      source: "public_widget",
      origin,
      ipHash: hashIp(req.ip ?? "unknown"),
    });

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(201).json({ lead: { id: lead.id, createdAt: lead.createdAt } });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

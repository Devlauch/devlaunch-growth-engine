import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { assignVariant, recordConversion } from "../lib/experimentEngine.js";

/**
 * Mounted at /api/v1/public (app.ts is off-limits this round -- mount this
 * router there alongside publicAnalyticsRouter/publicLandingPagesRouter,
 * with the same publicCors reflect-any-origin + per-route allowlist-check
 * pattern -- see this feature's handback for the exact mount line).
 *
 * Workstream C2's public, unauthenticated surface: a visiting browser asks
 * which variant it is in for a running experiment, and separately reports
 * a real conversion event. Protected the SAME way as every other public
 * endpoint in this codebase (publicAnalytics.ts / publicLandingPages.ts):
 *   1. The project's own public_api_key (never a tenant id/DB credential).
 *   2. An Origin allowlist checked against the project's allowed_origins.
 *   3. Rate limiting, per IP and per key (reusing the public-analytics env
 *      thresholds -- same always-on-every-page-view trust boundary as the
 *      site-analytics beacon, not the lower lead-capture allowance).
 *
 * visitorId convention: reused verbatim from publicAnalytics.ts's
 * collectSchema.visitorId (a client-generated, durable-per-browser id --
 * trimmed string, 8-100 chars). This endpoint does not invent a second
 * visitor-id scheme.
 */
export const publicExperimentsRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const perIpLimiter = rateLimitMiddleware({
  windowMs: 60000,
  max: env.publicAnalyticsRateLimitPerIpPerMin,
  name: "public-experiments-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60000,
  max: env.publicAnalyticsRateLimitPerKeyPerMin,
  name: "public-experiments-key",
  keyFn: (req) => {
    const key = req.body ? req.body.projectPublicKey : undefined;
    return typeof key === "string" ? key : "unknown";
  },
});

const experimentIdParamSchema = z.string().uuid();
const visitorIdSchema = z.string().trim().min(8).max(100);

const assignSchema = z.object({
  projectPublicKey: z.string().trim().min(8).max(200),
  visitorId: visitorIdSchema,
});

const convertSchema = z.object({
  projectPublicKey: z.string().trim().min(8).max(200),
  visitorId: visitorIdSchema,
  metricValue: z.number().finite().optional(),
});

interface ResolvedProject {
  id: string;
  tenantId: string;
}

type ResolutionErrorKind = "not_found" | "forbidden_origin" | "experiment_not_found";

interface ResolutionError {
  error: ResolutionErrorKind;
}

type Resolution = ResolvedProject | ResolutionError;

/**
 * Same project-resolution pattern as publicAnalytics.ts's resolveProject:
 * looks the project up by its public key via the existing
 * app.lookup_public_api_key RLS carve-out, checks public_widget_enabled +
 * the Origin allowlist, and on success sets app.current_tenant_id so every
 * subsequent query on this client goes through normal tenant-isolated RLS.
 * Also verifies the experiment itself belongs to that SAME project (not
 * just tenant) and is running -- a caller with one project's public key
 * can never assign/convert against another project's experiment, even
 * within the same tenant.
 */
async function resolveProjectForExperiment(
  client: import("pg").PoolClient,
  projectPublicKey: string,
  origin: string | null,
  experimentId: string,
): Promise<Resolution> {
  await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

  const projectResult = await client.query(
    `SELECT id, tenant_id, allowed_origins, public_widget_enabled
     FROM projects
     WHERE public_api_key = $1`,
    [projectPublicKey],
  );
  if (projectResult.rowCount === 0 || !projectResult.rows[0].public_widget_enabled) {
    return { error: "not_found" };
  }

  const project = projectResult.rows[0];
  const allowedOrigins: string[] = project.allowed_origins ?? [];
  if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
    return { error: "forbidden_origin" };
  }

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [project.tenant_id]);

  const experimentResult = await client.query(
    `SELECT 1 FROM growth_experiments WHERE id = $1 AND tenant_id = $2 AND project_id = $3 AND status = 'running'`,
    [experimentId, project.tenant_id, project.id],
  );
  if (experimentResult.rowCount === 0) {
    return { error: "experiment_not_found" };
  }

  return { id: project.id, tenantId: project.tenant_id };
}

function logAndRespondResolutionError(
  next: (err?: unknown) => void,
  experimentId: string,
  origin: string | null,
  kind: ResolutionErrorKind,
): void {
  logger.warn({ experimentId, origin, error: kind }, "public experiment request rejected");
  if (kind === "forbidden_origin") {
    next(Errors.forbidden("Origin not allowed for this project"));
  } else if (kind === "experiment_not_found") {
    next(Errors.notFound("No running growth experiment found for this project"));
  } else {
    next(Errors.notFound("Unknown or disabled project key"));
  }
}

/**
 * POST /experiments/:id/assign
 *
 * Returns the (deterministic, stable) variant this visitor is assigned to
 * for a running experiment. Safe to call repeatedly for the same visitor
 * (e.g. on every pageview) -- always returns the same variant_key once
 * assigned, never re-rolls.
 */
publicExperimentsRouter.post("/experiments/:id/assign", perIpLimiter, perKeyLimiter, async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const experimentId = experimentIdParamSchema.parse(req.params.id);
    const origin = req.header("origin") ?? null;
    const body = assignSchema.parse(req.body);

    await client.query("BEGIN");
    const resolution = await resolveProjectForExperiment(client, body.projectPublicKey, origin, experimentId);
    if ("error" in resolution) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      logAndRespondResolutionError(next, experimentId, origin, resolution.error);
      return;
    }

    const variantKey = await assignVariant(client, resolution.tenantId, experimentId, body.visitorId);
    await client.query("COMMIT");
    settled = true;
    client.release();
    res.status(200).json({ variantKey });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

/**
 * POST /experiments/:id/convert
 *
 * Records a real conversion for a visitor against a running experiment
 * (the primary_metric_event actually firing client-side).
 */
publicExperimentsRouter.post("/experiments/:id/convert", perIpLimiter, perKeyLimiter, async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const experimentId = experimentIdParamSchema.parse(req.params.id);
    const origin = req.header("origin") ?? null;
    const body = convertSchema.parse(req.body);

    await client.query("BEGIN");
    const resolution = await resolveProjectForExperiment(client, body.projectPublicKey, origin, experimentId);
    if ("error" in resolution) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      logAndRespondResolutionError(next, experimentId, origin, resolution.error);
      return;
    }

    await recordConversion(client, resolution.tenantId, experimentId, body.visitorId, body.metricValue ?? null);
    await client.query("COMMIT");
    settled = true;
    client.release();
    res.status(201).json({ recorded: true });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

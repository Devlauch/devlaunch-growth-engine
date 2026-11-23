import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/httpError.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isLikelyBot } from "../lib/botDetection.js";

/**
 * Mounted at /api/v1/public (app.ts is off-limits this round — mount this
 * router there alongside publicLeadsRouter/publicLandingPagesRouter, with
 * the same `publicCors` reflect-any-origin + per-route allowlist-check
 * pattern — see this feature's handback for the exact line).
 *
 * Milestone 2 (P1): real first-party website analytics ingestion. The
 * GENERAL-PURPOSE counterpart to publicLandingPages.ts's `/track` endpoint
 * (which stays exactly as-is for landing-page-specific page_view/
 * form_submit/download events feeding the existing experiment_results A/B
 * pipeline) — this endpoint is for the new site-wide tracking snippet
 * (packages/embed-widget/analytics.js), usable on ANY page of a tracked
 * site, not just a published landing page.
 *
 * Unauthenticated-by-design, protected the SAME way as every other public
 * endpoint in this codebase:
 *   1. The project's own public_api_key in the URL.
 *   2. An Origin allowlist checked against the project's allowed_origins.
 *   3. Rate limiting, per IP and per key (higher default allowance than
 *      the lead-capture endpoints — see env.publicAnalyticsRateLimitPer*).
 *   4. IP hashed (never stored raw) for rate-limit keying only — no IP is
 *      ever written to site_visitors/site_sessions/site_pageviews/site_events.
 *
 * Bot filtering: a deterministic, honestly-incomplete User-Agent check (see
 * src/lib/botDetection.ts) computed once, at session creation, and stored
 * on site_sessions.is_bot. Bot sessions/pageviews/events are still written
 * (transparency — nothing is silently dropped), but
 * src/lib/siteAnalytics.ts excludes them from the real traffic numbers it
 * reports.
 */
export const publicAnalyticsRouter = Router();

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

const perIpLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicAnalyticsRateLimitPerIpPerMin,
  name: "public-analytics-ip",
  keyFn: (req) => hashIp(req.ip ?? "unknown"),
});

const perKeyLimiter = rateLimitMiddleware({
  windowMs: 60_000,
  max: env.publicAnalyticsRateLimitPerKeyPerMin,
  name: "public-analytics-key",
  keyFn: (req) => req.params.projectPublicKey,
});

const publicKeyParamSchema = z.string().trim().min(8).max(200);

const trackingFieldSchema = z.string().trim().max(2048).optional();
const shortFieldSchema = z.string().trim().max(500).optional();

const collectSchema = z.object({
  type: z.enum(["pageview", "event"]),
  visitorId: z.string().trim().min(8).max(100),
  sessionId: z.string().trim().min(8).max(100),
  url: trackingFieldSchema,
  path: shortFieldSchema,
  referrer: trackingFieldSchema,
  utmSource: shortFieldSchema,
  utmMedium: shortFieldSchema,
  utmCampaign: shortFieldSchema,
  utmTerm: shortFieldSchema,
  utmContent: shortFieldSchema,
  // Custom-event fields — required when type === "event", ignored otherwise.
  eventName: z.string().trim().min(1).max(200).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

interface ResolvedProject {
  id: string;
  tenantId: string;
}

type ProjectResolution =
  | { ok: true; project: ResolvedProject }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden_origin" };

// Distinguishes "unknown/disabled key" (404) from "known key, disallowed
// origin" (403) -- same two-outcome split as routes/publicLeads.ts, so a
// misconfigured-but-real project's CORS error is never masked as a 404.
async function resolveProject(
  client: import("pg").PoolClient,
  projectPublicKey: string,
  origin: string | null,
): Promise<ProjectResolution> {
  await client.query("SELECT set_config('app.lookup_public_api_key', $1, true)", [projectPublicKey]);

  const projectResult = await client.query(
    `SELECT id, tenant_id, allowed_origins, public_widget_enabled
     FROM projects
     WHERE public_api_key = $1`,
    [projectPublicKey],
  );

  if (projectResult.rowCount === 0 || !projectResult.rows[0].public_widget_enabled) {
    return { ok: false, reason: "not_found" };
  }

  const project = projectResult.rows[0];
  const allowedOrigins: string[] = project.allowed_origins ?? [];
  if (allowedOrigins.length === 0 || !origin || !allowedOrigins.includes(origin)) {
    return { ok: false, reason: "forbidden_origin" };
  }

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [project.tenant_id]);
  return { ok: true, project: { id: project.id, tenantId: project.tenant_id } };
}

function derivePath(url: string | undefined): string {
  if (!url) return "/";
  try {
    return new URL(url).pathname || "/";
  } catch {
    // Not an absolute URL (e.g. the client only sent a path) — use it as-is,
    // truncated to a sane length.
    return url.slice(0, 500);
  }
}

/**
 * POST /api/v1/public/projects/:projectPublicKey/analytics/collect
 *
 * Accepts either a `pageview` beacon (written to site_pageviews, plus a
 * site_sessions upsert so a session's referrer/landing_url/UTM/is_bot are
 * captured once, at first contact) or a custom `event` beacon (written to
 * site_events). Both always upsert site_visitors (first_seen_at/
 * last_seen_at) and ensure a site_sessions row exists for the given
 * sessionId — a page firing a custom event before its first pageview (e.g.
 * a click handler higher up the page) still gets a valid session row.
 */
publicAnalyticsRouter.post(
  "/projects/:projectPublicKey/analytics/collect",
  perIpLimiter,
  perKeyLimiter,
  async (req, res, next) => {
    const client = await pool.connect();
    let settled = false;
    try {
      const projectPublicKey = publicKeyParamSchema.parse(req.params.projectPublicKey);
      const origin = req.header("origin") ?? null;
      const body = collectSchema.parse(req.body);

      if (body.type === "event" && !body.eventName) {
        client.release();
        settled = true;
        next(Errors.badRequest("eventName is required when type is 'event'"));
        return;
      }

      await client.query("BEGIN");
      const resolution = await resolveProject(client, projectPublicKey, origin);
      if (!resolution.ok) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        if (resolution.reason === "forbidden_origin") {
          logger.warn({ projectPublicKey, origin }, "public analytics beacon rejected: origin not allowlisted");
          next(Errors.forbidden("Origin not allowed for this project"));
        } else {
          logger.warn({ projectPublicKey, origin }, "public analytics beacon rejected: unknown/disabled project public key");
          next(Errors.notFound("Unknown or disabled project key"));
        }
        return;
      }
      const project = resolution.project;

      const userAgent = req.header("user-agent") ?? null;
      const isBot = isLikelyBot(userAgent);

      await client.query(
        `INSERT INTO site_visitors (tenant_id, project_id, visitor_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (tenant_id, project_id, visitor_id)
         DO UPDATE SET last_seen_at = now()`,
        [project.tenantId, project.id, body.visitorId],
      );

      // Session row is created once, at first contact (pageview or event),
      // capturing referrer/landing_url/UTM/is_bot at that moment only — a
      // later beacon for the same sessionId never overwrites these (an
      // ON CONFLICT DO NOTHING insert), matching a real session's "these
      // are fixed at session start" semantics.
      await client.query(
        `INSERT INTO site_sessions (
           tenant_id, project_id, visitor_id, session_id, started_at,
           referrer, landing_url, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
           user_agent, is_bot
         )
         VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, project_id, session_id) DO NOTHING`,
        [
          project.tenantId,
          project.id,
          body.visitorId,
          body.sessionId,
          body.referrer ?? null,
          body.url ?? null,
          body.utmSource ?? null,
          body.utmMedium ?? null,
          body.utmCampaign ?? null,
          body.utmTerm ?? null,
          body.utmContent ?? null,
          userAgent,
          isBot,
        ],
      );

      if (body.type === "pageview") {
        await client.query(
          `INSERT INTO site_pageviews (tenant_id, project_id, session_id, url, path, viewed_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [project.tenantId, project.id, body.sessionId, body.url ?? "", body.path ?? derivePath(body.url)],
        );
      } else {
        await client.query(
          `INSERT INTO site_events (tenant_id, project_id, session_id, event_name, properties, occurred_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
          [project.tenantId, project.id, body.sessionId, body.eventName, JSON.stringify(body.properties ?? {})],
        );
      }

      await client.query("COMMIT");
      settled = true;
      client.release();
      res.status(201).json({ tracked: true });
    } catch (err) {
      if (!settled) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      next(err);
    }
  },
);

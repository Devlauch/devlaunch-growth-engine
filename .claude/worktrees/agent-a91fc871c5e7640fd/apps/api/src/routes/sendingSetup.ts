import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { checkSpf, checkDmarc, checkDkim } from "../lib/dnsVerification.js";
import { currentWarmupLimit, shouldPauseForHealth } from "../lib/warmupPlan.js";

/**
 * Roadmap item 14 ("Sending setup per tenant"): domain DNS authentication
 * readiness (SPF/DKIM/DMARC), warm-up ramp config, and send-health
 * monitoring. All three routers below are scoped by `tenant_id` only —
 * `sending_domains` (and everything hanging off it) is not project-scoped
 * in the schema, since a sending domain belongs to the tenant as a whole,
 * not to one project. The `:projectId` segment in the mount path exists
 * purely for URL consistency with the rest of this app's tenant/project
 * nesting; it is never used to filter a query.
 *
 * No real outbound sending exists in this codebase yet (see
 * integrations.ts / campaigns.ts's honest "sending integration not yet
 * connected") — this is standalone deliverability-readiness
 * infrastructure: DNS verification is real right now, and the warm-up/
 * health math is real, even though nothing actually sends mail yet.
 */

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function loadSendingDomainOr404(req: Request, sendingDomainId: string) {
  const result = await req.tenantDb!.query(`SELECT * FROM sending_domains WHERE id = $1 AND tenant_id = $2`, [
    sendingDomainId,
    req.tenantId,
  ]);
  if (result.rowCount === 0) throw Errors.notFound("Sending domain not found");
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// sending_domains
// ---------------------------------------------------------------------------

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/sending-domains
 *
 * NOTE ON MIDDLEWARE PLACEMENT: unlike every other router in this app,
 * this router's mount path is itself a *prefix* of two other routers'
 * mount paths (warmupConfigsRouter and sendHealthRouter, both nested
 * under .../sending-domains/:sendingDomainId/...). Express's app.use()
 * prefix-matches, so a request for .../sending-domains/<id>/warmup would
 * also match this router's mount and run any middleware registered here
 * via a blanket `.use(...)` — before falling through (since no route
 * here matches "/:id/warmup") to warmupConfigsRouter, which runs
 * requireAuth/requireTenantMembership *again*. That would silently open
 * two pooled connections and run the membership check twice per request
 * to a nested path. To avoid that, requireAuth/requireTenantMembership
 * are attached per-route below instead of via a router-wide `.use()`, so
 * they only run for requests that actually match a route declared here.
 */
export const sendingDomainsRouter = Router({ mergeParams: true });

const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const createDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .refine((d) => DOMAIN_RE.test(d), { message: "Must be a valid domain name" }),
  dkimSelector: z.string().trim().min(1).max(200).optional(),
});

/** GET / — all sending domains for this tenant. */
sendingDomainsRouter.get("/", requireAuth, requireTenantMembership, async (req, res, next) => {
  try {
    const result = await req.tenantDb!.query(
      `SELECT * FROM sending_domains WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [req.tenantId],
    );
    res.json({ sendingDomains: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST / — register a new sending domain (verification happens separately, via /:id/verify). */
sendingDomainsRouter.post("/", requireAuth, requireTenantMembership, async (req, res, next) => {
  try {
    const body = createDomainSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO sending_domains (tenant_id, domain, dkim_selector)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.tenantId, body.domain, body.dkimSelector ?? null],
    );

    res.status(201).json({ sendingDomain: result.rows[0] });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
      next(Errors.conflict("This domain is already registered for this tenant"));
      return;
    }
    next(err);
  }
});

/**
 * POST /:id/verify — runs real DNS checks (SPF + DMARC always; DKIM only
 * if a dkim_selector is set on the row, since there is no default
 * selector to guess) and persists the fresh status/record columns.
 */
sendingDomainsRouter.post("/:id/verify", requireAuth, requireTenantMembership, async (req, res, next) => {
  try {
    const id = paramId(req, "id");
    const domainRow = await loadSendingDomainOr404(req, id);

    const [spf, dmarc, dkim] = await Promise.all([
      checkSpf(domainRow.domain),
      checkDmarc(domainRow.domain),
      domainRow.dkim_selector ? checkDkim(domainRow.domain, domainRow.dkim_selector) : Promise.resolve(null),
    ]);

    const result = await req.tenantDb!.query(
      `UPDATE sending_domains
       SET spf_status = $1, spf_record = $2,
           dmarc_status = $3, dmarc_record = $4, dmarc_policy = $5,
           dkim_status = COALESCE($6, dkim_status), dkim_record = COALESCE($7, dkim_record),
           last_checked_at = now()
       WHERE id = $8 AND tenant_id = $9
       RETURNING *`,
      [
        spf.status,
        spf.record ?? null,
        dmarc.status,
        dmarc.record ?? null,
        dmarc.policy ?? null,
        dkim ? dkim.status : null,
        dkim ? (dkim.record ?? null) : null,
        id,
        req.tenantId,
      ],
    );

    res.json({
      sendingDomain: result.rows[0],
      checked: { spf, dmarc, dkim },
      ...(domainRow.dkim_selector
        ? {}
        : {
            note: "No dkim_selector is set on this domain, so DKIM was not checked — DKIM selectors are provider-specific and cannot be guessed. Set one first.",
          }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// warmup_configs
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/warmup */
export const warmupConfigsRouter = Router({ mergeParams: true });
warmupConfigsRouter.use(requireAuth, requireTenantMembership);

const upsertWarmupSchema = z.object({
  dailyLimit: z.number().int().positive().default(20),
  targetDailyLimit: z.number().int().positive(),
  rampIncrement: z.number().int().positive().default(10),
  rampIntervalDays: z.number().int().positive().default(3),
  startedAt: z.string().datetime().optional(),
});

const patchWarmupSchema = z
  .object({
    dailyLimit: z.number().int().positive().optional(),
    targetDailyLimit: z.number().int().positive().optional(),
    rampIncrement: z.number().int().positive().optional(),
    rampIntervalDays: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

function withComputedLimit(row: Record<string, unknown>) {
  const currentLimit = currentWarmupLimit({
    dailyLimit: Number(row.daily_limit),
    targetDailyLimit: Number(row.target_daily_limit),
    rampIncrement: Number(row.ramp_increment),
    rampIntervalDays: Number(row.ramp_interval_days),
    startedAt: row.started_at as string,
  });
  return { ...row, currentLimit };
}

/** GET / — this sending domain's warm-up config, including the computed current limit. */
warmupConfigsRouter.get("/", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM warmup_configs WHERE sending_domain_id = $1 AND tenant_id = $2`,
      [sendingDomainId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No warm-up config set for this sending domain yet");

    res.json({ warmupConfig: withComputedLimit(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** POST / — create (or replace, if one already exists) the warm-up config for this sending domain. */
warmupConfigsRouter.post("/", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);
    const body = upsertWarmupSchema.parse(req.body);

    if (body.targetDailyLimit < body.dailyLimit) {
      throw Errors.badRequest("targetDailyLimit must be >= dailyLimit");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO warmup_configs
         (tenant_id, sending_domain_id, daily_limit, target_daily_limit, ramp_increment, ramp_interval_days, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
       ON CONFLICT (sending_domain_id)
       DO UPDATE SET
         daily_limit = $3, target_daily_limit = $4, ramp_increment = $5,
         ramp_interval_days = $6, started_at = COALESCE($7, warmup_configs.started_at), updated_at = now()
       RETURNING *`,
      [
        req.tenantId,
        sendingDomainId,
        body.dailyLimit,
        body.targetDailyLimit,
        body.rampIncrement,
        body.rampIntervalDays,
        body.startedAt ?? null,
      ],
    );

    res.status(201).json({ warmupConfig: withComputedLimit(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** PATCH / — update ramp settings on the existing warm-up config. */
warmupConfigsRouter.patch("/", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);
    const body = patchWarmupSchema.parse(req.body);

    const existing = await req.tenantDb!.query(
      `SELECT * FROM warmup_configs WHERE sending_domain_id = $1 AND tenant_id = $2`,
      [sendingDomainId, req.tenantId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("No warm-up config set for this sending domain yet");

    const merged = {
      dailyLimit: body.dailyLimit ?? existing.rows[0].daily_limit,
      targetDailyLimit: body.targetDailyLimit ?? existing.rows[0].target_daily_limit,
      rampIncrement: body.rampIncrement ?? existing.rows[0].ramp_increment,
      rampIntervalDays: body.rampIntervalDays ?? existing.rows[0].ramp_interval_days,
    };
    if (merged.targetDailyLimit < merged.dailyLimit) {
      throw Errors.badRequest("targetDailyLimit must be >= dailyLimit");
    }

    const result = await req.tenantDb!.query(
      `UPDATE warmup_configs
       SET daily_limit = $1, target_daily_limit = $2, ramp_increment = $3, ramp_interval_days = $4
       WHERE sending_domain_id = $5 AND tenant_id = $6
       RETURNING *`,
      [merged.dailyLimit, merged.targetDailyLimit, merged.rampIncrement, merged.rampIntervalDays, sendingDomainId, req.tenantId],
    );

    res.json({ warmupConfig: withComputedLimit(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

const pauseSchema = z.object({ reason: z.string().trim().max(1000).optional() });

/** POST /pause — manual override to pause sending for this domain. */
warmupConfigsRouter.post("/pause", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);
    const body = pauseSchema.parse(req.body ?? {});

    const result = await req.tenantDb!.query(
      `UPDATE warmup_configs SET is_paused = true, paused_reason = $1
       WHERE sending_domain_id = $2 AND tenant_id = $3
       RETURNING *`,
      [body.reason ?? "Paused manually", sendingDomainId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No warm-up config set for this sending domain yet");

    res.json({ warmupConfig: withComputedLimit(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** POST /resume — manual override to resume sending for this domain. */
warmupConfigsRouter.post("/resume", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);

    const result = await req.tenantDb!.query(
      `UPDATE warmup_configs SET is_paused = false, paused_reason = NULL
       WHERE sending_domain_id = $1 AND tenant_id = $2
       RETURNING *`,
      [sendingDomainId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No warm-up config set for this sending domain yet");

    res.json({ warmupConfig: withComputedLimit(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// send_health_stats
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/sending-domains/:sendingDomainId/health */
export const sendHealthRouter = Router({ mergeParams: true });
sendHealthRouter.use(requireAuth, requireTenantMembership);

const recordHealthSchema = z.object({
  statDate: z.string().date(),
  sentCount: z.number().int().min(0).default(0),
  bouncedCount: z.number().int().min(0).default(0),
  complainedCount: z.number().int().min(0).default(0),
});

/**
 * GET / — recent daily stats (most recent first) plus whether
 * shouldPauseForHealth would currently trigger, computed from the most
 * recent day's row.
 */
sendHealthRouter.get("/", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM send_health_stats WHERE sending_domain_id = $1 AND tenant_id = $2
       ORDER BY stat_date DESC LIMIT 90`,
      [sendingDomainId, req.tenantId],
    );

    const mostRecent = result.rows[0];
    const pauseEvaluation = mostRecent
      ? shouldPauseForHealth({
          sentCount: Number(mostRecent.sent_count),
          bouncedCount: Number(mostRecent.bounced_count),
          complainedCount: Number(mostRecent.complained_count),
        })
      : { pause: false };

    res.json({ sendHealthStats: result.rows, pauseEvaluation });
  } catch (err) {
    next(err);
  }
});

/** POST / — record/update a day's stats (manual entry — upsert on (sending_domain_id, stat_date)). */
sendHealthRouter.post("/", async (req, res, next) => {
  try {
    const sendingDomainId = paramId(req, "sendingDomainId");
    await loadSendingDomainOr404(req, sendingDomainId);
    const body = recordHealthSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO send_health_stats (tenant_id, sending_domain_id, stat_date, sent_count, bounced_count, complained_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sending_domain_id, stat_date)
       DO UPDATE SET sent_count = $4, bounced_count = $5, complained_count = $6
       RETURNING *`,
      [req.tenantId, sendingDomainId, body.statDate, body.sentCount, body.bouncedCount, body.complainedCount],
    );

    res.status(201).json({ sendHealthStat: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

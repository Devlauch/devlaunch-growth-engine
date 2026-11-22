import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
import { verifyUnsubscribeToken } from "../lib/suppression.js";

/**
 * Roadmap item 18, "Suppression and consent". Three authenticated,
 * tenant-scoped routers (suppression list, consent records, per-country send
 * settings) modeled on the CRUD convention in src/routes/icpProfiles.ts, plus
 * one unauthenticated public endpoint (POST /api/v1/public/unsubscribe)
 * modeled on src/routes/publicLeads.ts's public-surface pattern.
 *
 * The suppression_list / consent_records tables are tenant-wide (see
 * packages/db/migrations/035 and 036), but are mounted here under the
 * project path for URL consistency with the rest of the app — every query
 * below scopes by tenant_id only, never by project_id.
 */

async function assertProjectInTenant(req: import("express").Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

function parseProjectId(req: import("express").Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

function parsePagination(req: import("express").Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

export const suppressionRouter = Router({ mergeParams: true });
suppressionRouter.use(requireAuth, requireTenantMembership);

const createSuppressionSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    reason: z.enum(["unsubscribed", "bounced", "complained", "manual", "legal_request"]).optional(),
    channel: z.enum(["email", "whatsapp", "phone", "all"]),
    sourceNote: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Boolean(v.email || v.phone), { message: "At least one of email or phone is required" });

/** GET /api/v1/tenants/:tenantId/projects/:projectId/suppression-list */
suppressionRouter.get("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const { limit, offset } = parsePagination(req);

    const result = await req.tenantDb!.query(
      `SELECT * FROM suppression_list WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.tenantId, limit, offset],
    );
    res.json({ suppressionEntries: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/suppression-list */
suppressionRouter.post("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = createSuppressionSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO suppression_list (tenant_id, email, phone, reason, channel, source_note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [req.tenantId, body.email ?? null, body.phone ?? null, body.reason ?? "manual", body.channel, body.sourceNote ?? null],
    );

    if (result.rowCount === 0) {
      throw Errors.conflict("An equivalent suppression entry already exists for this tenant/identifier/channel");
    }

    res.status(201).json({ suppressionEntry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/tenants/:tenantId/projects/:projectId/suppression-list/:id */
suppressionRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const id = z.string().uuid().parse(req.params.id);

    const result = await req.tenantDb!.query(
      `DELETE FROM suppression_list WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Suppression entry not found");

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Consent records
// ---------------------------------------------------------------------------

export const consentRecordsRouter = Router({ mergeParams: true });
consentRecordsRouter.use(requireAuth, requireTenantMembership);

const createConsentSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    channel: z.enum(["email", "whatsapp", "phone", "linkedin", "sms"]),
    consentGiven: z.boolean(),
    consentSource: z.enum([
      "explicit_optin",
      "public_widget_submission",
      "business_card",
      "referral",
      "imported_list",
      "other",
    ]),
    countryCode: z.string().trim().length(2).optional(),
    legalBasisNote: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Boolean(v.leadId || v.email || v.phone), {
    message: "At least one of leadId, email, or phone is required",
  });

/** GET /api/v1/tenants/:tenantId/projects/:projectId/consent-records */
consentRecordsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const { limit, offset } = parsePagination(req);
    const leadId = typeof req.query.leadId === "string" ? z.string().uuid().parse(req.query.leadId) : undefined;

    const result = await req.tenantDb!.query(
      `SELECT * FROM consent_records
       WHERE tenant_id = $1 AND ($2::uuid IS NULL OR lead_id = $2)
       ORDER BY recorded_at DESC
       LIMIT $3 OFFSET $4`,
      [req.tenantId, leadId ?? null, limit, offset],
    );
    res.json({ consentRecords: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/consent-records */
consentRecordsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = createConsentSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO consent_records (tenant_id, lead_id, email, phone, channel, consent_given, consent_source, country_code, legal_basis_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.tenantId,
        body.leadId ?? null,
        body.email ?? null,
        body.phone ?? null,
        body.channel,
        body.consentGiven,
        body.consentSource,
        body.countryCode ? body.countryCode.toUpperCase() : null,
        body.legalBasisNote ?? null,
      ],
    );

    res.status(201).json({ consentRecord: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Country send settings
// ---------------------------------------------------------------------------

export const countrySendSettingsRouter = Router({ mergeParams: true });
countrySendSettingsRouter.use(requireAuth, requireTenantMembership);

const upsertCountrySettingSchema = z.object({
  countryCode: z.string().trim().length(2),
  channel: z.enum(["email", "whatsapp", "phone", "sms"]),
  sendingAllowed: z.boolean().optional(),
  requiresExplicitConsent: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
});

const patchCountrySettingSchema = z.object({
  sendingAllowed: z.boolean().optional(),
  requiresExplicitConsent: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/country-send-settings */
countrySendSettingsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const { limit, offset } = parsePagination(req);

    const result = await req.tenantDb!.query(
      `SELECT * FROM country_send_settings WHERE tenant_id = $1 ORDER BY country_code ASC, channel ASC LIMIT $2 OFFSET $3`,
      [req.tenantId, limit, offset],
    );
    res.json({ countrySendSettings: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/country-send-settings (upserts one country+channel row) */
countrySendSettingsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = upsertCountrySettingSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO country_send_settings (tenant_id, country_code, channel, sending_allowed, requires_explicit_consent, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, country_code, channel)
       DO UPDATE SET
         sending_allowed = EXCLUDED.sending_allowed,
         requires_explicit_consent = EXCLUDED.requires_explicit_consent,
         note = EXCLUDED.note
       RETURNING *`,
      [
        req.tenantId,
        body.countryCode.toUpperCase(),
        body.channel,
        body.sendingAllowed ?? true,
        body.requiresExplicitConsent ?? false,
        body.note ?? null,
      ],
    );

    res.status(201).json({ countrySendSetting: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/tenants/:tenantId/projects/:projectId/country-send-settings/:id */
countrySendSettingsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const id = z.string().uuid().parse(req.params.id);
    const body = patchCountrySettingSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE country_send_settings
       SET sending_allowed = COALESCE($3, sending_allowed),
           requires_explicit_consent = COALESCE($4, requires_explicit_consent),
           note = COALESCE($5, note)
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, req.tenantId, body.sendingAllowed ?? null, body.requiresExplicitConsent ?? null, body.note ?? null],
    );
    if (result.rowCount === 0) throw Errors.notFound("Country send setting not found");

    res.json({ countrySendSetting: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Public unsubscribe endpoint
// ---------------------------------------------------------------------------

export const publicUnsubscribeRouter = Router();

const unsubscribeBodySchema = z.object({
  token: z.string().trim().min(1).max(2000),
});

/**
 * POST /api/v1/public/unsubscribe
 *
 * Unauthenticated-by-design, mirroring src/routes/publicLeads.ts: an
 * anonymous recipient clicking an unsubscribe link in an outbound message
 * has no session/JWT. Trust instead comes from a signed, opaque `token` —
 * NEVER a raw tenantId/email the client could supply directly — generated
 * by suppression.ts's generateUnsubscribeToken() when a future send
 * pipeline builds that message's unsubscribe link, and verified here via
 * verifyUnsubscribeToken() (HMAC-SHA256, server-side secret).
 *
 * No real send pipeline exists yet to have generated such tokens; this
 * endpoint and the generate/verify functions are built ahead of it so send
 * code has a ready-made, already-tested contract to call into.
 *
 * On a valid token, inserts a suppression_list row with reason
 * 'unsubscribed'. The token does not carry a channel (it is generated once
 * per message, not per channel), so this unsubscribes channel='all' for
 * that identifier — the conventional meaning of "unsubscribe" for an
 * end-user-facing link, as opposed to the fine-grained per-channel
 * suppression manual entries in the authenticated router above support.
 */
publicUnsubscribeRouter.post("/unsubscribe", async (req, res, next) => {
  const client = await pool.connect();
  let settled = false;
  try {
    const body = unsubscribeBodySchema.parse(req.body);
    const verified = verifyUnsubscribeToken(body.token);
    if (!verified) {
      client.release();
      settled = true;
      logger.warn("public unsubscribe rejected: invalid or tampered token");
      next(Errors.badRequest("Invalid or expired unsubscribe token"));
      return;
    }

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [verified.tenantId]);

    let email = verified.email;
    if (!email && verified.leadId) {
      const leadResult = await client.query<{ email: string | null }>(
        `SELECT email FROM leads WHERE id = $1 AND tenant_id = $2`,
        [verified.leadId, verified.tenantId],
      );
      if (leadResult.rowCount === 0) {
        await client.query("ROLLBACK");
        settled = true;
        client.release();
        next(Errors.notFound("Lead not found"));
        return;
      }
      email = leadResult.rows[0].email;
    }

    if (!email) {
      await client.query("ROLLBACK");
      settled = true;
      client.release();
      next(Errors.badRequest("Unsubscribe token has no resolvable email"));
      return;
    }

    await client.query(
      `INSERT INTO suppression_list (tenant_id, email, reason, channel, source_note)
       VALUES ($1, $2, 'unsubscribed', 'all', 'public unsubscribe link')
       ON CONFLICT DO NOTHING`,
      [verified.tenantId, email],
    );

    await client.query("COMMIT");
    settled = true;
    client.release();

    res.status(200).json({ unsubscribed: true });
  } catch (err) {
    if (!settled) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    next(err);
  }
});

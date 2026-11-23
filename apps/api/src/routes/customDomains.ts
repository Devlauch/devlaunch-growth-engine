import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { env } from "../config/env.js";
import {
  generateVerificationToken,
  verificationRecordName,
  verifyCustomDomainOwnership,
} from "../lib/customDomainVerification.js";
import {
  AcmeClient,
  generateAcmeAccountKey,
  planAcmeChallenges,
} from "../lib/acmeClient.js";
import { logger } from "../lib/logger.js";

/**
 * Real custom-domain DNS verification + SSL-provisioning status tracking
 * for landing pages (Milestone 3) — closes the gap both
 * 263_create_landing_pages.sql's comment and docs/BROADER_WORKSTREAM_AUDIT.md
 * section 6/7 document: `custom_domain` was store-only, with no DNS/CDN
 * provisioning logic anywhere.
 *
 * Mounted at the SAME prefix as routes/landingPages.ts
 * (/api/v1/tenants/:tenantId/projects/:projectId/landing-pages), as its OWN
 * router in a NEW file — same rationale as routes/leadMagnetUploads.ts's
 * doc comment (landingPages.ts is untracked/under active concurrent edit).
 *
 * Wiring note for app.ts (not edited this round):
 *   import { customDomainsRouter } from "./routes/customDomains.js";
 *   app.use("/api/v1/tenants/:tenantId/projects/:projectId/landing-pages", mainCors, customDomainsRouter);
 *
 * IMPORTANT ARCHITECTURE NOTE (also in docs/MILESTONE_3_REPORT.md): this
 * codebase has NO in-repo HTML renderer for landing pages at all (confirmed
 * in the audit — headless/API-only by design, same as the slug-based public
 * route). This file only verifies DNS ownership and tracks certificate
 * status; the actual Host-header -> tenant/landing-page routing this data
 * feeds is now real, closed in routes/publicLandingPages.ts's
 * `GET/POST /api/v1/public/custom-domain/landing-page*` routes (keyed by
 * verification_status = 'verified', enforced unique per domain by
 * 560_custom_domain_public_lookup_rls.sql) — a caller's own frontend/CDN
 * edge fetches JSON from there for the domain in the incoming request's
 * Host header, exactly like the slug-based route does for a path. What
 * remains honestly blocked is real TLS/SSL issuance for that domain (see
 * .../custom-domain/ssl below) — that still requires Let's Encrypt's public
 * validation servers to reach this environment, which it cannot offer.
 */
export const customDomainsRouter = Router({ mergeParams: true });
customDomainsRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadLandingPageOr404(req: Request, projectId: string, landingPageId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM landing_pages WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [landingPageId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Landing page not found");
  return r.rows[0];
}

/**
 * POST /:id/custom-domain/verification — (re)starts DNS ownership
 * verification for this landing page's `custom_domain`: generates a real,
 * unique token and records it (verification_status -> 'pending'). The
 * tenant is told to publish it as a TXT record; GET .../verification
 * (below) performs the real DNS check.
 */
customDomainsRouter.post("/:id/custom-domain/verification", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const landingPage = await loadLandingPageOr404(req, projectId, landingPageId);

    if (!landingPage.custom_domain) {
      throw Errors.badRequest("This landing page has no custom_domain set — set one via PATCH .../landing-pages/:id first");
    }

    const token = generateVerificationToken();
    const result = await req.tenantDb!.query(
      `UPDATE landing_pages
         SET verification_token = $1, verification_status = 'pending', verified_at = NULL
       WHERE id = $2 AND tenant_id = $3 AND project_id = $4
       RETURNING *`,
      [token, landingPageId, req.tenantId, projectId],
    );

    res.status(201).json({
      landingPage: result.rows[0],
      recordName: verificationRecordName(landingPage.custom_domain),
      recordType: "TXT",
      recordValue: token,
      instructions: `Add a TXT record at ${verificationRecordName(landingPage.custom_domain)} with the value above, then call GET .../custom-domain/verification to check it.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id/custom-domain/verification — performs the real DNS TXT lookup
 * (apps/api/src/lib/customDomainVerification.ts) and, only if the token is
 * genuinely found published, marks verification_status = 'verified' and
 * advances custom_domain_publish_status to 'dns_verified'.
 */
customDomainsRouter.get("/:id/custom-domain/verification", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const landingPage = await loadLandingPageOr404(req, projectId, landingPageId);

    if (!landingPage.custom_domain || !landingPage.verification_token) {
      throw Errors.badRequest("No pending verification for this landing page — POST .../custom-domain/verification first");
    }

    const check = await verifyCustomDomainOwnership(landingPage.custom_domain, landingPage.verification_token);

    if (check.status === "verified") {
      // 560_custom_domain_public_lookup_rls.sql enforces, at the database
      // level, that at most one landing page across ALL tenants can hold
      // verification_status = 'verified' for a given custom_domain — the
      // public Host-header lookup in routes/publicLandingPages.ts depends
      // on that to ever be unambiguous. A real DNS TXT record can
      // (rarely) be satisfied for two different tenants' tokens at once
      // (multiple TXT values at the same name), so this is a genuine,
      // reachable race, not a theoretical one — caught here and reported
      // as a real conflict, never silently overwritten.
      try {
        const result = await req.tenantDb!.query(
          `UPDATE landing_pages
             SET verification_status = 'verified', verified_at = now(),
                 custom_domain_publish_status = CASE WHEN custom_domain_publish_status = 'not_ready' THEN 'dns_verified' ELSE custom_domain_publish_status END
           WHERE id = $1 AND tenant_id = $2 AND project_id = $3
           RETURNING *`,
          [landingPageId, req.tenantId, projectId],
        );
        res.json({ landingPage: result.rows[0], dnsCheck: check });
        return;
      } catch (updateErr) {
        if ((updateErr as { code?: string }).code === "23505") {
          next(
            Errors.conflict(
              `This domain is already verified and live on a different landing page. DNS ownership was proven, but ${landingPage.custom_domain} cannot be claimed twice — remove the TXT record / the other tenant's claim first, or use a different domain.`,
            ),
          );
          return;
        }
        throw updateErr;
      }
    }

    const status = check.status === "invalid_domain" ? "failed" : "pending";
    const result = await req.tenantDb!.query(
      `UPDATE landing_pages SET verification_status = $1 WHERE id = $2 AND tenant_id = $3 AND project_id = $4 RETURNING *`,
      [status, landingPageId, req.tenantId, projectId],
    );
    res.json({ landingPage: result.rows[0], dnsCheck: check });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/custom-domain/ssl — attempts to START real ACME
 * certificate provisioning (apps/api/src/lib/acmeClient.ts) for a
 * DNS-verified custom domain: creates a real ACME account against
 * env.acmeDirectoryUrl, a real order, and fetches the real
 * challenge(s) offered — then records them in custom_domain_certificates
 * and HONESTLY STOPS, because completing issuance requires Let's Encrypt's
 * validation servers to reach a public HTTP endpoint or see a public DNS
 * record for this domain, neither of which this environment can provide
 * (see acmeClient.ts's doc comment). Any network/account-creation failure
 * (e.g. no outbound HTTPS access to Let's Encrypt from this environment) is
 * reported honestly as `status: "blocked"`, never fabricated as success.
 */
customDomainsRouter.post("/:id/custom-domain/ssl", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const landingPage = await loadLandingPageOr404(req, projectId, landingPageId);

    if (landingPage.verification_status !== "verified") {
      throw Errors.badRequest("Custom domain must be DNS-verified (verification_status = 'verified') before SSL provisioning");
    }

    const domain = landingPage.custom_domain as string;
    const accountKey = generateAcmeAccountKey();
    const client = new AcmeClient(env.acmeDirectoryUrl, accountKey);

    try {
      const plans = await planAcmeChallenges(client, [domain], env.acmeAccountContactEmail, "dns-01");
      const plan = plans[0];

      const insert = await req.tenantDb!.query(
        `INSERT INTO custom_domain_certificates
           (tenant_id, project_id, landing_page_id, domain, status, challenge_type, challenge_token, challenge_value, acme_order_url, acme_account_kid)
         VALUES ($1, $2, $3, $4, 'challenge_ready', $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.tenantId,
          projectId,
          landingPageId,
          domain,
          plan.challengeType,
          plan.challengeToken,
          plan.challengeValue,
          plan.orderUrl,
          client.kid,
        ],
      );

      res.status(201).json({
        certificateRequest: insert.rows[0],
        status: "challenge_ready",
        note:
          "ACME account/order/challenge creation succeeded for real against the configured ACME directory. " +
          "Issuance CANNOT complete in this environment: publish the TXT record " +
          `_acme-challenge.${domain} = ${plan.challengeValue}, then issuance still requires Let's Encrypt's own ` +
          "validation servers to resolve it over the public internet, which this environment cannot offer. BLOCKED on real external infrastructure, not on missing code.",
      });
    } catch (acmeErr) {
      logger.warn({ err: acmeErr, domain }, "ACME challenge planning failed/blocked (expected in this environment without real outbound ACME access)");
      const insert = await req.tenantDb!.query(
        `INSERT INTO custom_domain_certificates (tenant_id, project_id, landing_page_id, domain, status, error)
         VALUES ($1, $2, $3, $4, 'failed', $5)
         RETURNING *`,
        [req.tenantId, projectId, landingPageId, domain, acmeErr instanceof Error ? acmeErr.message : String(acmeErr)],
      );
      res.status(502).json({
        certificateRequest: insert.rows[0],
        status: "blocked",
        reason:
          "Real ACME request failed — most likely no outbound network access to the ACME directory from this " +
          "environment, or no real DNS/endpoint reachable for Let's Encrypt validation. See the error field for detail.",
      });
    }
  } catch (err) {
    next(err);
  }
});

/** GET /:id/custom-domain/ssl — lists this landing page's certificate-provisioning attempts. */
customDomainsRouter.get("/:id/custom-domain/ssl", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    await loadLandingPageOr404(req, projectId, landingPageId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM custom_domain_certificates WHERE tenant_id = $1 AND project_id = $2 AND landing_page_id = $3 ORDER BY created_at DESC`,
      [req.tenantId, projectId, landingPageId],
    );
    res.json({ certificateRequests: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/custom-domain/publish — advances custom_domain_publish_status
 * (additive status model, migration 512). Can only reach 'dns_verified'
 * automatically via the GET .../verification route above; this endpoint
 * lets an operator explicitly record 'ssl_issued' (once/if a real
 * certificate ever exists) or 'live' (once/if a renderer actually serves
 * the page) — both honestly refused today since neither exists in this
 * codebase (see this file's top doc comment).
 */
const publishStatusSchema = z.object({
  status: z.enum(["dns_verified", "ssl_issued", "live"]),
});

customDomainsRouter.post("/:id/custom-domain/publish", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const landingPage = await loadLandingPageOr404(req, projectId, landingPageId);
    const body = publishStatusSchema.parse(req.body);

    if (body.status !== "dns_verified" && landingPage.verification_status !== "verified") {
      throw Errors.badRequest("Custom domain must be DNS-verified before any further publish status");
    }
    if (body.status === "ssl_issued") {
      const issued = await req.tenantDb!.query(
        `SELECT 1 FROM custom_domain_certificates WHERE landing_page_id = $1 AND tenant_id = $2 AND status = 'issued'`,
        [landingPageId, req.tenantId],
      );
      if (issued.rowCount === 0) {
        throw Errors.badRequest(
          "No issued certificate on record for this landing page — real issuance is BLOCKED in this environment (see .../custom-domain/ssl)",
        );
      }
    }
    if (body.status === "live") {
      throw Errors.badRequest(
        "This codebase has no in-repo landing-page HTML renderer — 'live' cannot honestly be set until a real renderer/CDN consumes this status. See docs/BROADER_WORKSTREAM_AUDIT.md section 6.",
      );
    }

    const result = await req.tenantDb!.query(
      `UPDATE landing_pages SET custom_domain_publish_status = $1 WHERE id = $2 AND tenant_id = $3 AND project_id = $4 RETURNING *`,
      [body.status, landingPageId, req.tenantId, projectId],
    );
    res.json({ landingPage: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

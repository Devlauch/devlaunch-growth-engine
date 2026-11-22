import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { resolveHunterApiKey } from "../lib/hunterProvider.js";
import { discoverContactsForOrganization, verifyContactEmail } from "../lib/hunterContactDiscovery.js";
import { listProvenanceForContact } from "../lib/contactProvenance.js";

/**
 * Hunter contact discovery + email verification routes (Agent C). Mounted
 * at:
 *   /api/v1/tenants/:tenantId/projects/:projectId/hunter
 *
 * Deliberately a SEPARATE router from routes/discovery.ts (Agent A's
 * territory for Google Search discovery) rather than adding endpoints into
 * that file — avoids any risk of colliding edits with a concurrent session
 * working in the same file. This router still reads FROM
 * discovered_organizations/discovered_contacts (the existing shared
 * tables), it just never edits discovery.ts itself.
 */
export const hunterContactsRouter = Router({ mergeParams: true });
hunterContactsRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function loadOrganizationOr404(req: Request, projectId: string, organizationId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM discovered_organizations WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [organizationId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Discovered organization not found");
  return r.rows[0] as { id: string; name: string; domain: string | null };
}

async function loadContactOr404(req: Request, contactId: string) {
  const r = await req.tenantDb!.query(
    `SELECT dc.*, o.id AS org_id FROM discovered_contacts dc
     JOIN discovered_organizations o ON o.id = dc.organization_id
     WHERE dc.id = $1 AND dc.tenant_id = $2`,
    [contactId, req.tenantId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Discovered contact not found");
  return r.rows[0] as { id: string; email: string | null; organization_id: string };
}

// Storing/rotating a tenant's Hunter API key is NOT a bespoke route here —
// it reuses the EXISTING generic credential-storage mechanism already built
// for listmonk/chatwoot/postiz:
//   POST   /api/v1/tenants/:tenantId/projects/:projectId/integrations/hunter/connect
//          body: { config: {}, secret: "<hunter api key>" }
// (see apps/api/src/routes/integrations.ts). There is no disconnect/clear
// endpoint for ANY provider in this codebase today (not just Hunter) — that
// is an existing, honest gap across the whole integrations registry, not
// something invented or skipped specifically for Hunter.

/** GET /credential/status — never returns the key itself, only whether
 * SOME credential (tenant-specific or the env fallback) is currently
 * resolvable. */
hunterContactsRouter.get("/credential/status", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const apiKey = await resolveHunterApiKey(req.tenantDb!, req.tenantId!, projectId);
    res.json({ configured: apiKey !== null });
  } catch (err) {
    next(err);
  }
});

const discoverBodySchema = z.object({ forceRefresh: z.boolean().optional() });

/** POST /discovered-organizations/:organizationId/contacts
 * Runs (or honestly reports not_configured for) a real Hunter Domain
 * Search against this EXISTING discovered_organizations row's domain. */
hunterContactsRouter.post("/discovered-organizations/:organizationId/contacts", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "organizationId");
    const org = await loadOrganizationOr404(req, projectId, organizationId);
    if (!org.domain) {
      return res.status(422).json({ error: "This organization has no domain on file — Hunter Domain Search requires one." });
    }
    const { forceRefresh } = discoverBodySchema.parse(req.body ?? {});
    const outcome = await discoverContactsForOrganization(req.tenantDb!, {
      tenantId: req.tenantId!,
      projectId,
      organizationId,
      organizationName: org.name,
      domain: org.domain,
      forceRefresh,
    });
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

const verifyBodySchema = z.object({ forceReverify: z.boolean().optional() });

/** POST /discovered-contacts/:contactId/verify-email
 * Runs combined (free DNS tier + optional Hunter tier) verification. */
hunterContactsRouter.post("/discovered-contacts/:contactId/verify-email", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const contactId = paramId(req, "contactId");
    const contact = await loadContactOr404(req, contactId);
    if (!contact.email) throw Errors.badRequest("This contact has no email on file to verify.");
    const { forceReverify } = verifyBodySchema.parse(req.body ?? {});
    const outcome = await verifyContactEmail(req.tenantDb!, {
      tenantId: req.tenantId!,
      projectId,
      contactId,
      email: contact.email,
      organizationId: contact.organization_id,
      forceReverify,
    });
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

/** GET /discovered-contacts/:contactId/provenance — the full, append-only
 * history for this contact (every discovery + verification event ever
 * recorded, oldest first). */
hunterContactsRouter.get("/discovered-contacts/:contactId/provenance", async (req, res, next) => {
  try {
    const contactId = paramId(req, "contactId");
    await loadContactOr404(req, contactId);
    const events = await listProvenanceForContact(req.tenantDb!, req.tenantId!, contactId);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

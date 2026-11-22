import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { enforceQuota } from "../lib/quota.js";
import { verifyEmail } from "../lib/emailVerification.js";
import { normalizePhone } from "../lib/phoneVerification.js";
import { findDuplicateOrganization, findDuplicateContact, normalizeDomain, normalizeOrgName, normalizeEmail } from "../lib/dedup.js";
import {
  getConnector,
  UnsupportedIndustryError,
  type ConnectorConfig,
  type DiscoveredContact as ConnectorDiscoveredContact,
} from "@devlaunch/agent-sdk";
import { findDecisionMakers } from "../lib/decisionMakerProvider.js";
import { organizationsToCsv, contactsToCsv } from "../lib/prospectExport.js";

/**
 * Only 'public_directory' (backed by PublicDirectoryConnector /
 * OverpassDirectoryApiClient — a real, free, no-auth OpenStreetMap source,
 * see apps/worker/src/connectors/publicDirectoryConnector.ts, now re-homed
 * in packages/agent-sdk/src/connectors) is approved to actually run today.
 * 'website_crawl' (Crawl4AI) requires a separate, not-yet-approved Docker
 * service; 'csv_upload' and 'licensed_api' have no UI/route wiring yet.
 * Creating a source of any other connector_type is rejected outright
 * rather than accepted and left to fail confusingly at run time.
 */
const SUPPORTED_CONNECTOR_TYPES = ["public_directory"] as const;
/** The SourceConnector registry id the 'public_directory' connector_type maps to. */
const PUBLIC_DIRECTORY_CONNECTOR_ID = "public-directory";

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadOrganizationOr404(req: Request, organizationId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM discovered_organizations WHERE id = $1 AND tenant_id = $2`,
    [organizationId, req.tenantId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Discovered organization not found");
  return r.rows[0];
}

/**
 * Runs the decision-maker provider waterfall (decisionMakerProvider.ts) for
 * one organization and upserts the outcome into decision_maker_cache (one
 * row per organization — a fresh lookup replaces the prior cached one).
 * `findDecisionMakers` itself never throws (every honest failure mode is
 * caught internally and classified as part of the outcome), so this never
 * aborts a caller's larger flow (e.g. a discovery-source run persisting
 * several organizations) over a decision-maker lookup.
 */
async function lookupAndCacheDecisionMakers(
  req: Request,
  organizationId: string,
  organizationName: string,
  domain: string | null,
) {
  const outcome = await findDecisionMakers({ organizationName, domain });
  const result = await req.tenantDb!.query(
    `INSERT INTO decision_maker_cache (tenant_id, organization_id, provider, status, contacts, attempts, looked_up_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       status = EXCLUDED.status,
       contacts = EXCLUDED.contacts,
       attempts = EXCLUDED.attempts,
       looked_up_at = EXCLUDED.looked_up_at
     RETURNING *`,
    [
      req.tenantId,
      organizationId,
      outcome.provider,
      outcome.status,
      JSON.stringify(outcome.contacts),
      JSON.stringify(outcome.attempts),
    ],
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// discovery_sources
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/discovery-sources */
export const discoverySourcesRouter = Router({ mergeParams: true });
discoverySourcesRouter.use(requireAuth, requireTenantMembership);

const connectorTypeSchema = z.enum(["public_directory", "website_crawl", "csv_upload", "licensed_api"]);

const createDiscoverySourceSchema = z.object({
  connectorType: connectorTypeSchema,
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().positive().max(100000).optional(),
  termsNote: z.string().trim().max(2000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const runDiscoverySourceSchema = z.object({
  industry: z.string().trim().min(1).max(100).optional(),
  geography: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const updateDiscoverySourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    rateLimitPerMinute: z.number().int().positive().max(100000).optional(),
    termsNote: z.string().trim().max(2000).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET /discovery-sources */
discoverySourcesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM discovery_sources WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
      [req.tenantId, projectId],
    );
    res.json({ discoverySources: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /discovery-sources */
discoverySourcesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createDiscoverySourceSchema.parse(req.body);

    if (!(SUPPORTED_CONNECTOR_TYPES as readonly string[]).includes(body.connectorType)) {
      throw Errors.badRequest(
        `connectorType "${body.connectorType}" is not available to run yet — only ` +
          `${SUPPORTED_CONNECTOR_TYPES.join(", ")} is approved for use right now. ` +
          `(website_crawl requires a separate, not-yet-approved Crawl4AI service; ` +
          `csv_upload and licensed_api have no working connector wired up yet.)`,
      );
    }

    // Subscription-plan quota enforcement: a real COUNT(*) of the tenant's
    // discovery sources, checked before creating one more.
    await enforceQuota(req.tenantDb!, req.tenantId as string, "discoverySources");

    const result = await req.tenantDb!.query(
      `INSERT INTO discovery_sources (tenant_id, project_id, connector_type, name, enabled, rate_limit_per_minute, terms_note, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.connectorType,
        body.name,
        body.enabled ?? true,
        body.rateLimitPerMinute ?? 10,
        body.termsNote ?? null,
        JSON.stringify(body.config ?? {}),
      ],
    );

    res.status(201).json({ discoverySource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /discovery-sources/:id */
discoverySourcesRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const sourceId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const body = updateDiscoverySourceSchema.parse(req.body);

    const existing = await req.tenantDb!.query(
      `SELECT 1 FROM discovery_sources WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [sourceId, req.tenantId, projectId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Discovery source not found");

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) {
      fields.push(`name = $${++i}`);
      values.push(body.name);
    }
    if (body.enabled !== undefined) {
      fields.push(`enabled = $${++i}`);
      values.push(body.enabled);
    }
    if (body.rateLimitPerMinute !== undefined) {
      fields.push(`rate_limit_per_minute = $${++i}`);
      values.push(body.rateLimitPerMinute);
    }
    if (body.termsNote !== undefined) {
      fields.push(`terms_note = $${++i}`);
      values.push(body.termsNote);
    }
    if (body.config !== undefined) {
      fields.push(`config = $${++i}::jsonb`);
      values.push(JSON.stringify(body.config));
    }

    const result = await req.tenantDb!.query(
      `UPDATE discovery_sources SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      [sourceId, ...values],
    );

    res.json({ discoverySource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /discovery-sources/:id/run
 *
 * Looks up the source, invokes the real registered SourceConnector
 * (PublicDirectoryConnector, via the Overpass/OpenStreetMap API — the only
 * connector approved to actually run today, enforced both at creation time
 * above and defensively here), and persists whatever it genuinely found
 * into discovered_organizations (+ discovered_contacts, when the connector
 * surfaces any — PublicDirectoryConnector itself only ever returns
 * organization-level results). Duplicate organizations/contacts (by the
 * same dedup rules the manual-create routes use, backed by the DB's own
 * unique indexes as a last line of defense) are skipped rather than
 * erroring the whole run.
 */
discoverySourcesRouter.post("/:id/run", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const sourceId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);

    const sourceResult = await req.tenantDb!.query(
      `SELECT * FROM discovery_sources WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [sourceId, req.tenantId, projectId],
    );
    if (sourceResult.rowCount === 0) throw Errors.notFound("Discovery source not found");
    const source = sourceResult.rows[0];

    if (!(SUPPORTED_CONNECTOR_TYPES as readonly string[]).includes(source.connector_type)) {
      throw Errors.badRequest(
        `connector_type "${source.connector_type}" is not available to run yet — only ` +
          `${SUPPORTED_CONNECTOR_TYPES.join(", ")} is approved for use right now.`,
      );
    }
    if (!source.enabled) {
      throw Errors.conflict("This discovery source is disabled — enable it before running.");
    }

    const connector = getConnector(PUBLIC_DIRECTORY_CONNECTOR_ID);
    if (!connector) {
      // Should be unreachable (the connector is registered unconditionally
      // in packages/agent-sdk/src/connectors/registry.ts) — fail loudly
      // rather than silently no-op.
      throw Errors.internal(`Connector "${PUBLIC_DIRECTORY_CONNECTOR_ID}" is not registered`);
    }

    const overrides = runDiscoverySourceSchema.parse(req.body ?? {});
    const storedConfig = (source.config ?? {}) as Record<string, unknown>;
    const input = {
      industry: overrides.industry ?? storedConfig.industry,
      geography: overrides.geography ?? storedConfig.geography,
      limit: overrides.limit ?? storedConfig.limit,
    };

    const connectorConfig: ConnectorConfig = {
      rateLimitPerMinute: source.rate_limit_per_minute,
      enabled: source.enabled,
      termsNote: source.terms_note ?? connector.termsNote,
    };

    let discovery;
    try {
      discovery = await connector.discover(input, connectorConfig);
    } catch (err) {
      if (err instanceof UnsupportedIndustryError) {
        throw Errors.badRequest(err.message);
      }
      throw Errors.badGateway(
        `Discovery run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let organizationsCreated = 0;
    let organizationsDuplicate = 0;
    let contactsCreated = 0;
    let contactsDuplicate = 0;
    const persistedOrganizations: unknown[] = [];

    for (const org of discovery.organizations) {
      const duplicate = await findDuplicateOrganization(req.tenantDb!, projectId, {
        domain: org.domain,
        name: org.name,
      });

      let orgRow: Record<string, unknown>;
      if (duplicate) {
        organizationsDuplicate += 1;
        const existing = await req.tenantDb!.query(
          `SELECT * FROM discovered_organizations WHERE id = $1 AND tenant_id = $2`,
          [duplicate.id, req.tenantId],
        );
        orgRow = existing.rows[0];
      } else {
        const normalizedDomain = normalizeDomain(org.domain);
        const normalizedName = normalizeOrgName(org.name);
        const inserted = await req.tenantDb!.query(
          `INSERT INTO discovered_organizations
             (tenant_id, project_id, discovery_source_id, name, domain, normalized_domain, normalized_name, source_url, raw_metadata, discovered_at, source_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
           ON CONFLICT (tenant_id, project_id, normalized_domain) WHERE normalized_domain IS NOT NULL DO NOTHING
           RETURNING *`,
          [
            req.tenantId,
            projectId,
            sourceId,
            org.name,
            org.domain ?? null,
            normalizedDomain,
            normalizedName,
            org.sourceUrl,
            JSON.stringify(org.rawMetadata ?? {}),
            org.discoveredAt,
            // A connector-sourced row is a direct listing from the source
            // (the public_directory/Overpass connector today) — a stronger
            // signal than a human-entered manual-create row (which defaults
            // to 'unconfirmed', see POST /discovered-organizations below).
            "verified",
          ],
        );
        if (inserted.rowCount && inserted.rowCount > 0) {
          organizationsCreated += 1;
          orgRow = inserted.rows[0];
        } else {
          // Lost a race against a concurrent run inserting the same
          // domain — re-fetch the row that won instead of erroring.
          organizationsDuplicate += 1;
          const winner = await req.tenantDb!.query(
            `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3`,
            [req.tenantId, projectId, normalizedDomain],
          );
          orgRow = winner.rows[0];
        }
      }

      const orgContacts: ConnectorDiscoveredContact[] = discovery.contacts[org.name] ?? [];
      for (const contact of orgContacts) {
        const contactDuplicate = await findDuplicateContact(req.tenantDb!, orgRow.id as string, {
          email: contact.email,
          name: contact.name,
        });
        if (contactDuplicate) {
          contactsDuplicate += 1;
          continue;
        }

        const normalizedEmail = normalizeEmail(contact.email);
        const normalizedPhone = contact.phone ? normalizePhone(contact.phone) : null;
        let verificationStatus = "unverified";
        let emailVerification: Record<string, unknown> = {};
        if (contact.email) {
          const verification = await verifyEmail(contact.email);
          verificationStatus = verification.verificationStatus;
          emailVerification = verification as unknown as Record<string, unknown>;
        }

        const insertedContact = await req.tenantDb!.query(
          `INSERT INTO discovered_contacts
             (tenant_id, organization_id, name, role_title, email, normalized_email, phone, contact_channel, verification_status, email_verification, source_url, source_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
           ON CONFLICT (organization_id, normalized_email) WHERE normalized_email IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            req.tenantId,
            orgRow.id,
            contact.name ?? null,
            contact.roleTitle ?? null,
            contact.email ?? null,
            normalizedEmail,
            normalizedPhone ?? contact.phone ?? null,
            contact.contactChannel,
            verificationStatus,
            JSON.stringify(emailVerification),
            contact.sourceUrl ?? null,
            // Same reasoning as discovered_organizations above: a direct
            // connector-sourced contact.
            "verified",
          ],
        );
        if (insertedContact.rowCount && insertedContact.rowCount > 0) {
          contactsCreated += 1;
        } else {
          contactsDuplicate += 1;
        }
      }

      // Decision-maker search (feature: Advanced Prospect Discovery). Never
      // throws — see lookupAndCacheDecisionMakers — so one organization's
      // lookup outcome (today, always "not_configured": no licensed
      // decision-maker provider is wired up in this environment) can never
      // abort the rest of this run.
      const decisionMakerLookup = await lookupAndCacheDecisionMakers(
        req,
        orgRow.id as string,
        orgRow.name as string,
        (orgRow.domain as string | null) ?? null,
      );

      persistedOrganizations.push({ ...orgRow, decisionMakerLookup });
    }

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'discovery_source.run', 'discovery_source', $3, $4::jsonb)`,
      [
        req.tenantId,
        req.userId,
        sourceId,
        JSON.stringify({ organizationsFound: discovery.organizations.length, organizationsCreated, organizationsDuplicate }),
      ],
    );

    res.status(200).json({
      organizationsFound: discovery.organizations.length,
      organizationsCreated,
      organizationsDuplicate,
      contactsCreated,
      contactsDuplicate,
      organizations: persistedOrganizations,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// discovered_organizations (+ nested discovered_contacts)
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/discovered-organizations */
export const discoveredOrganizationsRouter = Router({ mergeParams: true });
discoveredOrganizationsRouter.use(requireAuth, requireTenantMembership);

const organizationStatusSchema = z.enum(["new", "researched", "duplicate", "archived"]);
/** How a discovered_organizations/discovered_contacts row's data was
 * obtained — see 268_add_prospect_discovery_fields.sql. */
const sourceConfidenceSchema = z.enum(["verified", "inferred", "unconfirmed"]);

const createDiscoveredOrganizationSchema = z.object({
  discoverySourceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(500),
  domain: z.string().trim().max(500).optional(),
  sourceUrl: z.string().trim().min(1).max(2000),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
  status: organizationStatusSchema.optional(),
  // A human entering this manually is asserting it's real, but it hasn't
  // been confirmed by any connector/provider — defaults to the
  // conservative 'unconfirmed' rather than 'verified'.
  sourceConfidence: sourceConfidenceSchema.optional(),
});

const listDiscoveredOrganizationsQuerySchema = z.object({
  status: organizationStatusSchema.optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

/** GET /discovered-organizations */
discoveredOrganizationsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = listDiscoveredOrganizationsQuerySchema.parse(req.query);

    const conditions = ["o.tenant_id = $1", "o.project_id = $2"];
    const values: unknown[] = [req.tenantId, projectId];
    if (query.status) {
      values.push(query.status);
      conditions.push(`o.status = $${values.length}`);
    }

    const limit = query.pageSize;
    const offset = (query.page - 1) * query.pageSize;
    values.push(limit, offset);

    // Embeds each organization's contacts directly (coalesced to '[]' for
    // orgs with none) so the dashboard's list view doesn't need N follow-up
    // requests to /:id/contacts.
    const result = await req.tenantDb!.query(
      `SELECT o.*,
              COALESCE(
                (SELECT json_agg(c.* ORDER BY c.created_at ASC)
                 FROM discovered_contacts c
                 WHERE c.organization_id = o.id AND c.tenant_id = o.tenant_id),
                '[]'::json
              ) AS contacts
       FROM discovered_organizations o
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.discovered_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    res.json({
      discoveredOrganizations: result.rows,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    next(err);
  }
});

const exportQuerySchema = z.object({
  format: z.enum(["csv"]),
  type: z.enum(["organizations", "contacts"]).optional().default("organizations"),
  status: organizationStatusSchema.optional(),
});

/**
 * GET /discovered-organizations/export?format=csv[&type=organizations|contacts][&status=...]
 *
 * Produces a real CSV (RFC-4180-ish — see prospectExport.ts) of this
 * project's discovered prospects: either one row per organization
 * (default) or, with `type=contacts`, one row per contact (joined back to
 * its organization for context). `status` optionally restricts to one
 * discovered_organizations.status (e.g. `status=researched` for prospects
 * already promoted). Every column comes straight from the DB row — no
 * synthesized/estimated fields.
 */
discoveredOrganizationsRouter.get("/export", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = exportQuerySchema.parse(req.query);

    if (query.type === "contacts") {
      const conditions = ["c.tenant_id = $1", "o.project_id = $2"];
      const values: unknown[] = [req.tenantId, projectId];
      if (query.status) {
        values.push(query.status);
        conditions.push(`o.status = $${values.length}`);
      }
      const result = await req.tenantDb!.query(
        `SELECT o.name AS organization_name, o.domain AS organization_domain,
                c.name, c.role_title, c.email, c.phone, c.contact_channel,
                c.verification_status, c.source_confidence
         FROM discovered_contacts c
         JOIN discovered_organizations o ON o.id = c.organization_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY c.created_at ASC`,
        values,
      );
      const csv = contactsToCsv(result.rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="discovered-contacts-${projectId}.csv"`);
      res.status(200).send(csv);
      return;
    }

    const conditions = ["tenant_id = $1", "project_id = $2"];
    const values: unknown[] = [req.tenantId, projectId];
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    const result = await req.tenantDb!.query(
      `SELECT name, domain, status, source_confidence, discovered_at, source_url
       FROM discovered_organizations
       WHERE ${conditions.join(" AND ")}
       ORDER BY discovered_at ASC`,
      values,
    );
    const csv = organizationsToCsv(result.rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="discovered-organizations-${projectId}.csv"`);
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
});

/** POST /discovered-organizations */
discoveredOrganizationsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createDiscoveredOrganizationSchema.parse(req.body);

    const duplicate = await findDuplicateOrganization(req.tenantDb!, projectId, {
      domain: body.domain,
      name: body.name,
    });
    if (duplicate) {
      res.status(200).json({ organization: duplicate, duplicate: true });
      return;
    }

    if (body.discoverySourceId) {
      const sourceExists = await req.tenantDb!.query(
        `SELECT 1 FROM discovery_sources WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
        [body.discoverySourceId, req.tenantId, projectId],
      );
      if (sourceExists.rowCount === 0) throw Errors.badRequest("discoverySourceId does not belong to this project");
    }

    const normalizedDomain = normalizeDomain(body.domain);
    const normalizedName = normalizeOrgName(body.name);

    const result = await req.tenantDb!.query(
      `INSERT INTO discovered_organizations
         (tenant_id, project_id, discovery_source_id, name, domain, normalized_domain, normalized_name, source_url, raw_metadata, status, source_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.discoverySourceId ?? null,
        body.name,
        body.domain ?? null,
        normalizedDomain,
        normalizedName,
        body.sourceUrl,
        JSON.stringify(body.rawMetadata ?? {}),
        body.status ?? "new",
        body.sourceConfidence ?? "unconfirmed",
      ],
    );

    res.status(201).json({ organization: result.rows[0], duplicate: false });
  } catch (err) {
    next(err);
  }
});

/** GET /discovered-organizations/:id/contacts */
discoveredOrganizationsRouter.get("/:id/contacts", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const organization = await loadOrganizationOr404(req, organizationId);
    if (organization.project_id !== projectId) throw Errors.notFound("Discovered organization not found");

    const result = await req.tenantDb!.query(
      `SELECT * FROM discovered_contacts WHERE organization_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [organizationId, req.tenantId],
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /discovered-organizations/:id/decision-makers
 *
 * Runs the decision-maker provider waterfall (decisionMakerProvider.ts)
 * fresh against this organization and upserts the result into
 * decision_maker_cache, returning the outcome. Useful both for re-running a
 * lookup on demand (e.g. a dashboard "Find decision-makers" button) and for
 * organizations created outside the discovery-source /run flow (e.g. the
 * manual-create route above), which never got an automatic lookup.
 */
discoveredOrganizationsRouter.post("/:id/decision-makers", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const organization = await loadOrganizationOr404(req, organizationId);
    if (organization.project_id !== projectId) throw Errors.notFound("Discovered organization not found");

    const cacheRow = await lookupAndCacheDecisionMakers(
      req,
      organizationId,
      organization.name as string,
      (organization.domain as string | null) ?? null,
    );

    res.status(200).json({ decisionMakerLookup: cacheRow });
  } catch (err) {
    next(err);
  }
});

const contactChannelSchema = z.enum(["role_based", "named_person", "contact_form", "phone"]);

const createDiscoveredContactSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    roleTitle: z.string().trim().max(300).optional(),
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(50).optional(),
    contactChannel: contactChannelSchema,
    sourceUrl: z.string().trim().max(2000).optional(),
    sourceConfidence: sourceConfidenceSchema.optional(),
  })
  .refine((body) => Boolean(body.email || body.phone || body.name), {
    message: "At least one of email, phone, or name is required",
  });

/** POST /discovered-organizations/:id/contacts */
discoveredOrganizationsRouter.post("/:id/contacts", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const organization = await loadOrganizationOr404(req, organizationId);
    if (organization.project_id !== projectId) throw Errors.notFound("Discovered organization not found");

    const body = createDiscoveredContactSchema.parse(req.body);

    const duplicate = await findDuplicateContact(req.tenantDb!, organizationId, {
      email: body.email,
      name: body.name,
    });
    if (duplicate) {
      res.status(200).json({ contact: duplicate, duplicate: true });
      return;
    }

    const normalizedEmail = normalizeEmail(body.email);
    const normalizedPhone = body.phone ? normalizePhone(body.phone) : null;

    let verificationStatus = "unverified";
    let emailVerification: Record<string, unknown> = {};
    if (body.email) {
      const verification = await verifyEmail(body.email);
      verificationStatus = verification.verificationStatus;
      emailVerification = verification as unknown as Record<string, unknown>;
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO discovered_contacts
         (tenant_id, organization_id, name, role_title, email, normalized_email, phone, contact_channel, verification_status, email_verification, source_url, source_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING *`,
      [
        req.tenantId,
        organizationId,
        body.name ?? null,
        body.roleTitle ?? null,
        body.email ?? null,
        normalizedEmail,
        normalizedPhone ?? body.phone ?? null,
        body.contactChannel,
        verificationStatus,
        JSON.stringify(emailVerification),
        body.sourceUrl ?? null,
        body.sourceConfidence ?? "unconfirmed",
      ],
    );

    res.status(201).json({ contact: result.rows[0], duplicate: false });
  } catch (err) {
    next(err);
  }
});

/** POST /discovered-organizations/:id/contacts/:contactId/verify */
discoveredOrganizationsRouter.post("/:id/contacts/:contactId/verify", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "id");
    const contactId = paramId(req, "contactId");
    await assertProjectInTenant(req, projectId);
    const organization = await loadOrganizationOr404(req, organizationId);
    if (organization.project_id !== projectId) throw Errors.notFound("Discovered organization not found");

    const contactResult = await req.tenantDb!.query(
      `SELECT * FROM discovered_contacts WHERE id = $1 AND organization_id = $2 AND tenant_id = $3`,
      [contactId, organizationId, req.tenantId],
    );
    if (contactResult.rowCount === 0) throw Errors.notFound("Discovered contact not found");
    const contact = contactResult.rows[0];

    if (!contact.email) {
      throw Errors.badRequest("Contact has no email to verify");
    }

    const verification = await verifyEmail(contact.email);

    const result = await req.tenantDb!.query(
      `UPDATE discovered_contacts
       SET verification_status = $1, email_verification = $2::jsonb
       WHERE id = $3
       RETURNING *`,
      [verification.verificationStatus, JSON.stringify(verification), contactId],
    );

    res.json({ contact: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const promoteToLeadSchema = z.object({
  discoveredContactId: z.string().uuid().optional(),
});

/**
 * Ranks discovered_contacts rows so "the best available contact" picks a
 * verified, named person over a role inbox over a contact-form-only org
 * over a bare phone number, newest-verified-first as a tiebreak. Exported
 * for unit testing without a DB round-trip.
 */
export function rankContactsForPromotion<
  T extends { verification_status: string; contact_channel: string; created_at: string | Date },
>(contacts: T[]): T[] {
  const verificationRank: Record<string, number> = { verified: 0, unverified: 1, role_based: 2, risky: 3, invalid: 4 };
  const channelRank: Record<string, number> = { named_person: 0, role_based: 1, contact_form: 2, phone: 3 };
  return [...contacts].sort((a, b) => {
    const v = (verificationRank[a.verification_status] ?? 9) - (verificationRank[b.verification_status] ?? 9);
    if (v !== 0) return v;
    const c = (channelRank[a.contact_channel] ?? 9) - (channelRank[b.contact_channel] ?? 9);
    if (c !== 0) return c;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/**
 * POST /discovered-organizations/:id/promote-to-lead
 *
 * Creates a real row in the existing `leads` table (packages/db/migrations
 * 015_create_leads.sql / 030_add_discovery_lead_source.sql) from a
 * discovered organization + its best available contact, source='discovery',
 * and a real audit_events row — then marks the discovered_organizations row
 * 'researched' so the same organization can't be silently double-promoted.
 */
discoveredOrganizationsRouter.post("/:id/promote-to-lead", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const organizationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const organization = await loadOrganizationOr404(req, organizationId);
    if (organization.project_id !== projectId) throw Errors.notFound("Discovered organization not found");

    if (organization.status !== "new") {
      throw Errors.conflict(
        `This organization has already been ${organization.status === "researched" ? "promoted to a lead" : organization.status} — it can only be promoted from status "new".`,
      );
    }

    const body = promoteToLeadSchema.parse(req.body ?? {});

    let contact: Record<string, unknown> | null = null;
    if (body.discoveredContactId) {
      const specific = await req.tenantDb!.query(
        `SELECT * FROM discovered_contacts WHERE id = $1 AND organization_id = $2 AND tenant_id = $3`,
        [body.discoveredContactId, organizationId, req.tenantId],
      );
      if (specific.rowCount === 0) throw Errors.badRequest("discoveredContactId does not belong to this organization");
      contact = specific.rows[0];
    } else {
      const contactsResult = await req.tenantDb!.query(
        `SELECT * FROM discovered_contacts WHERE organization_id = $1 AND tenant_id = $2`,
        [organizationId, req.tenantId],
      );
      const ranked = rankContactsForPromotion(
        contactsResult.rows as { verification_status: string; contact_channel: string; created_at: string }[],
      );
      contact = ranked[0] ?? null;
    }

    const leadName = (contact?.name as string | undefined) ?? organization.name;
    const leadEmail = (contact?.email as string | undefined) ?? null;

    const leadResult = await req.tenantDb!.query(
      `INSERT INTO leads (tenant_id, project_id, name, email, company, message, custom_fields, source, status, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'discovery', 'new', $8)
       RETURNING id, tenant_id, project_id, name, email, company, message, custom_fields, source, status, origin, created_at`,
      [
        req.tenantId,
        projectId,
        leadName,
        leadEmail,
        organization.domain ?? organization.name,
        contact?.role_title ? `Role: ${contact.role_title}` : null,
        JSON.stringify({
          discoveredOrganizationId: organizationId,
          discoveredContactId: contact?.id ?? null,
          discoverySourceId: organization.discovery_source_id ?? null,
          sourceUrl: organization.source_url,
        }),
        organization.source_url,
      ],
    );
    const lead = leadResult.rows[0];

    const updatedOrg = await req.tenantDb!.query(
      `UPDATE discovered_organizations SET status = 'researched' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [organizationId, req.tenantId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'lead.promoted_from_discovery', 'lead', $3, $4::jsonb)`,
      [
        req.tenantId,
        req.userId,
        lead.id,
        JSON.stringify({ discoveredOrganizationId: organizationId, discoveredContactId: contact?.id ?? null }),
      ],
    );

    res.status(201).json({ lead, organization: updatedOrg.rows[0] });
  } catch (err) {
    next(err);
  }
});

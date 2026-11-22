/**
 * Shared discovery-run machinery: building a waterfall of configured
 * discovery_sources (public_directory/Overpass today — see
 * SUPPORTED_CONNECTOR_TYPES below, kept identical to routes/discovery.ts's
 * own allowlist) and persisting whatever a connector genuinely found into
 * discovered_organizations/discovered_contacts.
 *
 * This is the generalization Milestone 3 Phase 2 asked for: previously
 * routes/discovery.ts's POST /discovery-sources/:id/run only ever invoked
 * ONE connector (whatever that one source's connector_type said), with no
 * fallback. This module reuses the EXISTING generic
 * providerWaterfall.ts#runProviderWaterfall (the same orchestrator
 * decisionMakerProvider.ts already uses for decision-maker lookups) to try
 * several configured discovery_sources, in priority order, and record which
 * one actually answered — rather than building a second, parallel waterfall
 * implementation.
 *
 * Both the single-source POST /:id/run endpoint (routes/discovery.ts,
 * unchanged call shape/tests) and the new multi-source POST
 * /discovery-sources/run endpoint, plus prospectingCampaigns.ts's "start
 * run" action, all funnel through persistDiscoveryResult below, so there is
 * exactly one place that decides how a connector's raw
 * ConnectorDiscoveryResult becomes real discovered_organizations /
 * discovered_contacts / decision_maker_cache rows.
 */

import type pg from "pg";
import {
  getConnector,
  UnsupportedIndustryError,
  type ConnectorConfig,
  type ConnectorDiscoveryResult,
  type DiscoveredContact as ConnectorDiscoveredContact,
} from "@devlaunch/agent-sdk";
import { runProviderWaterfall, type WaterfallProvider, type WaterfallAttempt } from "./providerWaterfall.js";
import { verifyEmail } from "./emailVerification.js";
import { normalizePhone } from "./phoneVerification.js";
import { findDuplicateOrganization, findDuplicateContact, normalizeDomain, normalizeOrgName, normalizeEmail } from "./dedup.js";
import { findDecisionMakers } from "./decisionMakerProvider.js";

/**
 * Only 'public_directory' (PublicDirectoryConnector / Overpass) is approved
 * to actually run today — kept identical to routes/discovery.ts's own
 * SUPPORTED_CONNECTOR_TYPES so both single- and multi-source runs reject the
 * same unsupported connector types the same way. 'csv_upload' has a real,
 * working connector (packages/agent-sdk/src/connectors/csvConnector.ts) but
 * takes a fundamentally different input shape (an uploaded CSV file, not an
 * industry/geography search) and has no upload UI/route wiring yet — not
 * folded into this waterfall to avoid silently treating "no CSV supplied" as
 * an honest "no result" when it's actually a caller error. See
 * docs/FEATURE_STATUS.md's punch list item 1.
 */
export const SUPPORTED_CONNECTOR_TYPES = ["public_directory"] as const;

const CONNECTOR_ID_BY_TYPE: Record<string, string> = {
  public_directory: "public-directory",
};

export interface DiscoverySourceRow {
  id: string;
  connector_type: string;
  name: string;
  enabled: boolean;
  rate_limit_per_minute: number;
  terms_note: string | null;
  config: Record<string, unknown> | null;
}

export interface DiscoveryRunInput {
  industry?: string;
  geography?: string;
  limit?: number;
}

/** Thrown by a source's provider.run() when the source itself can't be used
 * (disabled, unsupported connector_type, connector not registered) — the
 * waterfall records this as an "error" attempt and moves on to the next
 * configured source rather than aborting the whole run. */
export class DiscoverySourceUnavailableError extends Error {}

export interface SourceDiscoveryResult extends ConnectorDiscoveryResult {
  /** Which discovery_sources row actually produced this result — the
   * waterfall's `answeredBy` is the human-readable source name; this is the
   * stable id persistDiscoveryResult needs to tag created rows with. */
  sourceId: string;
}

/**
 * Builds one WaterfallProvider per configured discovery_sources row, each
 * invoking its real registered SourceConnector with `overrides` merged over
 * the source's own stored config (overrides win — same precedence the
 * existing single-source /:id/run endpoint already uses). A source that's
 * disabled, has an unsupported connector_type, or has no registered
 * connector throws DiscoverySourceUnavailableError, which the waterfall
 * records as an error attempt rather than letting it abort the whole run —
 * exactly the "a provider that throws doesn't take down the whole lookup"
 * contract runProviderWaterfall already documents.
 */
export function buildDiscoveryWaterfallProviders(
  sources: DiscoverySourceRow[],
  overrides: DiscoveryRunInput,
): WaterfallProvider<DiscoveryRunInput, SourceDiscoveryResult>[] {
  return sources.map((source) => ({
    name: source.name,
    async run(_input: DiscoveryRunInput): Promise<SourceDiscoveryResult> {
      if (!source.enabled) {
        throw new DiscoverySourceUnavailableError(`Discovery source "${source.name}" is disabled`);
      }
      if (!(SUPPORTED_CONNECTOR_TYPES as readonly string[]).includes(source.connector_type)) {
        throw new DiscoverySourceUnavailableError(
          `connector_type "${source.connector_type}" is not available to run yet — only ` +
            `${SUPPORTED_CONNECTOR_TYPES.join(", ")} is approved for use right now.`,
        );
      }
      const connectorId = CONNECTOR_ID_BY_TYPE[source.connector_type];
      const connector = connectorId ? getConnector(connectorId) : undefined;
      if (!connector) {
        throw new DiscoverySourceUnavailableError(`Connector for "${source.connector_type}" is not registered`);
      }

      const storedConfig = source.config ?? {};
      const resolvedInput = {
        industry: overrides.industry ?? (storedConfig.industry as string | undefined),
        geography: overrides.geography ?? (storedConfig.geography as string | undefined),
        limit: overrides.limit ?? (storedConfig.limit as number | undefined),
      };
      const connectorConfig: ConnectorConfig = {
        rateLimitPerMinute: source.rate_limit_per_minute,
        enabled: source.enabled,
        termsNote: source.terms_note ?? connector.termsNote,
      };

      try {
        const discovery = await connector.discover(resolvedInput, connectorConfig);
        return { ...discovery, sourceId: source.id };
      } catch (err) {
        if (err instanceof UnsupportedIndustryError) throw err;
        throw err;
      }
    },
  }));
}

/** A SourceDiscoveryResult with zero organizations counts as "no result" for
 * waterfall purposes (same semantics as the default isEmpty, made explicit
 * here since SourceDiscoveryResult is an object, not an array). */
function isEmptyDiscoveryResult(result: SourceDiscoveryResult): boolean {
  return result.organizations.length === 0;
}

export interface DiscoveryWaterfallOutcome {
  result: SourceDiscoveryResult | null;
  /** The discovery_sources.id that actually answered, or null if every
   * configured source was tried (or errored/disabled) without a result. */
  answeredBySourceId: string | null;
  /** Human-readable name of the source that answered, for display/audit. */
  answeredBySourceName: string | null;
  attempts: WaterfallAttempt[];
}

/**
 * Runs the real generic waterfall (providerWaterfall.ts#runProviderWaterfall
 * — not a second implementation) across `sources`, in the order given (the
 * caller is responsible for ordering them, e.g. by
 * prospecting_campaign_sources.priority). Never throws for a bad-practice
 * reason like one source being disabled or unsupported — those are errors
 * recorded per-attempt (see buildDiscoveryWaterfallProviders), so a single
 * misconfigured source can't take down an otherwise-working multi-source
 * run.
 */
export async function runDiscoveryWaterfall(
  sources: DiscoverySourceRow[],
  overrides: DiscoveryRunInput,
): Promise<DiscoveryWaterfallOutcome> {
  const providers = buildDiscoveryWaterfallProviders(sources, overrides);
  const outcome = await runProviderWaterfall(providers, overrides, { isEmpty: isEmptyDiscoveryResult });
  return {
    result: outcome.result,
    answeredBySourceId: outcome.result?.sourceId ?? null,
    answeredBySourceName: outcome.answeredBy,
    attempts: outcome.attempts,
  };
}

/**
 * Runs the decision-maker provider waterfall (decisionMakerProvider.ts) for
 * one organization and upserts the outcome into decision_maker_cache (one
 * row per organization — a fresh lookup replaces the prior cached one).
 * `findDecisionMakers` itself never throws, so this never aborts a caller's
 * larger persistence loop over a decision-maker lookup.
 */
export async function lookupAndCacheDecisionMakers(
  tenantDb: pg.PoolClient,
  tenantId: string,
  organizationId: string,
  organizationName: string,
  domain: string | null,
) {
  const outcome = await findDecisionMakers({ organizationName, domain });
  const result = await tenantDb.query(
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
      tenantId,
      organizationId,
      outcome.provider,
      outcome.status,
      JSON.stringify(outcome.contacts),
      JSON.stringify(outcome.attempts),
    ],
  );
  return result.rows[0];
}

export interface PersistDiscoveryResultOutcome {
  organizationsFound: number;
  organizationsCreated: number;
  organizationsDuplicate: number;
  contactsCreated: number;
  contactsDuplicate: number;
  organizations: Record<string, unknown>[];
}

/**
 * Persists one connector's ConnectorDiscoveryResult into
 * discovered_organizations (+ discovered_contacts, when present) — the same
 * dedup-first, insert-or-reuse logic routes/discovery.ts's single-source
 * POST /:id/run has always used, extracted here so the new multi-source
 * waterfall run and prospectingCampaigns.ts's "start run" action don't
 * duplicate it. `prospectingCampaignId`, when supplied, tags every newly
 * inserted discovered_organizations row so a campaign's results summary can
 * be computed from real rows later (see prospectingCampaigns.ts) — a
 * duplicate organization that already existed under a different (or no)
 * campaign is left untouched, not silently re-tagged.
 */
export async function persistDiscoveryResult(
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
  discoverySourceId: string,
  discovery: ConnectorDiscoveryResult,
  opts?: { prospectingCampaignId?: string | null },
): Promise<PersistDiscoveryResultOutcome> {
  const prospectingCampaignId = opts?.prospectingCampaignId ?? null;

  let organizationsCreated = 0;
  let organizationsDuplicate = 0;
  let contactsCreated = 0;
  let contactsDuplicate = 0;
  const persistedOrganizations: Record<string, unknown>[] = [];

  for (const org of discovery.organizations) {
    const duplicate = await findDuplicateOrganization(tenantDb, projectId, {
      domain: org.domain,
      name: org.name,
    });

    let orgRow: Record<string, unknown>;
    if (duplicate) {
      organizationsDuplicate += 1;
      const existing = await tenantDb.query(
        `SELECT * FROM discovered_organizations WHERE id = $1 AND tenant_id = $2`,
        [duplicate.id, tenantId],
      );
      orgRow = existing.rows[0];
    } else {
      const normalizedDomain = normalizeDomain(org.domain);
      const normalizedName = normalizeOrgName(org.name);
      const inserted = await tenantDb.query(
        `INSERT INTO discovered_organizations
           (tenant_id, project_id, discovery_source_id, name, domain, normalized_domain, normalized_name, source_url, raw_metadata, discovered_at, source_confidence, prospecting_campaign_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (tenant_id, project_id, normalized_domain) WHERE normalized_domain IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          tenantId,
          projectId,
          discoverySourceId,
          org.name,
          org.domain ?? null,
          normalizedDomain,
          normalizedName,
          org.sourceUrl,
          JSON.stringify(org.rawMetadata ?? {}),
          org.discoveredAt,
          // A connector-sourced row is a direct listing from the source — a
          // stronger signal than a human-entered manual-create row (which
          // defaults to 'unconfirmed').
          "verified",
          prospectingCampaignId,
        ],
      );
      if (inserted.rowCount && inserted.rowCount > 0) {
        organizationsCreated += 1;
        orgRow = inserted.rows[0];
      } else {
        // Lost a race against a concurrent run inserting the same domain —
        // re-fetch the row that won instead of erroring.
        organizationsDuplicate += 1;
        const winner = await tenantDb.query(
          `SELECT * FROM discovered_organizations WHERE tenant_id = $1 AND project_id = $2 AND normalized_domain = $3`,
          [tenantId, projectId, normalizedDomain],
        );
        orgRow = winner.rows[0];
      }
    }

    const orgContacts: ConnectorDiscoveredContact[] = discovery.contacts[org.name] ?? [];
    for (const contact of orgContacts) {
      const contactDuplicate = await findDuplicateContact(tenantDb, orgRow.id as string, {
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

      const insertedContact = await tenantDb.query(
        `INSERT INTO discovered_contacts
           (tenant_id, organization_id, name, role_title, email, normalized_email, phone, contact_channel, verification_status, email_verification, source_url, source_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         ON CONFLICT (organization_id, normalized_email) WHERE normalized_email IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          tenantId,
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
          "verified",
        ],
      );
      if (insertedContact.rowCount && insertedContact.rowCount > 0) {
        contactsCreated += 1;
      } else {
        contactsDuplicate += 1;
      }
    }

    const decisionMakerLookup = await lookupAndCacheDecisionMakers(
      tenantDb,
      tenantId,
      orgRow.id as string,
      orgRow.name as string,
      (orgRow.domain as string | null) ?? null,
    );

    persistedOrganizations.push({ ...orgRow, decisionMakerLookup });
  }

  return {
    organizationsFound: discovery.organizations.length,
    organizationsCreated,
    organizationsDuplicate,
    contactsCreated,
    contactsDuplicate,
    organizations: persistedOrganizations,
  };
}

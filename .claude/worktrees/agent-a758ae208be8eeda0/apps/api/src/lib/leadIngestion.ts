import type { PoolClient } from "pg";
import { z } from "zod";
import { recordUsageEvent } from "./usageEvents.js";

/**
 * The single lead-ingestion path. Used by BOTH:
 *   - internal/authenticated lead creation (not wired to a dedicated route
 *     in Phase 1, but available for agents/future routes to call), and
 *   - the public, unauthenticated-by-design widget endpoint
 *     (src/routes/publicLeads.ts).
 *
 * The two differ only in how the caller is authenticated and in `source`;
 * the actual write — and therefore the tenant isolation it goes through
 * (the caller must already have set app.current_tenant_id on `client`,
 * exactly like any other tenant-scoped write) — is identical.
 */
// Roadmap item 6 ("Inbound lead capture"): UTM/source tracking + the one
// qualifying question answer, captured by packages/embed-widget/embed.js.
// This is an unauthenticated public endpoint's input (see
// src/routes/publicLeads.ts), so every new field is an optional string
// with a conservative max length to prevent abuse — none of them are
// trusted/parsed beyond that.
const widgetTrackingFieldSchema = z.string().trim().max(500).optional();

export const leadInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().max(5000).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  utmSource: widgetTrackingFieldSchema,
  utmMedium: widgetTrackingFieldSchema,
  utmCampaign: widgetTrackingFieldSchema,
  utmTerm: widgetTrackingFieldSchema,
  utmContent: widgetTrackingFieldSchema,
  referrerUrl: widgetTrackingFieldSchema,
  qualifyingAnswer: widgetTrackingFieldSchema,
}).refine((v) => Boolean(v.name || v.email), {
  message: "At least one of name or email is required",
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export type LeadSource = "internal" | "public_widget" | "agent" | "import";

export interface IngestLeadParams {
  client: PoolClient;
  tenantId: string;
  projectId: string;
  input: LeadInput;
  source: LeadSource;
  origin?: string | null;
  ipHash?: string | null;
}

export interface IngestedLead {
  id: string;
  createdAt: string;
}

export async function ingestLead(params: IngestLeadParams): Promise<IngestedLead> {
  const { client, tenantId, projectId, input, source, origin, ipHash } = params;

  const result = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO leads (
       tenant_id, project_id, name, email, company, message, custom_fields, source, origin, ip_hash,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer_url, qualifying_answer
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id, created_at`,
    [
      tenantId,
      projectId,
      input.name ?? null,
      input.email ?? null,
      input.company ?? null,
      input.message ?? null,
      JSON.stringify(input.customFields ?? {}),
      source,
      origin ?? null,
      ipHash ?? null,
      input.utmSource ?? null,
      input.utmMedium ?? null,
      input.utmCampaign ?? null,
      input.utmTerm ?? null,
      input.utmContent ?? null,
      input.referrerUrl ?? null,
      input.qualifyingAnswer ?? null,
    ],
  );

  const row = result.rows[0];

  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, entity_id, metadata)
     VALUES ($1, 'system', 'lead.created', 'lead', $2, $3::jsonb)`,
    [
      tenantId,
      row.id,
      JSON.stringify({ source: source === "public_widget" ? "public_widget" : source, project_id: projectId, origin: origin ?? null }),
    ],
  );

  // Real usage tracking: one lead_captured event per lead actually
  // ingested through this single shared path (internal + public widget
  // both land here) — see src/lib/usageEvents.ts / src/routes/usage.ts.
  await recordUsageEvent({
    client,
    tenantId,
    projectId,
    eventType: "lead_captured",
    metadata: { source },
  });

  return { id: row.id, createdAt: row.created_at };
}

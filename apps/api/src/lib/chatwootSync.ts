import type { PoolClient } from "pg";
import { getChatwootClientForTenant } from "./chatwootClient.js";
import { logger } from "./logger.js";
import type { LeadInput } from "./leadIngestion.js";

/**
 * Lead -> Chatwoot contact bridge.
 *
 * Standalone (NOT wired into leadIngestion.ts by this change — that file
 * is shared with other concurrent work, so it is left untouched; see this
 * feature's handback for the exact one-line call site to add there).
 *
 * syncLeadToChatwootContact() is intentionally a thin, best-effort side
 * effect: when no chatwoot integration is configured for this
 * tenant/project it no-ops with a log line (never throws, never blocks
 * lead ingestion on a missing/optional integration), and when it IS
 * configured it makes one real `createContact` call via
 * chatwootClient.ts. A failed Chatwoot call is logged and swallowed for
 * the same reason — syncing a contact to an external CRM-ish inbox tool is
 * a nice-to-have, not something that should ever fail lead capture itself.
 */
export async function syncLeadToChatwootContact(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  lead: LeadInput & { id?: string },
): Promise<void> {
  const client = await getChatwootClientForTenant(tenantDb, tenantId, projectId);
  if (!("createContact" in client)) {
    logger.info(
      { tenantId, projectId, leadId: lead.id },
      "chatwoot not configured for this tenant/project — skipping lead-to-contact sync",
    );
    return;
  }

  if (!lead.name && !lead.email) {
    logger.warn({ tenantId, projectId, leadId: lead.id }, "lead has neither name nor email — skipping chatwoot sync");
    return;
  }

  try {
    const contact = await client.createContact({
      name: lead.name,
      email: lead.email,
      customAttributes: {
        devlaunch_lead_id: lead.id ?? null,
        company: lead.company ?? null,
        source: "devlaunch",
      },
    });
    logger.info(
      { tenantId, projectId, leadId: lead.id, chatwootContactId: contact.id },
      "synced lead to chatwoot contact",
    );
  } catch (err) {
    // Best-effort side effect — never let a chatwoot failure surface as a
    // lead-ingestion failure (see module doc comment).
    logger.warn(
      { tenantId, projectId, leadId: lead.id, err: err instanceof Error ? err.message : String(err) },
      "failed to sync lead to chatwoot contact",
    );
  }
}

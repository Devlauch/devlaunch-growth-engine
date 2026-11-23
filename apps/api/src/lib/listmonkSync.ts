/**
 * listmonkSync: subscriber/campaign sync logic between platform's own
 * tenant-scoped data (leads, campaigns — RLS-protected, source of truth)
 * and a connected listmonk instance (packages/db/migrations/291's mapping
 * tables are the join between the two).
 *
 * Tenant-mapping decision (see docs/INTEGRATION_STATUS.md's Agent B row for
 * the full writeup): ONE SHARED listmonk instance, platform tags lists per
 * tenant/project. ensureProjectList() below is the one place that creates
 * the remote list tagged 'platform-project:<project_id>' and records the
 * mapping in listmonk_lists — nothing else in this module talks to
 * listmonk without going through a project's own mapped list first.
 */
import type { PoolClient } from "pg";
import type { ListmonkClient } from "./listmonkClient.js";
import { checkSendEligibility } from "../lib/suppression.js";

export interface SubscriberSyncResult {
  total: number;
  synced: number;
  skippedSuppressed: number;
  failed: number;
  errors: Array<{ leadId: string; error: string }>;
}

/**
 * Gets this project's mapped listmonk list, creating both the remote list
 * and the local mapping row on first use. Idempotent — a second call for
 * the same project returns the same mapping row without a second remote
 * create (UNIQUE (project_id) on listmonk_lists).
 */
export async function ensureProjectList(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  integrationId: string,
  client: ListmonkClient,
): Promise<{ listmonkListId: number }> {
  const existing = await tenantDb.query<{ listmonk_list_id: number }>(
    `SELECT listmonk_list_id FROM listmonk_lists WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { listmonkListId: existing.rows[0].listmonk_list_id };
  }

  const projectRow = await tenantDb.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1 AND tenant_id = $2`, [
    projectId,
    tenantId,
  ]);
  const projectName = projectRow.rows[0]?.name ?? projectId;
  const tenantTag = `platform-project:${projectId}`;
  const listName = `platform — ${projectName} (${projectId.slice(0, 8)})`;

  const remoteList = await client.getOrCreateList(listName, tenantTag);

  const inserted = await tenantDb.query<{ listmonk_list_id: number }>(
    `INSERT INTO listmonk_lists (tenant_id, project_id, integration_id, listmonk_list_id, listmonk_uuid, tenant_tag, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id) DO UPDATE SET listmonk_list_id = EXCLUDED.listmonk_list_id
     RETURNING listmonk_list_id`,
    [tenantId, projectId, integrationId, remoteList.id, remoteList.uuid, tenantTag, listName],
  );
  return { listmonkListId: inserted.rows[0].listmonk_list_id };
}

/**
 * Syncs every eligible lead with an email address into listmonk as a
 * subscriber on this project's mapped list. "Eligible" means
 * checkSendEligibility() (suppression.ts — the SAME gate future send code
 * must call) returns eligible for channel='email'; a suppressed/unsubscribed
 * lead is recorded as 'skipped_suppressed' in listmonk_subscribers and is
 * NEVER sent to listmonk, so a tenant's own suppression list is never
 * silently bypassed by this sync.
 */
export async function syncProjectSubscribers(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  integrationId: string,
  client: ListmonkClient,
): Promise<SubscriberSyncResult> {
  const { listmonkListId } = await ensureProjectList(tenantDb, tenantId, projectId, integrationId, client);

  const leadsResult = await tenantDb.query<{ id: string; name: string | null; email: string }>(
    `SELECT id, name, email FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND email IS NOT NULL
       AND status NOT IN ('rejected', 'archived')`,
    [tenantId, projectId],
  );

  const result: SubscriberSyncResult = { total: leadsResult.rowCount ?? 0, synced: 0, skippedSuppressed: 0, failed: 0, errors: [] };

  for (const lead of leadsResult.rows) {
    const eligibility = await checkSendEligibility(tenantDb, tenantId, { leadId: lead.id, email: lead.email, channel: "email" });

    if (!eligibility.eligible) {
      result.skippedSuppressed += 1;
      await tenantDb.query(
        `INSERT INTO listmonk_subscribers (tenant_id, project_id, integration_id, lead_id, email, sync_status, last_error, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, 'skipped_suppressed', $6, now())
         ON CONFLICT (project_id, email) DO UPDATE SET
           sync_status = 'skipped_suppressed', last_error = $6, last_synced_at = now(), lead_id = $4`,
        [tenantId, projectId, integrationId, lead.id, lead.email, eligibility.blockReasons.join(", ")],
      );
      continue;
    }

    try {
      const subscriber = await client.upsertSubscriber({
        email: lead.email,
        name: lead.name ?? lead.email,
        listIds: [listmonkListId],
      });
      await tenantDb.query(
        `INSERT INTO listmonk_subscribers (tenant_id, project_id, integration_id, lead_id, email, listmonk_subscriber_id, sync_status, last_error, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'synced', NULL, now())
         ON CONFLICT (project_id, email) DO UPDATE SET
           listmonk_subscriber_id = $6, sync_status = 'synced', last_error = NULL, last_synced_at = now(), lead_id = $4`,
        [tenantId, projectId, integrationId, lead.id, lead.email, subscriber.id],
      );
      result.synced += 1;
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ leadId: lead.id, error: message });
      await tenantDb.query(
        `INSERT INTO listmonk_subscribers (tenant_id, project_id, integration_id, lead_id, email, sync_status, last_error, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6, now())
         ON CONFLICT (project_id, email) DO UPDATE SET
           sync_status = 'failed', last_error = $6, last_synced_at = now(), lead_id = $4`,
        [tenantId, projectId, integrationId, lead.id, lead.email, message],
      );
    }
  }

  return result;
}

/**
 * Creates a listmonk draft campaign for a platform campaigns row AND
 * inserts a pending `approvals` row for it in the SAME transaction — a
 * listmonk campaign mapping is never created without a corresponding
 * approval gate already in place, per the "no real campaign sending
 * without approval" rule. This only drafts the campaign in listmonk
 * (status stays 'draft' remotely); triggerCampaignSend() below is the only
 * function allowed to flip it to 'running', and it refuses to do so
 * unless campaigns.status = 'approved'.
 */
export async function createDraftCampaign(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  integrationId: string,
  client: ListmonkClient,
  input: { campaignId: string; name: string; subject: string; body: string; requestedBy: string | null },
): Promise<{ listmonkCampaignId: number; approvalId: string }> {
  const { listmonkListId } = await ensureProjectList(tenantDb, tenantId, projectId, integrationId, client);

  const remoteCampaign = await client.createCampaign({
    name: input.name,
    subject: input.subject,
    listIds: [listmonkListId],
    body: input.body,
  });

  await tenantDb.query(
    `INSERT INTO listmonk_campaigns (tenant_id, project_id, integration_id, campaign_id, listmonk_campaign_id, listmonk_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (campaign_id) DO UPDATE SET listmonk_campaign_id = EXCLUDED.listmonk_campaign_id, listmonk_status = EXCLUDED.listmonk_status`,
    [tenantId, projectId, integrationId, input.campaignId, remoteCampaign.id, remoteCampaign.status],
  );

  const approval = await tenantDb.query<{ id: string }>(
    `INSERT INTO approvals (tenant_id, campaign_id, status, requested_by, reason)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id`,
    [tenantId, input.campaignId, input.requestedBy, `Listmonk campaign send approval for "${input.name}"`],
  );

  return { listmonkCampaignId: remoteCampaign.id, approvalId: approval.rows[0].id };
}

export class CampaignNotApprovedError extends Error {
  constructor(status: string) {
    super(`Campaign cannot be sent via listmonk: platform campaigns.status is '${status}', not 'approved'. ` +
      "Decide the pending approval via POST /tenants/:tenantId/approvals/:approvalId/decision first.");
    this.name = "CampaignNotApprovedError";
  }
}

/**
 * The ONLY function in this codebase allowed to call
 * client.updateCampaignStatus(..., 'running') — i.e. actually trigger a
 * real send. Re-checks campaigns.status = 'approved' itself rather than
 * trusting the caller, so there is exactly one enforcement point even if a
 * future caller forgets to check first.
 */
export async function triggerCampaignSend(
  tenantDb: PoolClient,
  tenantId: string,
  campaignId: string,
  client: ListmonkClient,
): Promise<{ listmonkStatus: string }> {
  const campaignRow = await tenantDb.query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );
  if (campaignRow.rowCount === 0) {
    throw new Error("Campaign not found");
  }
  if (campaignRow.rows[0].status !== "approved") {
    throw new CampaignNotApprovedError(campaignRow.rows[0].status);
  }

  const mappingRow = await tenantDb.query<{ listmonk_campaign_id: number }>(
    `SELECT listmonk_campaign_id FROM listmonk_campaigns WHERE tenant_id = $1 AND campaign_id = $2`,
    [tenantId, campaignId],
  );
  if (mappingRow.rowCount === 0) {
    throw new Error("No listmonk campaign mapping found for this campaign — call createDraftCampaign first");
  }

  const remote = await client.updateCampaignStatus(mappingRow.rows[0].listmonk_campaign_id, "running");

  await tenantDb.query(
    `UPDATE listmonk_campaigns SET listmonk_status = $3, sent_at = now() WHERE tenant_id = $1 AND campaign_id = $2`,
    [tenantId, campaignId, remote.status],
  );

  return { listmonkStatus: remote.status };
}

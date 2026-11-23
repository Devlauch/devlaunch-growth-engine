/**
 * socialContentCalendar: Workstream H — a social content CALENDAR + approval
 * workflow layered on top of the EXISTING, real Postiz integration. This
 * module never talks to Postiz directly and never builds a second approval
 * mechanism; it orchestrates two already-real things:
 *
 *   1. The `approvals` table + its EXISTING human decision route
 *      (apps/api/src/routes/approvals.ts's
 *      POST /api/v1/tenants/:tenantId/approvals/:approvalId/decision) — the
 *      one and only approval engine in this codebase. There is no
 *      exported "requestApproval()"/"decideApproval()" library function to
 *      import (routes/approvals.ts has no lib/ counterpart — its logic
 *      lives inline in the route handler), so this module reuses the
 *      approval engine the exact same way apps/api/src/routes/
 *      postizIntegration.ts's own request-approval/publish handlers already
 *      do: INSERT a real row into `approvals` (status defaults to
 *      'pending'), and before ever publishing, re-read that row and refuse
 *      unless its status is 'approved'. This file NEVER flips an approval
 *      to 'approved' itself — only the existing decision route does that.
 *   2. apps/api/src/lib/channelProviders.ts's getSocialPostProvider() / the
 *      existing `postiz_social_posts` table
 *      (apps/api/src/routes/postizIntegration.ts) — the one real Postiz
 *      publish path. A `social_content_calendar` row that reaches
 *      'approved' gets a real `postiz_social_posts` row created for it (so
 *      it is visible in, and sync-able from, the existing Postiz UI/route
 *      too) and is published through that exact same provider call — never
 *      a second, parallel Postiz HTTP client call.
 *
 * Hard rule enforced here, not just documented: approveAndPublish() reads
 * the approvals row inside the same function that calls the Postiz
 * provider and THROWS before ever constructing a SocialPost if that row is
 * missing or not 'approved' — there is no code path in this file that can
 * reach a provider.publish() call for unapproved content.
 */

import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";

export interface ScheduleContentInput {
  platform: string;
  contentDraft: string;
  mediaRefs?: unknown[];
  scheduledAt?: string | null;
  campaignId?: string | null;
}

export interface SocialContentCalendarRow {
  id: string;
  tenant_id: string;
  project_id: string;
  campaign_id: string | null;
  platform: string;
  content_draft: string;
  media_refs: unknown[];
  scheduled_at: string | null;
  approval_status: "pending" | "approved" | "rejected";
  postiz_post_id: string | null;
  published_status: "not_published" | "scheduled" | "published" | "failed";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const CALENDAR_COLUMNS = `id, tenant_id, project_id, campaign_id, platform, content_draft, media_refs,
  scheduled_at, approval_status, postiz_post_id, published_status, created_by, created_at, updated_at`;

/**
 * Creates a new social_content_calendar row with approval_status = 'pending'
 * (the table's own DEFAULT, set explicitly here too so this is never
 * accidentally created pre-approved by a future schema change). Does NOT
 * create an `approvals` row yet — that happens explicitly via
 * requestCalendarApproval(), mirroring postiz_social_posts' own
 * draft -> request-approval -> publish separation (a calendar item can sit
 * as a draft indefinitely before anyone asks for sign-off).
 */
export async function scheduleContent(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  input: ScheduleContentInput,
  createdBy: string | null,
): Promise<SocialContentCalendarRow> {
  if (input.campaignId) {
    const campaign = await tenantDb.query(`SELECT 1 FROM campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
      input.campaignId,
      tenantId,
      projectId,
    ]);
    if (campaign.rowCount === 0) {
      throw Errors.badRequest(`Campaign ${input.campaignId} not found in this tenant/project`);
    }
  }

  const result = await tenantDb.query<SocialContentCalendarRow>(
    `INSERT INTO social_content_calendar
       (tenant_id, project_id, campaign_id, platform, content_draft, media_refs, scheduled_at, approval_status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', $8)
     RETURNING ${CALENDAR_COLUMNS}`,
    [
      tenantId,
      projectId,
      input.campaignId ?? null,
      input.platform,
      input.contentDraft,
      JSON.stringify(input.mediaRefs ?? []),
      input.scheduledAt ?? null,
      createdBy,
    ],
  );
  return result.rows[0];
}

/**
 * Submits a calendar item for a real human decision: inserts an `approvals`
 * row (status defaults to 'pending' there too) and links it via
 * approvals.social_content_calendar_id — same bidirectional-linkage
 * convention as approvals.social_post_id
 * (319_add_social_post_id_to_approvals.sql). Reuses the SAME `approvals`
 * table postiz_social_posts does; this is intentionally not stored as a
 * column on social_content_calendar itself so a lookup by approval id works
 * identically for both calendar items and Postiz posts.
 */
export async function requestCalendarApproval(
  tenantDb: PoolClient,
  tenantId: string,
  calendarItemId: string,
  requestedBy: string | null,
): Promise<{ approvalId: string }> {
  const item = await tenantDb.query<{ id: string; approval_status: string }>(
    `SELECT id, approval_status FROM social_content_calendar WHERE id = $1 AND tenant_id = $2`,
    [calendarItemId, tenantId],
  );
  if (item.rowCount === 0) throw Errors.notFound("Calendar item not found");
  if (item.rows[0].approval_status !== "pending") {
    throw Errors.conflict(
      `Only a 'pending' calendar item can be submitted for approval (current: ${item.rows[0].approval_status})`,
    );
  }

  const approval = await tenantDb.query<{ id: string }>(
    `INSERT INTO approvals (tenant_id, social_content_calendar_id, requested_by, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [tenantId, calendarItemId, requestedBy, `Social content calendar item ${calendarItemId} submitted for approval`],
  );

  return { approvalId: approval.rows[0].id };
}

/**
 * approveAndPublish(): THE non-negotiable gate. Re-reads the real
 * `approvals` row linked to this calendar item and refuses — before any
 * Postiz call is even constructed — unless a human has already decided it
 * 'approved' via the EXISTING POST .../approvals/:approvalId/decision
 * route. There is no parameter or flag on this function that can skip that
 * check.
 *
 * Once approved: creates a real `postiz_social_posts` row (so this content
 * is visible/syncable from the existing Postiz integration UI too — never
 * a shadow, invisible publish) and publishes it through the EXISTING
 * getSocialPostProvider() factory (apps/api/src/lib/channelProviders.ts),
 * the exact same call apps/api/src/routes/postizIntegration.ts's own
 * /posts/:postId/publish route makes. A NotConfiguredError (Postiz not
 * connected) or a real Postiz API failure is surfaced honestly — published
 * status only ever reaches 'published'/'scheduled' after Postiz's own 2xx
 * response, postiz_post_id is copied verbatim, never guessed.
 */
export async function approveAndPublish(
  tenantDb: PoolClient,
  tenantId: string,
  calendarItemId: string,
  actorUserId: string | null,
): Promise<SocialContentCalendarRow> {
  const result = await tenantDb.query<{
    id: string;
    tenant_id: string;
    project_id: string;
    platform: string;
    content_draft: string;
    scheduled_at: string | null;
    published_status: string;
    approval_status: string;
  }>(
    `SELECT scc.id, scc.tenant_id, scc.project_id, scc.platform, scc.content_draft, scc.scheduled_at,
            scc.published_status, a.status AS approval_status
     FROM social_content_calendar scc
     LEFT JOIN approvals a ON a.social_content_calendar_id = scc.id AND a.tenant_id = scc.tenant_id
     WHERE scc.id = $1 AND scc.tenant_id = $2
     ORDER BY a.requested_at DESC NULLS LAST
     LIMIT 1`,
    [calendarItemId, tenantId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Calendar item not found");
  const item = result.rows[0];

  if (item.published_status === "published" || item.published_status === "scheduled") {
    const current = await tenantDb.query<SocialContentCalendarRow>(
      `SELECT ${CALENDAR_COLUMNS} FROM social_content_calendar WHERE id = $1 AND tenant_id = $2`,
      [calendarItemId, tenantId],
    );
    return current.rows[0];
  }

  // THE GATE — mirrors postizIntegration.ts's publish route exactly: no
  // approval row at all, or a status other than 'approved', is refused.
  if (item.approval_status !== "approved") {
    throw Errors.forbidden(
      `This calendar item has not passed a real human approval (current approval status: ${
        item.approval_status ?? "none requested"
      }). Request approval via requestCalendarApproval(), then have it approved via the existing ` +
        `POST .../approvals/:approvalId/decision route, before publishing.`,
    );
  }

  await tenantDb.query(`UPDATE social_content_calendar SET approval_status = 'approved' WHERE id = $1 AND tenant_id = $2`, [
    calendarItemId,
    tenantId,
  ]);

  // Mirror the real postiz_social_posts lifecycle: find this project's
  // connected postiz integration so the new row is correctly linked, same
  // as postizIntegration.ts's own POST /posts handler.
  const integration = await tenantDb.query<{ id: string }>(
    `SELECT id FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'postiz' AND status = 'connected'`,
    [tenantId, item.project_id],
  );
  if (integration.rowCount === 0) {
    throw Errors.conflict("Postiz is not connected for this project — connect it first (never publishes without it).");
  }

  const socialPost = await tenantDb.query<{ id: string }>(
    `INSERT INTO postiz_social_posts (tenant_id, project_id, integration_id, content, platforms, scheduled_at, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7)
     RETURNING id`,
    [
      tenantId,
      item.project_id,
      integration.rows[0].id,
      item.content_draft,
      [item.platform],
      item.scheduled_at,
      actorUserId,
    ],
  );
  const socialPostId = socialPost.rows[0].id;

  // The one real Postiz call site — same factory, same provider, same
  // contract as postizIntegration.ts's own publish route. A
  // NotConfiguredError/API failure propagates honestly; nothing here
  // fabricates a published result.
  const { getSocialPostProvider } = await import("./channelProviders.js");
  const provider = await getSocialPostProvider(tenantDb, tenantId, item.project_id);

  try {
    const published = await provider.publish({
      content: item.content_draft,
      platforms: [item.platform],
      scheduledAt: item.scheduled_at,
    });

    await tenantDb.query(
      `UPDATE postiz_social_posts
       SET status = $3, postiz_post_id = $4, published_at = $5, last_synced_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [socialPostId, tenantId, item.scheduled_at ? "scheduled" : "published", published.postId, published.publishedAt],
    );

    const updated = await tenantDb.query<SocialContentCalendarRow>(
      `UPDATE social_content_calendar
       SET postiz_post_id = $3, published_status = $4
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${CALENDAR_COLUMNS}`,
      [calendarItemId, tenantId, published.postId, item.scheduled_at ? "scheduled" : "published"],
    );

    await tenantDb.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'social_content_calendar.published', 'social_content_calendar', $3, $4::jsonb)`,
      [tenantId, actorUserId, calendarItemId, JSON.stringify({ postizPostId: published.postId, socialPostId })],
    );

    return updated.rows[0];
  } catch (err) {
    await tenantDb.query(`UPDATE postiz_social_posts SET status = 'failed', last_error = $3 WHERE id = $1 AND tenant_id = $2`, [
      socialPostId,
      tenantId,
      err instanceof Error ? err.message : String(err),
    ]);
    await tenantDb.query(`UPDATE social_content_calendar SET published_status = 'failed' WHERE id = $1 AND tenant_id = $2`, [
      calendarItemId,
      tenantId,
    ]);
    throw err;
  }
}

export interface CalendarDateRange {
  from?: string;
  to?: string;
}

/** Lists calendar items for a project, optionally bounded by a scheduled_at date range, newest-scheduled-first. */
export async function getCalendarForProject(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  dateRange: CalendarDateRange = {},
): Promise<SocialContentCalendarRow[]> {
  const result = await tenantDb.query<SocialContentCalendarRow>(
    `SELECT ${CALENDAR_COLUMNS}
     FROM social_content_calendar
     WHERE tenant_id = $1 AND project_id = $2
       AND ($3::timestamptz IS NULL OR scheduled_at >= $3)
       AND ($4::timestamptz IS NULL OR scheduled_at <= $4)
     ORDER BY scheduled_at ASC NULLS LAST, created_at DESC
     LIMIT 500`,
    [tenantId, projectId, dateRange.from ?? null, dateRange.to ?? null],
  );
  return result.rows;
}

import type { PoolClient } from "pg";

/**
 * contentAttribution: "which content drove this lead."
 *
 * Confirmed by a prior audit (before this task was created): there is zero
 * linkage between a content_calendar_item/content_draft
 * (071/072/073_create_content_*.sql) and any lead/landing_page_events row.
 *
 * The real, already-existing pieces this module builds on:
 *   - apps/api/src/routes/publicLandingPages.ts's form-submit handler calls
 *     the shared ingestLead() (apps/api/src/lib/leadIngestion.ts), which
 *     stamps `custom_fields.landingPageId` = the landing page's own id onto
 *     every lead captured through a landing page. That is a REAL, existing
 *     identifier — not invented for this feature.
 *   - What was genuinely missing was content item -> landing page. This
 *     module relies on the new, additive, nullable
 *     landing_pages.content_calendar_item_id / content_draft_id columns
 *     (420_add_content_origin_to_landing_pages.sql) for that link. Those
 *     columns are NULL for every existing landing page and for any new one
 *     a user doesn't explicitly tag at creation time — so most content
 *     items will legitimately show zero attributed leads today, which this
 *     module reports honestly rather than fabricating a number.
 *
 * This is Option A ("if a content item can be correlated... by a real
 * shared identifier"), not the not_yet_tracked stub fallback, because that
 * real correlation genuinely exists once a landing page is tagged. For
 * content items that have never been tagged to any landing page, the
 * individual row's leadCount is a real, correct 0 (no landing page == no
 * leads attributable to it), not an estimate.
 *
 * Follows the exact SQL-view-style, join-everything-in-one-query pattern
 * used by campaign_attribution (276_create_campaign_attribution.sql) /
 * campaignAttribution.ts: no application-layer aggregation beyond
 * numeric-string coercion of COUNT(...) results.
 */

export interface ContentAttributionRow {
  content_kind: "calendar_item" | "draft";
  content_id: string;
  title: string;
  /** content_calendar_items.content_type ('linkedin_post'|'blog'|'email') or content_drafts.format ('blog'|'linkedin_post'|'email'|'twitter_thread'|'summary'). */
  format: string;
  landing_page_id: string | null;
  landing_page_slug: string | null;
  landing_page_status: string | null;
  lead_count: number;
  qualified_lead_count: number;
  form_submit_event_count: number;
}

function toNumericRow(row: Record<string, unknown>): ContentAttributionRow {
  return {
    ...row,
    lead_count: Number(row.lead_count ?? 0),
    qualified_lead_count: Number(row.qualified_lead_count ?? 0),
    form_submit_event_count: Number(row.form_submit_event_count ?? 0),
  } as ContentAttributionRow;
}

/**
 * Real content-to-lead attribution for every content_calendar_item in this
 * tenant/project's content_calendars, LEFT JOINed to the (at most one, by
 * the single-content-origin CHECK constraint) landing page tagged as built
 * from it, LEFT JOINed to leads via the existing
 * custom_fields->>'landingPageId' identifier.
 */
export async function listCalendarItemAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ContentAttributionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await tenantDb.query(
    `SELECT
       'calendar_item'                                                      AS content_kind,
       ci.id                                                                 AS content_id,
       ci.title                                                             AS title,
       ci.content_type                                                      AS format,
       lp.id                                                                AS landing_page_id,
       lp.slug                                                              AS landing_page_slug,
       lp.status                                                            AS landing_page_status,
       COUNT(DISTINCT l.id)                                                 AS lead_count,
       COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'qualified')           AS qualified_lead_count,
       COUNT(DISTINCT lpe.id) FILTER (WHERE lpe.event_type = 'form_submit') AS form_submit_event_count
     FROM content_calendar_items ci
     JOIN content_calendars cc
       ON cc.id = ci.calendar_id AND cc.tenant_id = ci.tenant_id
     LEFT JOIN landing_pages lp
       ON lp.content_calendar_item_id = ci.id AND lp.tenant_id = ci.tenant_id
     LEFT JOIN leads l
       ON l.tenant_id = lp.tenant_id
      AND l.project_id = lp.project_id
      AND l.custom_fields ->> 'landingPageId' = lp.id::text
     LEFT JOIN landing_page_events lpe
       ON lpe.landing_page_id = lp.id AND lpe.tenant_id = lp.tenant_id
     WHERE ci.tenant_id = $1 AND cc.project_id = $2
     GROUP BY ci.id, ci.title, ci.content_type, lp.id, lp.slug, lp.status
     ORDER BY ci.title ASC
     LIMIT $3 OFFSET $4`,
    [tenantId, projectId, limit, offset],
  );
  return result.rows.map(toNumericRow);
}

/** Same shape, for standalone content_drafts (071/072/073's sibling table — repurposed blog/LinkedIn/email/thread/summary pieces, independent of any content_calendars row). */
export async function listDraftAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ContentAttributionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await tenantDb.query(
    `SELECT
       'draft'                                                              AS content_kind,
       cd.id                                                                AS content_id,
       cd.title                                                             AS title,
       cd.format                                                            AS format,
       lp.id                                                                AS landing_page_id,
       lp.slug                                                              AS landing_page_slug,
       lp.status                                                            AS landing_page_status,
       COUNT(DISTINCT l.id)                                                 AS lead_count,
       COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'qualified')           AS qualified_lead_count,
       COUNT(DISTINCT lpe.id) FILTER (WHERE lpe.event_type = 'form_submit') AS form_submit_event_count
     FROM content_drafts cd
     LEFT JOIN landing_pages lp
       ON lp.content_draft_id = cd.id AND lp.tenant_id = cd.tenant_id
     LEFT JOIN leads l
       ON l.tenant_id = lp.tenant_id
      AND l.project_id = lp.project_id
      AND l.custom_fields ->> 'landingPageId' = lp.id::text
     LEFT JOIN landing_page_events lpe
       ON lpe.landing_page_id = lp.id AND lpe.tenant_id = lp.tenant_id
     WHERE cd.tenant_id = $1 AND cd.project_id = $2
     GROUP BY cd.id, cd.title, cd.format, lp.id, lp.slug, lp.status
     ORDER BY cd.title ASC
     LIMIT $3 OFFSET $4`,
    [tenantId, projectId, limit, offset],
  );
  return result.rows.map(toNumericRow);
}

export interface ContentAttributionSummary {
  rows: ContentAttributionRow[];
  /** How many of the rows above have no landing page tagged yet (content_calendar_item_id/content_draft_id is NULL on every landing_pages row) — these legitimately show lead_count 0, not because no leads came from that content but because no landing page has ever been explicitly tagged as built from it. */
  untaggedContentCount: number;
  note: string;
}

/** Combined calendar-item + draft attribution for a tenant/project, with an honest count of content that has no landing page tagged yet (see landing_pages.content_calendar_item_id / content_draft_id, 420_add_content_origin_to_landing_pages.sql). */
export async function getContentAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ContentAttributionSummary> {
  const [calendarRows, draftRows] = await Promise.all([
    listCalendarItemAttribution(tenantDb, tenantId, projectId, options),
    listDraftAttribution(tenantDb, tenantId, projectId, options),
  ]);
  const rows = [...calendarRows, ...draftRows];
  const untaggedContentCount = rows.filter((r) => r.landing_page_id === null).length;

  return {
    rows,
    untaggedContentCount,
    note:
      "lead_count/qualified_lead_count/form_submit_event_count are real counts from leads.custom_fields->>'landingPageId' and landing_page_events, joined through landing_pages.content_calendar_item_id/content_draft_id (420_add_content_origin_to_landing_pages.sql). A content item with landing_page_id = null has never been tagged as the origin of any landing page — its 0 counts reflect missing tagging, not a measured lack of leads. Tag a landing page to a content item at creation time to start tracking it.",
  };
}

import { describe, it, expect, vi, beforeEach } from "vitest";

// Lib-level unit tests, same mocked-pg-client style as campaignAttribution.test.ts /
// leadActivity.test.ts: a fake tenantDb whose .query is a vi.fn() queue,
// no real Postgres/RLS involved.
const queryMock = vi.fn();

vi.mock("../src/lib/channelProviders.js", () => ({
  getSocialPostProvider: vi.fn(),
}));

const { scheduleContent, requestCalendarApproval, approveAndPublish, getCalendarForProject } = await import(
  "../src/lib/socialContentCalendar.js"
);
const channelProviders = await import("../src/lib/channelProviders.js");

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const ITEM_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";

function fakeTenantDb() {
  return { query: queryMock };
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

beforeEach(() => {
  queryMock.mockReset();
  vi.mocked(channelProviders.getSocialPostProvider).mockReset();
});

describe("scheduleContent", () => {
  it("always creates a row with approval_status = 'pending', never pre-approved", async () => {
    queueResponses([
      { rowCount: 1, rows: [{ id: ITEM_1, approval_status: "pending" }] },
    ]);

    await scheduleContent(
      fakeTenantDb() as never,
      TENANT_1,
      PROJECT_1,
      { platform: "linkedin-int-1", contentDraft: "Hello world" },
      USER_1,
    );

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("INSERT INTO social_content_calendar");
    expect(sql).toContain("'pending'");
    expect(params).toEqual([TENANT_1, PROJECT_1, null, "linkedin-int-1", "Hello world", "[]", null, USER_1]);
  });

  it("validates a given campaignId belongs to this tenant/project before creating the row", async () => {
    queueResponses([{ rowCount: 0, rows: [] }]); // campaign lookup: not found

    await expect(
      scheduleContent(
        fakeTenantDb() as never,
        TENANT_1,
        PROJECT_1,
        { platform: "x", contentDraft: "hi", campaignId: "77777777-7777-7777-7777-777777777777" },
        USER_1,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("requestCalendarApproval", () => {
  it("inserts a real pending approvals row linked via social_content_calendar_id — never auto-approves", async () => {
    queueResponses([
      { rowCount: 1, rows: [{ id: ITEM_1, approval_status: "pending" }] },
      { rows: [{ id: "approval-1" }] },
    ]);

    const result = await requestCalendarApproval(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1);
    expect(result).toEqual({ approvalId: "approval-1" });

    const insertCall = queryMock.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO approvals");
    expect(insertCall[0]).toContain("social_content_calendar_id");
    expect(insertCall[0]).not.toContain("'approved'");
    expect(insertCall[1]).toEqual([TENANT_1, ITEM_1, USER_1, `Social content calendar item ${ITEM_1} submitted for approval`]);
  });

  it("refuses to re-submit an item that isn't 'pending'", async () => {
    queueResponses([{ rowCount: 1, rows: [{ id: ITEM_1, approval_status: "approved" }] }]);

    await expect(requestCalendarApproval(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("approveAndPublish — the non-negotiable approval gate", () => {
  it("refuses to publish when there is no approval row at all", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi",
            scheduled_at: null,
            published_status: "not_published",
            approval_status: null,
          },
        ],
      },
    ]);

    await expect(approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1)).rejects.toMatchObject({ status: 403 });
    expect(channelProviders.getSocialPostProvider).not.toHaveBeenCalled();
  });

  it("refuses to publish when the linked approval is still 'pending'", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi",
            scheduled_at: null,
            published_status: "not_published",
            approval_status: "pending",
          },
        ],
      },
    ]);

    await expect(approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1)).rejects.toMatchObject({ status: 403 });
    expect(channelProviders.getSocialPostProvider).not.toHaveBeenCalled();
  });

  it("refuses to publish when the linked approval was 'rejected'", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi",
            scheduled_at: null,
            published_status: "not_published",
            approval_status: "rejected",
          },
        ],
      },
    ]);

    await expect(approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1)).rejects.toMatchObject({ status: 403 });
    expect(channelProviders.getSocialPostProvider).not.toHaveBeenCalled();
  });

  it("publishes for real (via the existing getSocialPostProvider/Postiz path) once — and only once — the real approval is 'approved'", async () => {
    const publishMock = vi.fn().mockResolvedValue({
      provider: "postiz",
      postId: "postiz-post-1",
      publishedAt: "2025-01-01T00:00:00.000Z",
      platforms: ["x"],
    });
    vi.mocked(channelProviders.getSocialPostProvider).mockResolvedValue({ name: "postiz", publish: publishMock });

    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi there",
            scheduled_at: null,
            published_status: "not_published",
            approval_status: "approved",
          },
        ],
      },
      { rows: [] }, // UPDATE approval_status='approved'
      { rowCount: 1, rows: [{ id: "integration-1" }] }, // integrations lookup
      { rows: [{ id: "social-post-1" }] }, // INSERT postiz_social_posts
      { rows: [] }, // UPDATE postiz_social_posts with published result
      { rowCount: 1, rows: [{ id: ITEM_1, postiz_post_id: "postiz-post-1", published_status: "published" }] }, // UPDATE calendar item
      { rows: [] }, // audit event
    ]);

    const result = await approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({ content: "hi there", platforms: ["x"], scheduledAt: null });
    expect(result.postiz_post_id).toBe("postiz-post-1");
  });

  it("refuses to publish when Postiz is not connected for this project, even though the approval is real", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi",
            scheduled_at: null,
            published_status: "not_published",
            approval_status: "approved",
          },
        ],
      },
      { rows: [] }, // UPDATE approval_status='approved'
      { rowCount: 0, rows: [] }, // integrations lookup: not connected
    ]);

    await expect(approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1)).rejects.toMatchObject({ status: 409 });
    expect(channelProviders.getSocialPostProvider).not.toHaveBeenCalled();
  });

  it("is idempotent: calling it again on an already-published item never calls the publish provider again", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            id: ITEM_1,
            tenant_id: TENANT_1,
            project_id: PROJECT_1,
            platform: "x",
            content_draft: "hi",
            scheduled_at: null,
            published_status: "published",
            approval_status: "approved",
          },
        ],
      },
      { rowCount: 1, rows: [{ id: ITEM_1, published_status: "published" }] }, // re-select current row
    ]);

    const result = await approveAndPublish(fakeTenantDb() as never, TENANT_1, ITEM_1, USER_1);
    expect(result.published_status).toBe("published");
    expect(channelProviders.getSocialPostProvider).not.toHaveBeenCalled();
  });
});

describe("getCalendarForProject", () => {
  it("lists items for the project scoped to tenant/project", async () => {
    queueResponses([{ rowCount: 1, rows: [{ id: ITEM_1 }] }]);

    const rows = await getCalendarForProject(fakeTenantDb() as never, TENANT_1, PROJECT_1, {});
    expect(rows).toHaveLength(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("FROM social_content_calendar");
    expect(params).toEqual([TENANT_1, PROJECT_1, null, null]);
  });
});
